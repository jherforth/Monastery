//! One chat turn, run on the server (simplification Phase 3).
//!
//! `POST /api/projects/:id/chat` builds the system prompt from the files on disk, streams the
//! model's reply, applies each `<file>`/`<edit>` as soon as its tag closes (after a single
//! safety snapshot per turn), continues past the output-token limit, serves `<read>` requests,
//! and retries a failed edit once against fresh contents. The browser only renders the events:
//!
//! | event        | data                                             |
//! |--------------|--------------------------------------------------|
//! | `text`       | `{text}` — reply text (incl. tags) to append      |
//! | `reasoning`  | `{text}` — model reasoning to append              |
//! | `snapshot`   | `{id}` — checkpoint taken before the first change |
//! | `file`       | `{path, kind: write\|edit, before, after}`        |
//! | `edit_failed`| `{path, message}`                                 |
//! | `read`       | `{paths}` — files added to the working set        |
//! | `segment`    | `{}` — a new assistant message starts             |
//! | `status`     | `{text}` — progress line (continuing, reading…)   |
//! | `notice`     | `{text}` — something the user should know         |
//! | `truncated`  | `{}` — still cut off after the continuation cap   |
//! | `usage`      | `{prompt_tokens, completion_tokens, total_tokens}`|
//! | `error`      | `{message}`                                       |
//! | `done`       | `{}`                                              |

mod parser;
mod prompt;

use std::collections::BTreeSet;
use std::convert::Infallible;
use std::path::PathBuf;

use async_openai::types::{
    ChatCompletionRequestAssistantMessage, ChatCompletionRequestAssistantMessageContent, ChatCompletionRequestMessage,
    ChatCompletionRequestSystemMessage, ChatCompletionRequestSystemMessageContent, ChatCompletionRequestUserMessage,
    ChatCompletionRequestUserMessageContent,
};
use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::{Stream, StreamExt};
use harness_core::{ChunkType, CreateSnapshotRequest, LLMClient, SnapshotTrigger};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::handlers::{
    apply_hunks, is_partial_overwrite, read_files_for_snapshot, resolve_endpoint, resolve_project_dir, safe_project_path,
    ApiError,
};
use crate::AppState;
use parser::{stitch_continuation, Action, ActionParser, STITCH_LOOKAHEAD};
use prompt::{load_project, looks_like_untagged_code, sanitize_assistant_history, system_prompt, ProjectView, PromptInput, CONTINUE_PROMPT};

/// Automatic continuations per assistant message when the model hits its output-token limit.
/// Capped on purpose — unbounded continuation once burned real API credit.
const MAX_CONTINUATIONS: usize = 2;
/// Rounds of `<read>` requests served in one turn.
const MAX_READ_ROUNDS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Build,
    Discuss,
}

#[derive(Debug, Deserialize)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct OpenFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatTurnRequest {
    pub mode: Mode,
    pub model: String,
    #[serde(default)]
    pub endpoint_id: Option<Uuid>,
    /// The conversation so far, oldest first.
    #[serde(default)]
    pub history: Vec<HistoryMessage>,
    /// The new user message. Absent when `continue_last` is set.
    #[serde(default)]
    pub message: Option<String>,
    /// Continue the last history message (an assistant reply cut off at the output-token
    /// limit) instead of sending a new message — the manual "Continue generating" button.
    #[serde(default)]
    pub continue_last: bool,
    /// Instruction blocks for the active skills (the UI owns the skill registry).
    #[serde(default)]
    pub instructions: Vec<String>,
    /// The editor's live buffer for the open file, which may hold unsaved edits.
    #[serde(default)]
    pub open_file: Option<OpenFile>,
    /// Files the model `<read>` earlier in the session (kept in context for large projects).
    #[serde(default)]
    pub working_set: Vec<String>,
}

pub async fn project_chat(
    Path(project_id): Path<Uuid>,
    State(state): State<AppState>,
    Json(req): Json<ChatTurnRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let dir = resolve_project_dir(&state, project_id).await?;
    if !req.continue_last && req.message.as_deref().is_none_or(|m| m.trim().is_empty()) {
        return Err(ApiError::Config("Empty message".into()));
    }
    if req.model.trim().is_empty() {
        return Err(ApiError::Config("No model selected".into()));
    }
    let client = LLMClient::new(resolve_endpoint(&state, req.endpoint_id).await?);
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let turn = Turn {
        state,
        project_id,
        dir,
        name,
        mode: req.mode,
        model: req.model.clone(),
        instructions: req.instructions.clone(),
        open_file: req.open_file.as_ref().map(|f| (f.path.clone(), f.content.clone())),
        working_set: req.working_set.iter().cloned().collect(),
        snapshot_taken: false,
        changed_in_segment: false,
        discuss_notice_sent: false,
    };
    Ok(Sse::new(run_turn(turn, client, req)).keep_alive(
        KeepAlive::new().interval(std::time::Duration::from_secs(15)).text("keep-alive"),
    ))
}

