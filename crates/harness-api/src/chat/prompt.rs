//! The system prompt for a chat turn, built from what is on disk right now — so the model can
//! never be handed a stale copy of a file (the "context-freshness" bugs of the browser-side
//! engine came from keeping an in-memory copy of the project in sync with the disk).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::Mode;
use crate::handlers::{read_files_recursive, CONTEXT_SKIP_DIRS};

/// Below this many bytes of text the whole project goes into context; above it, only the open
/// file and the working set (files the model asked to `<read>`).
pub const SMALL_PROJECT_LIMIT: usize = 96_000;
/// Cap on file-tree entries listed in the prompt.
const MAX_TREE_ENTRIES: usize = 400;

const NO_TOOL_CALLS: &str = "- You have NO native function or tool calling here. Never emit tool-call markup of any kind (<|DSML|…>, <tool_call>, <|tool_calls_begin|>, JSON function calls) — it is not executed. Use only the tags described above.";

const BUILD_RULES: &str = r###"HOW TO CHANGE FILES — your changes are applied to the project automatically, so use exactly this format:

1. CREATE a file, or REWRITE one → its COMPLETE contents inside a <file> tag:

<file path="index.html">
<!doctype html>
…the whole file, every line…
</file>

2. CHANGE PART of a LARGE existing file (over ~200 lines) → an <edit> tag with one or more search/replace pairs. Each <search> must be copied EXACTLY from the file's current contents, with enough lines to be unique:

<edit path="styles.css">
<search>
.nav { display: block; }
</search>
<replace>
.nav { display: flex; justify-content: center; }
</replace>
</edit>

