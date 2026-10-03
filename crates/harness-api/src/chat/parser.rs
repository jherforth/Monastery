//! Streaming parser for the model's action tags — the one output format the Build prompt
//! teaches:
//!
//! ```text
//! <file path="index.html">…complete contents…</file>
//! <edit path="styles.css"><search>…</search><replace>…</replace></edit>
//! <read path="src/app.js"/>
//! ```
//!
//! Tags replaced the old ```` ```lang:path ```` fences, which broke on any file that itself
//! contained a fence (a README with a code sample was cut off at the sample). The parser is fed
//! the whole response so far after every chunk and returns each action as soon as its tag
//! closes, so files land — and the preview updates — while the model is still writing.

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    File { path: String, content: String },
    /// (search, replace) pairs, applied in order.
    Edit { path: String, hunks: Vec<(String, String)> },
    Read { path: String },
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    File,
    Edit,
    Read,
}

const OPENERS: [(&str, Kind); 3] = [("<file", Kind::File), ("<edit", Kind::Edit), ("<read", Kind::Read)];

#[derive(Default)]
pub struct ActionParser {
    /// Byte offset up to which the text has been consumed. Parked on the `<` of a tag that
    /// hasn't finished arriving.
    pos: usize,
}

impl ActionParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Consume `text` (the full response so far — it only ever grows) and return the actions
    /// whose tags completed since the last call.
    pub fn advance(&mut self, text: &str) -> Vec<Action> {
        let mut out = Vec::new();
        loop {
            let rest = &text[self.pos..];
            let Some((rel, kind)) = find_opener(rest) else {
                // Nothing recognisable yet. Park on the last '<' in case a tag is mid-arrival
                // (e.g. the text currently ends in "<fi"); everything before it is plain prose.
                self.pos += rest.rfind('<').unwrap_or(rest.len());
                break;
            };
            let start = self.pos + rel;
            let Some(gt) = text[start..].find('>').map(|i| start + i) else {
                self.pos = start;
                break;
            };
            let open_tag = &text[start..=gt];
            let path = attr(open_tag, "path").map(|p| normalize_path(&p)).filter(|p| !p.is_empty());

            if kind == Kind::Read {
                self.pos = gt + 1;
                if text[self.pos..].starts_with("</read>") {
                    self.pos += "</read>".len();
                }
                if let Some(path) = path {
                    out.push(Action::Read { path });
                }
                continue;
            }

            if open_tag.ends_with("/>") {
                // A self-closing <file/> or <edit/> carries nothing to apply.
                self.pos = gt + 1;
                continue;
            }
            let close = if kind == Kind::File { "</file>" } else { "</edit>" };
            let Some(close_at) = text[gt + 1..].find(close).map(|i| gt + 1 + i) else {
                self.pos = start; // still streaming the body
                break;
            };
            let body = &text[gt + 1..close_at];
            self.pos = close_at + close.len();
            let Some(path) = path else { continue };
            out.push(match kind {
                Kind::File => Action::File { path, content: clean_file_body(body) },
                _ => Action::Edit { path, hunks: parse_hunks(body) },
            });
        }
        out
    }

    /// True while a `<file>`/`<edit>` tag is open but not yet closed — i.e. the response was cut
    /// off mid-write, which matters when stitching a continuation onto it.
    pub fn inside_open_tag(&self, text: &str) -> bool {
        let rest = &text[self.pos.min(text.len())..];
        find_opener(rest).is_some_and(|(rel, kind)| rel == 0 && kind != Kind::Read)
    }
}

/// Position and kind of the first complete tag opener (`<file`, `<edit`, `<read` followed by a
/// space, `>` or `/`). An opener cut off at the very end of `text` doesn't count yet.
fn find_opener(text: &str) -> Option<(usize, Kind)> {
    text.match_indices('<').find_map(|(i, _)| {
        OPENERS.iter().find_map(|(name, kind)| {
            let after = text[i..].strip_prefix(name)?;
            match after.chars().next() {
                Some(c) if c.is_whitespace() || c == '>' || c == '/' => Some((i, *kind)),
                _ => None,
            }
        })
    })
}