type Ev = Result<Event, Infallible>;

fn ev(name: &str, data: serde_json::Value) -> Ev {
    // Logged so the edit success rate (a simplification-plan success measure) can be tracked.
    match name {
        "file" => tracing::info!(target: "monastery::chat", "applied {} to {}", data["kind"], data["path"]),
        "edit_failed" => tracing::warn!(target: "monastery::chat", "edit failed for {}: {}", data["path"], data["message"]),
        _ => {}
    }
    // JSON payloads: no raw newlines or CRs in the data field (axum's encoder panics on `\r`).
    Ok(Event::default().event(name).data(data.to_string()))
}

fn to_openai(role: &str, content: String) -> ChatCompletionRequestMessage {
    match role {
        "assistant" => ChatCompletionRequestAssistantMessage {
            content: Some(ChatCompletionRequestAssistantMessageContent::Text(content)),
            ..Default::default()
        }
        .into(),
        "system" => ChatCompletionRequestSystemMessage {
            content: ChatCompletionRequestSystemMessageContent::Text(content),
            name: None,
        }
        .into(),
        _ => ChatCompletionRequestUserMessage { content: ChatCompletionRequestUserMessageContent::Text(content), name: None }.into(),
    }
}

#[derive(Default)]
struct Usage {
    prompt: u64,
    completion: u64,
    total: u64,
}

impl Usage {
    fn add(&mut self, raw: &str) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            self.prompt += v["prompt_tokens"].as_u64().unwrap_or(0);
            self.completion += v["completion_tokens"].as_u64().unwrap_or(0);
            self.total += v["total_tokens"].as_u64().unwrap_or(0);
        }
    }
}

/// Per-turn state shared by the streaming loop and the action handlers.
struct Turn {
    state: AppState,
    project_id: Uuid,
    dir: PathBuf,
    name: String,
    mode: Mode,
    model: String,
    instructions: Vec<String>,
    open_file: Option<(String, String)>,
    working_set: BTreeSet<String>,
    snapshot_taken: bool,
    /// Whether any file changed during the current assistant message.
    changed_in_segment: bool,
    discuss_notice_sent: bool,
}

/// Outcome of handling one action.
enum Applied {
    Events(Vec<Ev>),
    Read(String),
    /// An edit with hunks that matched nowhere: (path, unmatched hunks), plus events so far.
    EditMiss(String, Vec<(String, String)>, Vec<Ev>),
}

impl Turn {
    async fn view(&self) -> ProjectView {
        let dir = self.dir.clone();
        tokio::task::spawn_blocking(move || load_project(&dir))
            .await
            .unwrap_or(ProjectView { files: Default::default(), tree: Vec::new() })
    }

    async fn system_prompt(&self) -> String {
        let view = self.view().await;
        system_prompt(&PromptInput {
            project_name: &self.name,
            mode: self.mode,
            view: &view,
            open_file: self.open_file.as_ref().map(|(p, c)| (p.as_str(), c.as_str())),
            working_set: &self.working_set,
            instructions: &self.instructions,
        })
    }

    /// One snapshot of the on-disk project before the turn's first change, so everything the
    /// turn does can be abandoned in one click. A brand-new (empty) project needs none.
    async fn checkpoint(&mut self) -> Option<Ev> {
        if self.snapshot_taken {
            return None;
        }
        self.snapshot_taken = true;
        let dir = self.dir.clone();
        let files = tokio::task::spawn_blocking(move || {
            let mut files = Vec::new();
            read_files_for_snapshot(&dir, &dir, &mut files);
            files
        })
        .await
        .unwrap_or_default();
        if files.is_empty() {
            return None;
        }
        let request = CreateSnapshotRequest {
            project_id: self.project_id,
            name: Some("Auto: before AI edit".to_string()),
            description: Some("Safety checkpoint taken automatically before applying AI changes".into()),
            created_by: Some("Monastery".into()),
            trigger: SnapshotTrigger::BeforeChange,
            files,
            parent_snapshot_id: None,
        };
        match self.state.snapshot_service.create_snapshot(request).await {
            Ok(r) => Some(ev("snapshot", json!({ "id": r.snapshot.id.to_string() }))),
            Err(e) => Some(ev("notice", json!({ "text": format!("⚠️ Couldn't take a safety snapshot before these changes: {}", e) }))),
        }
    }