Rules:
- For any file under ~200 lines, ALWAYS send the complete file with <file>. Complete files always apply cleanly; search text can fail to match.
- A <file> tag REPLACES the whole file. NEVER put a fragment, a placeholder, or "…rest unchanged…" in one — anything omitted is deleted.
- Paths are relative to the project root. Do not wrap file contents in markdown code fences.
- Use ordinary markdown code blocks only for examples that should NOT be written to disk.
- Shell commands go in a ```bash block. They are NOT run automatically — the user decides whether to run them — so only suggest one when it is genuinely needed, and never assume it ran.
- To see a file that isn't shown under PROJECT FILES, output <read path="path/to/file"/> on its own line and stop; the file will be added and you will continue. Never edit a file you haven't seen.
"###;

const BUILD_DISCIPLINE: &str = "RESPONSE DISCIPLINE — this decides whether the request actually gets done:
1. Think through the whole request first, then make ALL the changes in this one response. Nothing runs later unless the user asks again.
2. Keep prose short: at most 2–4 lines on what you're doing, then the tags. Don't narrate each edit or repeat file contents outside the tags.";

const DISCUSS_RULES: &str = r###"DISCUSS MODE — you are helping the user understand this project and plan changes to it. You do NOT implement anything in this mode.

1. Answer questions directly and concisely. Only write a plan when the user asks for a change, a new feature, or help debugging.
2. When planning, write exactly ONE plan under a "## The Plan" heading: numbered steps, each naming the real file(s) involved (from the project tree) and describing in plain English what changes and why.
3. NEVER write code, code blocks, file contents, or <file>/<edit> tags — nothing you write in this mode is applied to the project. Describe changes in words (e.g. "in styles.css, turn the nav into a centered flex row").
4. Mention any new dependencies, assets, or services the plan needs. If the request is ambiguous, ask one clarifying question instead of guessing.
5. Keep it short. When the plan is ready, the user can click "Build this plan" to have it implemented.
6. To look at a file that isn't shown under PROJECT FILES, output <read path="path/to/file"/> on its own line and stop; it will be added and you will continue.
"###;

/// Decision D2 (static-first): the preview serves files as-is, so a build step means a blank
/// preview. Projects that already have a package.json keep their stack.
const STATIC_RUNTIME: &str = "PROJECT RUNTIME — static site, no build step:
- The live preview serves the project's files exactly as they are on disk, starting from index.html at the project root. There is no dev server, no bundler, and no npm install.
- Write plain HTML, CSS and JavaScript. Use <script type=\"module\"> with ES-module imports, and load libraries from a CDN by URL (e.g. https://esm.sh/<package> or https://cdn.jsdelivr.net/npm/<package>/+esm). For Tailwind, use <script src=\"https://cdn.tailwindcss.com\"></script>.
- NEVER create package.json, build configs (vite/webpack/tsconfig), JSX/TSX, or anything else that needs compiling — it will not run in the preview or the static deploy.
- Use relative paths between files (styles.css, app.js, about.html) so the site works both in the preview and once deployed.
- Persist data in localStorage unless a backend skill (e.g. Pocketbase) is active.";

const BUILD_STEP_RUNTIME: &str = "PROJECT RUNTIME — this project has a package.json, so it uses a build step. Keep using its existing stack and tooling. The live preview only serves files as they are on disk (no dev server), so changes to compiled sources won't appear there; the deploy pipeline builds the project.";

const DESIGN: &str = "DESIGN QUALITY — for anything visual:
- Make it look finished: a deliberate palette (3–5 colors plus neutrals) as CSS custom properties, a clear type scale (system fonts or one Google Fonts pairing), consistent spacing, and generous whitespace.
- Responsive by default (mobile first, flex/grid, nothing that overflows small screens), semantic HTML, visible focus states, at least 4.5:1 text contrast, and alt text on images.
- Real, specific content that fits the request — never lorem ipsum, \"Feature 1\", or buttons that do nothing.
- Images: only stable public URLs you are certain exist, or none — prefer CSS gradients, shapes, emoji, or inline SVG. Never invent image URLs.
- Small, purposeful motion (hover/focus transitions, gentle reveals) that respects prefers-reduced-motion.";

/// Sent as the user turn when asking the model to keep going after the output-token limit.
pub const CONTINUE_PROMPT: &str = "Continue exactly where you left off. Do not repeat anything you already wrote — not even the tag you were in the middle of.";

/// What a turn knows about the project on disk.
pub struct ProjectView {
    /// Text files eligible for context (lockfiles, build output etc. excluded), by path.
    pub files: BTreeMap<String, String>,
    /// Every file path (images included), for the tree listing.
    pub tree: Vec<String>,
}

/// Read the project for one round of a turn. Synchronous file IO — call via spawn_blocking.
pub fn load_project(dir: &Path) -> ProjectView {
    let mut map = serde_json::Map::new();
    read_files_recursive(dir, dir, &mut map, 0);
    let files = map
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.replace('\\', "/"), s.to_string())))
        .collect();
    let mut tree = Vec::new();
    walk_tree(dir, dir, &mut tree);
    tree.sort();
    ProjectView { files, tree }
}

fn walk_tree(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_TREE_ENTRIES {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !CONTEXT_SKIP_DIRS.contains(&name.as_str()) {
                walk_tree(base, &path, out);
            }
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

pub struct PromptInput<'a> {
    pub project_name: &'a str,
    pub mode: Mode,
    pub view: &'a ProjectView,
    /// The editor's live buffer for the open file (may hold unsaved edits).
    pub open_file: Option<(&'a str, &'a str)>,
    pub working_set: &'a BTreeSet<String>,
    /// Active skill instruction blocks (built by the UI's skill registry).
    pub instructions: &'a [String],
}

pub fn system_prompt(input: &PromptInput) -> String {
    let PromptInput { project_name, mode, view, open_file, working_set, instructions } = input;
    let mut parts: Vec<String> = Vec::new();

    parts.push(match mode {
        Mode::Build => format!("You are an expert web developer building the project \"{}\" with the user. You can create and change any file in it.", project_name),
        Mode::Discuss => format!("You are an expert web developer acting as a technical consultant for the project \"{}\".", project_name),
    });
    match mode {
        Mode::Build => {
            parts.push(format!("{}{}", BUILD_RULES, NO_TOOL_CALLS));
            parts.push(BUILD_DISCIPLINE.to_string());
        }
        Mode::Discuss => parts.push(format!("{}{}", DISCUSS_RULES, NO_TOOL_CALLS)),
    }
    parts.push(if view.files.contains_key("package.json") { BUILD_STEP_RUNTIME } else { STATIC_RUNTIME }.to_string());
    if *mode == Mode::Build {
        parts.push(DESIGN.to_string());
    }
    parts.extend(instructions.iter().filter(|s| !s.trim().is_empty()).cloned());

    if view.tree.is_empty() {
        parts.push("PROJECT FILE TREE: (empty — this is a new project; create index.html first)".to_string());
    } else {
        let more = if view.tree.len() >= MAX_TREE_ENTRIES { "\n- … (more files not listed)" } else { "" };
        parts.push(format!("PROJECT FILE TREE:\n{}{}", view.tree.iter().map(|p| format!("- {}", p)).collect::<Vec<_>>().join("\n"), more));
    }

    // Context discipline: small projects send everything; large ones send only the open file
    // and the working set. Either way the open file shows the editor's live buffer.
    let content_of = |path: &str| -> Option<String> {
        match open_file {
            Some((p, c)) if *p == path => Some(c.to_string()),
            _ => view.files.get(path).cloned(),
        }
    };
    let total: usize = view.files.values().map(|c| c.len()).sum();
    let mut shown: Vec<String> = if total <= SMALL_PROJECT_LIMIT {
        view.files.keys().cloned().collect()
    } else {
        let mut picked: BTreeSet<String> = working_set.iter().filter(|p| view.files.contains_key(*p)).cloned().collect();
        if let Some((p, _)) = open_file {
            picked.insert(p.to_string());
        }
        picked.into_iter().collect()
    };
    shown.retain(|p| content_of(p).is_some_and(|c| !c.trim().is_empty()));
    let body = shown
        .iter()
        .map(|p| format!("=== {} ===\n{}\n=== end of {} ===", p, content_of(p).unwrap_or_default().trim_end(), p))
        .collect::<Vec<_>>()
        .join("\n\n");
    if total <= SMALL_PROJECT_LIMIT {
        if !body.is_empty() {
            parts.push(format!("PROJECT FILES (current contents on disk — the single source of truth; earlier versions in the conversation are outdated):\n\n{}", body));
        }
    } else {
        parts.push(format!(
            "PROJECT FILES (large project, so only some files are shown — current contents, the single source of truth):\n\n{}\n\nFor any other file you need, output <read path=\"…\"/> lines and stop; never guess at or rewrite a file you haven't seen.",
            if body.is_empty() { "(none shown yet)".to_string() } else { body }
        ));
    }
    parts.join("\n\n")
}

/// Prepare an earlier assistant message for the history sent to the model: collapse file
/// contents to short markers so stale copies can't compete with PROJECT FILES (models
/// routinely copy from their own outdated output), and strip leaked tool-call markup so the
/// format doesn't self-perpetuate.
pub fn sanitize_assistant_history(content: &str) -> String {
    let collapsed = collapse_tag(&collapse_tag(content, "file", "wrote"), "edit", "edited");
    let collapsed = collapse_reads(&collapsed);
    let collapsed = collapse_fences(&collapsed);
    strip_tool_markup(&collapsed)
}

/// `<tag path="p">…</tag>` → `[verb p]`; a tag still open at the end → `[verb p — cut off]`.
fn collapse_tag(text: &str, tag: &str, verb: &str) -> String {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find(&open) {
        let is_tag = rest[i + open.len()..].starts_with(|c: char| c.is_whitespace());
        let Some(gt) = rest[i..].find('>').map(|g| i + g) else { break };
        if !is_tag {
            out.push_str(&rest[..gt + 1]);
            rest = &rest[gt + 1..];
            continue;
        }
        let path = extract_path(&rest[i..=gt]).unwrap_or_else(|| "a file".into());
        out.push_str(&rest[..i]);
        match rest[gt + 1..].find(&close) {
            Some(c) => {
                out.push_str(&format!("[{} {}]", verb, path));
                rest = &rest[gt + 1 + c + close.len()..];
            }
            None => {
                out.push_str(&format!("[{} {} — cut off]", verb, path));
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn collapse_reads(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("<read") {
        let Some(gt) = rest[i..].find('>').map(|g| i + g) else { break };
        out.push_str(&rest[..i]);
        match extract_path(&rest[i..=gt]) {
            Some(p) => out.push_str(&format!("[read {}]", p)),
            None => out.push_str(&rest[i..=gt]),
        }
        rest = &rest[gt + 1..];
        if let Some(r) = rest.strip_prefix("</read>") {
            rest = r;
        }
    }
    out.push_str(rest);
    out
}

/// Older (fence-format) messages: drop code-block bodies so they can't masquerade as current
/// file contents.
fn collapse_fences(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("```") {
        let after = &rest[i + 3..];
        let info_end = after.find('\n').unwrap_or(after.len());
        let info = after[..info_end].trim();
        let Some(close) = after[info_end..].find("```").map(|c| info_end + c) else { break };
        out.push_str(&rest[..i]);
        out.push_str(&match info.split_once(':') {
            Some((_, path)) if !path.trim().is_empty() => format!("[previous version of {} omitted]", path.trim()),
            _ => "[code block omitted]".to_string(),
        });
        rest = &after[close + 3..];
    }
    out.push_str(rest);
    out
}