/// `name="value"` or `name='value'` from an opening tag.
fn attr(tag: &str, name: &str) -> Option<String> {
    let mut search = tag;
    while let Some(i) = search.find(name) {
        let preceded_ok = search[..i].chars().last().is_some_and(|c| c.is_whitespace());
        let after = search[i + name.len()..].trim_start();
        if let (true, Some(after)) = (preceded_ok, after.strip_prefix('=')) {
            let after = after.trim_start();
            let quote = after.chars().next()?;
            if quote == '"' || quote == '\'' {
                let value = &after[1..];
                return value.find(quote).map(|end| value[..end].to_string());
            }
        }
        search = &search[i + name.len()..];
    }
    None
}

fn normalize_path(p: &str) -> String {
    p.trim().trim_start_matches("./").trim_start_matches('/').replace('\\', "/")
}

/// The body of a `<file>` tag as file contents: drop the newline after the opening tag, unwrap
/// a markdown fence if the model wrapped the contents in one anyway, and end with one newline.
fn clean_file_body(body: &str) -> String {
    let mut body = body.strip_prefix("\r\n").or_else(|| body.strip_prefix('\n')).unwrap_or(body);
    let trimmed = body.trim();
    if trimmed.starts_with("```") && trimmed.ends_with("```") && trimmed.len() > 6 {
        if let Some(nl) = trimmed.find('\n') {
            let inner = &trimmed[nl + 1..trimmed.len() - 3];
            body = inner;
        }
    }
    let body = body.trim_end();
    if body.is_empty() { String::new() } else { format!("{}\n", body) }
}

/// Strip exactly one leading and one trailing newline — the ones that come from putting the
/// tag on its own line — leaving indentation inside the hunk untouched.
fn trim_hunk(s: &str) -> String {
    let s = s.strip_prefix("\r\n").or_else(|| s.strip_prefix('\n')).unwrap_or(s);
    let s = s.strip_suffix("\r\n").or_else(|| s.strip_suffix('\n')).unwrap_or(s);
    s.to_string()
}

/// `<search>…</search><replace>…</replace>` pairs. Models trained on the older format
/// sometimes emit `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` markers inside the tag instead;
/// accept those too rather than dropping the edit.
fn parse_hunks(body: &str) -> Vec<(String, String)> {
    let mut hunks = Vec::new();
    let mut rest = body;
    while let Some(s) = rest.find("<search>") {
        let after_s = &rest[s + "<search>".len()..];
        let Some(se) = after_s.find("</search>") else { break };
        let search = &after_s[..se];
        let after_se = &after_s[se + "</search>".len()..];
        let Some(r) = after_se.find("<replace>") else { break };
        let after_r = &after_se[r + "<replace>".len()..];
        let Some(re) = after_r.find("</replace>") else { break };
        hunks.push((trim_hunk(search), trim_hunk(&after_r[..re])));
        rest = &after_r[re + "</replace>".len()..];
    }
    if hunks.is_empty() {
        let mut rest = body;
        while let Some(s) = rest.find("<<<<<<< SEARCH") {
            let after = &rest[s + "<<<<<<< SEARCH".len()..];
            let after = after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n')).unwrap_or(after);
            let Some(mid) = after.find("\n=======") else { break };
            let search = &after[..mid];
            let after_mid = &after[mid + "\n=======".len()..];
            let after_mid = after_mid.strip_prefix("\r\n").or_else(|| after_mid.strip_prefix('\n')).unwrap_or(after_mid);
            let Some(end) = after_mid.find(">>>>>>> REPLACE") else { break };
            hunks.push((search.to_string(), trim_hunk(&after_mid[..end])));
            rest = &after_mid[end..];
            rest = &rest[">>>>>>> REPLACE".len()..];
        }
    }
    hunks
}