    /// Write a whole file (after the checkpoint), reporting a diffable before/after.
    async fn write_file(&mut self, path: &str, content: &str, guard: bool) -> Vec<Ev> {
        let full = match safe_project_path(&self.dir, path) {
            Ok(p) => p,
            Err(_) => return vec![ev("edit_failed", json!({ "path": path, "message": format!("`{}` is outside the project, so it wasn't written.", path) }))],
        };
        let before = tokio::fs::read_to_string(&full).await.ok();
        if guard && before.as_deref().is_some_and(|old| is_partial_overwrite(old, content)) {
            return vec![ev("edit_failed", json!({ "path": path, "message": format!(
                "Didn't overwrite `{}`: the new content is only a section of the existing file, so the rest would have been lost. Ask for the change again — small files should be sent complete, large ones as an <edit>.", path) }))];
        }
        let mut out: Vec<Ev> = self.checkpoint().await.into_iter().collect();
        if let Some(parent) = full.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        match tokio::fs::write(&full, content).await {
            Ok(()) => {
                self.changed_in_segment = true;
                out.push(ev("file", json!({ "path": path, "kind": "write", "before": before.unwrap_or_default(), "after": content })));
            }
            Err(e) => out.push(ev("edit_failed", json!({ "path": path, "message": format!("Couldn't write `{}`: {}", path, e) }))),
        }
        out
    }

    async fn apply(&mut self, action: Action) -> Applied {
        match action {
            Action::Read { path } => Applied::Read(path),
            Action::File { .. } | Action::Edit { .. } if self.mode == Mode::Discuss => {
                if self.discuss_notice_sent {
                    return Applied::Events(vec![]);
                }
                self.discuss_notice_sent = true;
                Applied::Events(vec![ev("notice", json!({ "text": "Discuss mode — the file changes in this reply were not applied. Use \"Build this plan\" or switch to Build to make changes." }))])
            }
            Action::File { path, content } => Applied::Events(self.write_file(&path, &content, true).await),
            Action::Edit { path, hunks } => {
                if hunks.is_empty() {
                    return Applied::Events(vec![ev("edit_failed", json!({ "path": path, "message": format!("The edit to `{}` had no <search>/<replace> pairs, so nothing changed.", path) }))]);
                }
                let Ok(full) = safe_project_path(&self.dir, &path) else {
                    return Applied::Events(vec![ev("edit_failed", json!({ "path": path, "message": format!("`{}` is outside the project.", path) }))]);
                };
                let Ok(before) = tokio::fs::read_to_string(&full).await else {
                    return Applied::Events(vec![ev("edit_failed", json!({ "path": path, "message": format!("Can't edit `{}` — it doesn't exist yet.", path) }))]);
                };
                let outcome = apply_hunks(&before, &hunks);
                let mut events: Vec<Ev> = Vec::new();
                if outcome.applied > 0 {
                    events.extend(self.checkpoint().await);
                    match tokio::fs::write(&full, &outcome.content).await {
                        Ok(()) => {
                            self.changed_in_segment = true;
                            events.push(ev("file", json!({ "path": path, "kind": "edit", "before": before, "after": outcome.content })));
                        }
                        Err(e) => events.push(ev("edit_failed", json!({ "path": path, "message": format!("Couldn't write `{}`: {}", path, e) }))),
                    }
                }
                if outcome.failed.is_empty() {
                    Applied::Events(events)
                } else {
                    Applied::EditMiss(path, outcome.failed, events)
                }
            }
        }
    }