fn extract_path(tag: &str) -> Option<String> {
    let i = tag.find("path")?;
    let after = tag[i + 4..].trim_start().strip_prefix('=')?.trim_start();
    let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let value = &after[1..];
    value.find(quote).map(|e| value[..e].to_string())
}

/// Remove provider-native tool-call markup some models leak as plain text — DeepSeek's
/// `<｜DSML｜…>` blocks, `<|tool▁calls▁begin|>`, Qwen/Hermes-style `<tool_call>`.
fn strip_tool_markup(text: &str) -> String {
    const MARKERS: [&str; 6] = ["｜DSML", "|DSML", "|tool", "tool_call>", "function_call>", "tool_call "];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let tag_body = rest[i + 1..].strip_prefix('/').unwrap_or(&rest[i + 1..]);
        let line_end = rest[i..].find('\n').map(|n| i + n).unwrap_or(rest.len());
        match rest[i..line_end].find('>') {
            Some(gt) if MARKERS.iter().any(|m| tag_body.starts_with(m)) => rest = &rest[i + gt + 1..],
            _ => {
                out.push('<');
                rest = &rest[i + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// A Build reply that used the old fenced ```lang:path format (or bare SEARCH/REPLACE markers)
/// instead of tags — nothing in it was applied, so the user should be told.
pub fn looks_like_untagged_code(text: &str) -> bool {
    text.contains("<<<<<<< SEARCH")
        || text.lines().any(|l| {
            l.trim_start().strip_prefix("```").is_some_and(|info| {
                info.split_once(':').is_some_and(|(lang, path)| !lang.contains(' ') && path.trim().contains('.'))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(files: &[(&str, &str)]) -> ProjectView {
        ProjectView {
            files: files.iter().map(|(p, c)| (p.to_string(), c.to_string())).collect(),
            tree: files.iter().map(|(p, _)| p.to_string()).collect(),
        }
    }

    #[test]
    fn small_project_shows_every_file_and_the_live_buffer() {
        let v = view(&[("index.html", "<h1>disk</h1>"), ("styles.css", "body{}")]);
        let ws = BTreeSet::new();
        let prompt = system_prompt(&PromptInput {
            project_name: "p", mode: Mode::Build, view: &v,
            open_file: Some(("index.html", "<h1>unsaved</h1>")), working_set: &ws, instructions: &[],
        });
        assert!(prompt.contains("=== styles.css ===\nbody{}"));
        assert!(prompt.contains("<h1>unsaved</h1>") && !prompt.contains("<h1>disk</h1>"));
        assert!(prompt.contains("STATIC") || prompt.contains("static site"));
        assert!(prompt.contains("DESIGN QUALITY"));
    }

    #[test]
    fn large_project_is_scoped_to_open_file_and_working_set() {
        let big = "x".repeat(SMALL_PROJECT_LIMIT);
        let v = view(&[("a.js", &big), ("b.js", "const b = 1;"), ("c.js", "const c = 1;")]);
        let ws: BTreeSet<String> = ["b.js".to_string()].into();
        let prompt = system_prompt(&PromptInput {
            project_name: "p", mode: Mode::Build, view: &v,
            open_file: Some(("c.js", "const c = 2;")), working_set: &ws, instructions: &[],
        });
        assert!(prompt.contains("const b = 1;") && prompt.contains("const c = 2;"));
        assert!(!prompt.contains(&big));
        assert!(prompt.contains("- a.js"), "the tree still lists every file");
    }

    #[test]
    fn discuss_mode_has_no_editing_rules_and_package_json_switches_runtime() {
        let v = view(&[("package.json", "{}")]);
        let ws = BTreeSet::new();
        let prompt = system_prompt(&PromptInput {
            project_name: "p", mode: Mode::Discuss, view: &v, open_file: None, working_set: &ws, instructions: &["SKILL X".into()],
        });
        assert!(prompt.contains("DISCUSS MODE") && !prompt.contains("HOW TO CHANGE FILES"));
        assert!(prompt.contains("has a package.json") && prompt.contains("SKILL X"));
    }

    #[test]
    fn history_collapses_file_contents() {
        let msg = "Done.\n<file path=\"a.html\">\n<p>old</p>\n</file>\n<edit path=\"b.css\">\n<search>\nx\n</search>\n<replace>\ny\n</replace>\n</edit>\n<read path=\"c.js\"/>\n```html:old.html\n<p>legacy</p>\n```\n```bash\nnpm i\n```\n<file path=\"d.js\">\npartial";
        let out = sanitize_assistant_history(msg);
        assert_eq!(out, "Done.\n[wrote a.html]\n[edited b.css]\n[read c.js]\n[previous version of old.html omitted]\n[code block omitted]\n[wrote d.js — cut off]");
    }

    #[test]
    fn history_strips_leaked_tool_markup_but_keeps_html() {
        let msg = "Text <｜DSML｜invoke name=\"read\">x</｜DSML｜invoke> and <b>bold</b> <tool_call>{}</tool_call>";
        assert_eq!(sanitize_assistant_history(msg), "Text x and <b>bold</b> {}");
    }

    #[test]
    fn untagged_code_is_detected() {
        assert!(looks_like_untagged_code("```html:index.html\n<p/>\n```"));
        assert!(looks_like_untagged_code("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE"));
        assert!(!looks_like_untagged_code("```js\nconst x = { a: 1 };\n```\nRun `npm start`."));
    }
}