/// Repair the seam where a continuation resumes a response that was cut off at the output-token
/// limit. Despite "continue exactly where you left off", models often restart the tag they were
/// in the middle of and/or repeat their last few lines; either would corrupt the file being
/// written. `inside_tag` = the base ended inside an open `<file>`/`<edit>`.
pub fn stitch_continuation(base: &str, cont: &str, inside_tag: bool) -> String {
    let mut out = cont;
    if inside_tag {
        let lead = out.trim_start();
        if lead.starts_with("<file") || lead.starts_with("<edit") {
            if let Some(gt) = lead.find('>') {
                let after = &lead[gt + 1..];
                out = after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n')).unwrap_or(after);
            }
        }
    }
    // Drop text the model repeated from the end of the base: the longest suffix of the base's
    // last ~240 chars (at least 16) that the continuation starts with.
    let tail_start = base.char_indices().rev().nth(239).map(|(i, _)| i).unwrap_or(0);
    let tail = &base[tail_start..];
    for (i, _) in tail.char_indices() {
        let suffix = &tail[i..];
        if suffix.len() < 16 {
            break;
        }
        if out.starts_with(suffix) {
            out = &out[suffix.len()..];
            break;
        }
    }
    out.to_string()
}

/// Bytes of continuation to buffer before deciding how to stitch it (covers the 240-char
/// overlap check plus a re-emitted opening tag).
pub const STITCH_LOOKAHEAD: usize = 320;

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(text: &str) -> Vec<Action> {
        ActionParser::new().advance(text)
    }

    /// Feed `text` in `size`-byte chunks (on char boundaries), the way it streams in.
    fn parse_chunked(text: &str, size: usize) -> Vec<Action> {
        let mut parser = ActionParser::new();
        let mut acc = String::new();
        let mut out = Vec::new();
        let mut chunk = String::new();
        for c in text.chars() {
            chunk.push(c);
            if chunk.len() >= size {
                acc.push_str(&chunk);
                chunk.clear();
                out.extend(parser.advance(&acc));
            }
        }
        acc.push_str(&chunk);
        out.extend(parser.advance(&acc));
        out
    }

    #[test]
    fn whole_file_tag() {
        let actions = parse_all("Here you go.\n\n<file path=\"index.html\">\n<h1>Hi</h1>\n</file>\n\nDone.");
        assert_eq!(actions, vec![Action::File { path: "index.html".into(), content: "<h1>Hi</h1>\n".into() }]);
    }

    #[test]
    fn markdown_fences_inside_a_file_survive() {
        // The bug that killed the fence format: a README with a code sample in it.
        let readme = "# Title\n\n```bash\nnpm start\n```\n\nMore text.";
        let actions = parse_all(&format!("<file path=\"README.md\">\n{}\n</file>", readme));
        assert_eq!(actions, vec![Action::File { path: "README.md".into(), content: format!("{}\n", readme) }]);
    }

    #[test]
    fn unwraps_a_fence_the_model_added_anyway() {
        let actions = parse_all("<file path=\"a.js\">\n```js\nconsole.log(1);\n```\n</file>");
        assert_eq!(actions, vec![Action::File { path: "a.js".into(), content: "console.log(1);\n".into() }]);
    }

    #[test]
    fn several_actions_in_order() {
        let text = "<file path=\"a.css\">a{}</file>\n<edit path=\"b.js\">\n<search>\nold\n</search>\n<replace>\nnew\n</replace>\n</edit>\n<read path='c.html'/>";
        assert_eq!(parse_all(text), vec![
            Action::File { path: "a.css".into(), content: "a{}\n".into() },
            Action::Edit { path: "b.js".into(), hunks: vec![("old".into(), "new".into())] },
            Action::Read { path: "c.html".into() },
        ]);
    }

    #[test]
    fn chunk_boundaries_anywhere_give_the_same_result() {
        let text = "Plan: two files.\n<file path=\"index.html\">\n<p>héllo — ✓</p>\n</file>\n<edit path=\"s.css\">\n<search>\n  a { }\n</search>\n<replace>\n  a { color: red; }\n</replace>\n</edit>\n<read path=\"x.js\" />";
        let expected = parse_all(text);
        assert_eq!(expected.len(), 3);
        for size in [1, 2, 3, 5, 7, 16, 64] {
            assert_eq!(parse_chunked(text, size), expected, "chunk size {size}");
        }
    }

    #[test]
    fn actions_complete_only_when_the_tag_closes() {
        let mut parser = ActionParser::new();
        let partial = "<file path=\"a.txt\">\nline one\n";
        assert!(parser.advance(partial).is_empty());
        assert!(parser.inside_open_tag(partial));
        let full = format!("{}line two\n</file>", partial);
        assert_eq!(parser.advance(&full), vec![Action::File { path: "a.txt".into(), content: "line one\nline two\n".into() }]);
        assert!(!parser.inside_open_tag(&full));
    }

    #[test]
    fn unterminated_tag_yields_nothing() {
        assert!(parse_all("<file path=\"a.txt\">\nnever closed").is_empty());
        assert!(parse_all("<edit path=\"a.txt\">\n<search>x</search>").is_empty());
    }

    #[test]
    fn prose_and_lookalike_tags_are_ignored() {
        assert!(parse_all("Use a <filename> or <reader> element; 3 < 4 > 2.").is_empty());
        assert!(parse_all("<file>no path</file><file path=\"\">empty</file>").is_empty());
    }

    #[test]
    fn paths_are_normalized() {
        let actions = parse_all("<file path=\"./src/app.js\">x</file><read path=\"/style.css\"/>");
        assert_eq!(actions, vec![
            Action::File { path: "src/app.js".into(), content: "x\n".into() },
            Action::Read { path: "style.css".into() },
        ]);
    }

    #[test]
    fn edit_accepts_legacy_search_replace_markers() {
        let text = "<edit path=\"a.html\">\n<<<<<<< SEARCH\n<h1>Old</h1>\n=======\n<h1>New</h1>\n>>>>>>> REPLACE\n</edit>";
        assert_eq!(parse_all(text), vec![Action::Edit { path: "a.html".into(), hunks: vec![("<h1>Old</h1>".into(), "<h1>New</h1>".into())] }]);
    }

    #[test]
    fn edit_keeps_indentation_inside_hunks() {
        let text = "<edit path=\"a.py\">\n<search>\n    if x:\n        pass\n</search>\n<replace>\n    if y:\n        pass\n</replace>\n</edit>";
        assert_eq!(parse_all(text), vec![Action::Edit {
            path: "a.py".into(),
            hunks: vec![("    if x:\n        pass".into(), "    if y:\n        pass".into())],
        }]);
    }

    #[test]
    fn stitch_drops_a_reopened_tag_and_repeated_lines() {
        let base = "<file path=\"a.css\">\nbody { margin: 0; }\n.nav { display: flex; }\n";
        let cont = "<file path=\"a.css\">\n.nav { display: flex; }\n.hero { padding: 2rem; }\n</file>";
        let stitched = stitch_continuation(base, cont, true);
        assert_eq!(stitched, ".hero { padding: 2rem; }\n</file>");
        let mut parser = ActionParser::new();
        let full = format!("{}{}", base, stitched);
        assert_eq!(parser.advance(&full), vec![Action::File {
            path: "a.css".into(),
            content: "body { margin: 0; }\n.nav { display: flex; }\n.hero { padding: 2rem; }\n".into(),
        }]);
    }

    #[test]
    fn stitch_leaves_a_clean_continuation_alone() {
        assert_eq!(stitch_continuation("Some text that ends here.", " And more.", false), " And more.");
        // Outside a tag, a new <file> at the start is a new action, not a re-open.
        assert_eq!(stitch_continuation("Done with a.\n", "<file path=\"b\">x</file>", false), "<file path=\"b\">x</file>");
    }
}