    /// One retry for hunks that matched nowhere: hand the model the file's exact current
    /// contents and the intended change, and apply whatever it sends back. If that fails too,
    /// ask the user to point at the lines instead of guessing further.
    async fn retry_edit(&mut self, client: &LLMClient, path: &str, hunks: &[(String, String)], usage: &mut Usage) -> Vec<Ev> {
        let mut out = vec![ev("status", json!({ "text": format!("🔍 An edit to {} didn't match the file — retrying against its current contents…", path) }))];
        let give_up = |n: usize| ev("edit_failed", json!({ "path": path, "message": format!(
            "{} change{} to `{}` couldn't be applied — the text {} isn't in the file. Point me at the exact lines (or paste them) and I'll try again.",
            n, if n == 1 { "" } else { "s" }, path, if n == 1 { "it targets" } else { "they target" }) }));
        let Ok(full) = safe_project_path(&self.dir, path) else { out.push(give_up(hunks.len())); return out };
        let Ok(current) = tokio::fs::read_to_string(&full).await else { out.push(give_up(hunks.len())); return out };

        let intended = hunks
            .iter()
            .enumerate()
            .map(|(i, (s, r))| format!("Change {}:\nfrom (approximately):\n{}\nto:\n{}", i + 1, s, r))
            .collect::<Vec<_>>()
            .join("\n\n");
        let system = format!(
            "You are fixing one file, `{p}`. A previous search/replace didn't match its current contents. Reply with ONLY one tag: the complete corrected file as <file path=\"{p}\">…</file> if it is under ~400 lines, otherwise <edit path=\"{p}\"> with <search> text copied exactly from the contents below. No other text.",
            p = path
        );
        let user = format!("Current contents of `{p}`:\n=== {p} ===\n{c}\n=== end of {p} ===\n\nApply the intent of these changes:\n\n{i}", p = path, c = current, i = intended);
        let messages = vec![to_openai("system", system), to_openai("user", user)];
        let mut reply = String::new();
        match client.chat_stream(messages, self.model.clone()).await {
            Ok(mut stream) => {
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(c) if c.chunk_type == ChunkType::Content => reply.push_str(&c.content),
                        Ok(c) if c.chunk_type == ChunkType::Usage => usage.add(&c.content),
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            }
            Err(_) => {
                out.push(give_up(hunks.len()));
                return out;
            }
        }
        let fix = ActionParser::new().advance(&reply).into_iter().find(|a| match a {
            Action::File { path: p, .. } | Action::Edit { path: p, .. } => p == path,
            Action::Read { .. } => false,
        });
        match fix {
            Some(action) => match self.apply(action).await {
                Applied::Events(events) => out.extend(events),
                Applied::EditMiss(_, still, events) => {
                    out.extend(events);
                    out.push(give_up(still.len()));
                }
                Applied::Read(_) => out.push(give_up(hunks.len())),
            },
            None => out.push(give_up(hunks.len())),
        }
        out
    }
}

fn run_turn(mut turn: Turn, client: LLMClient, req: ChatTurnRequest) -> impl Stream<Item = Ev> {
    async_stream::stream! {
        // The conversation the model sees (after the system prompt). Older assistant replies have
        // their file contents collapsed so stale copies can't compete with PROJECT FILES.
        let mut convo: Vec<(String, String)> = req.history.iter().map(|m| {
            let role = if m.role == "assistant" { "assistant" } else if m.role == "system" { "system" } else { "user" };
            let content = if role == "assistant" { sanitize_assistant_history(&m.content) } else { m.content.clone() };
            (role.to_string(), content)
        }).collect();

        // The assistant message currently being written.
        let mut segment = String::new();
        let mut parser = ActionParser::new();
        let mut continuing = false;
        if req.continue_last {
            match req.history.last() {
                Some(last) if last.role == "assistant" => {
                    convo.pop();
                    // Keep the cut-off reply verbatim — the model continues from its own text —
                    // and skip the actions in it, which were applied when it first streamed.
                    segment = last.content.clone();
                    parser.advance(&segment);
                    continuing = true;
                }
                _ => {
                    yield ev("error", json!({ "message": "There's no cut-off reply to continue." }));
                    return;
                }
            }
        } else {
            convo.push(("user".to_string(), req.message.clone().unwrap_or_default()));
        }

        let mut usage = Usage::default();
        let mut read_rounds = 0;
        loop {
            let mut reads: Vec<String> = Vec::new();
            let mut misses: Vec<(String, Vec<(String, String)>)> = Vec::new();
            let mut continuations = 0;
            let mut finish;
            turn.changed_in_segment = false;
            loop {
                let mut messages = vec![to_openai("system", turn.system_prompt().await)];
                messages.extend(convo.iter().map(|(r, c)| to_openai(r, c.clone())));
                if continuing {
                    messages.push(to_openai("assistant", segment.clone()));
                    messages.push(to_openai("user", CONTINUE_PROMPT.to_string()));
                }
                let mut llm = match client.chat_stream(messages, turn.model.clone()).await {
                    Ok(s) => s,
                    Err(e) => {
                        yield ev("error", json!({ "message": format!("LLM request failed: {}", e) }));
                        return;
                    }
                };
                finish = String::new();
                // A continuation is held back until there's enough of it to repair the seam
                // (a re-opened tag or repeated lines) before any of it is shown or applied.
                let inside_tag = continuing && parser.inside_open_tag(&segment);
                let mut held: Option<String> = continuing.then(String::new);
                loop {
                    // (delta to append, whether the stream has ended)
                    let (delta, ended) = match llm.next().await {
                        // End of stream: flush a continuation too short to have been released.
                        None => match held.take() {
                            Some(buf) => (stitch_continuation(&segment, &buf, inside_tag), true),
                            None => break,
                        },
                        Some(Err(e)) => {
                            yield ev("error", json!({ "message": format!("The model's stream broke off: {}", e) }));
                            return;
                        }
                        Some(Ok(chunk)) => match chunk.chunk_type {
                            ChunkType::Content => match held.as_mut() {
                                Some(buf) => {
                                    buf.push_str(&chunk.content);
                                    if buf.len() < STITCH_LOOKAHEAD { continue; }
                                    let stitched = stitch_continuation(&segment, buf, inside_tag);
                                    held = None;
                                    (stitched, false)
                                }
                                None => (chunk.content, false),
                            },
                            ChunkType::Reasoning => {
                                yield ev("reasoning", json!({ "text": chunk.content }));
                                continue;
                            }
                            ChunkType::FinishReason => { finish = chunk.content; continue; }
                            ChunkType::Usage => { usage.add(&chunk.content); continue; }
                        },
                    };
                    if !delta.is_empty() {
                        segment.push_str(&delta);
                        yield ev("text", json!({ "text": delta }));
                        for action in parser.advance(&segment) {
                            match turn.apply(action).await {
                                Applied::Events(events) => for e in events { yield e; },
                                Applied::Read(path) => if !reads.contains(&path) { reads.push(path) },
                                Applied::EditMiss(path, hunks, events) => {
                                    for e in events { yield e; }
                                    misses.push((path, hunks));
                                }
                            }
                        }
                    }
                    if ended { break; }
                }
                if finish == "length" && continuations < MAX_CONTINUATIONS {
                    continuations += 1;
                    continuing = true;
                    yield ev("status", json!({ "text": "⏩ The reply hit the model's output limit — continuing it…" }));
                    continue;
                }
                break;
            }
            continuing = false;
            if finish == "length" {
                yield ev("truncated", json!({}));
            }

            for (path, hunks) in std::mem::take(&mut misses) {
                for e in turn.retry_edit(&client, &path, &hunks, &mut usage).await { yield e; }
            }

            if turn.mode == Mode::Build && !turn.changed_in_segment && looks_like_untagged_code(&segment) {
                yield ev("notice", json!({ "text": "The model replied with code blocks instead of <file> tags, so nothing was written. Ask it to send the changes again as <file> tags." }));
            }

            // Serve <read> requests: the files join the working set (so the next system prompt
            // carries their current contents) and the model picks up where it stopped.
            if reads.is_empty() || finish == "length" {
                break;
            }
            if read_rounds >= MAX_READ_ROUNDS {
                yield ev("status", json!({ "text": format!("📎 The model asked to read {} — the read limit for one message is reached; send another message to continue.", reads.join(", ")) }));
                break;
            }
            read_rounds += 1;
            let view = turn.view().await;
            let (found, missing): (Vec<String>, Vec<String>) = reads.into_iter().partition(|p| view.files.contains_key(p));
            turn.working_set.extend(found.iter().cloned());
            if !found.is_empty() {
                yield ev("read", json!({ "paths": found }));
            }
            let mut status = Vec::new();
            if !found.is_empty() { status.push(format!("📎 Reading {}", found.join(", "))); }
            if !missing.is_empty() { status.push(format!("⚠️ Not found: {}", missing.join(", "))); }
            yield ev("status", json!({ "text": format!("{} — continuing…", status.join(" · ")) }));

            convo.push(("assistant".to_string(), sanitize_assistant_history(&segment)));
            let mut note = String::new();
            if !found.is_empty() {
                note.push_str(&format!("The file(s) you asked for ({}) are now included under PROJECT FILES with their current contents. ", found.join(", ")));
            }
            if !missing.is_empty() {
                note.push_str(&format!("These don't exist in the project: {}. ", missing.join(", ")));
            }
            note.push_str("Continue the task.");
            convo.push(("user".to_string(), note));
            segment.clear();
            parser = ActionParser::new();
            yield ev("segment", json!({}));
        }

        yield ev("usage", json!({ "prompt_tokens": usage.prompt, "completion_tokens": usage.completion, "total_tokens": usage.total }));
        yield ev("done", json!({}));
    }
}
