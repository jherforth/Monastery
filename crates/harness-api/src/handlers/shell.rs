//! User-run commands: no shell, an exact allowlist, project-relative arguments, timeouts.

use super::*;

/// Programs the shell endpoint may launch (exact name match). The user runs these explicitly
/// from a command block's "Run" button — model output is never executed automatically.
pub(crate) const SHELL_PROGRAMS: &[&str] = &["npm", "npx", "node", "pnpm", "yarn", "git", "ls", "cat", "echo", "mkdir", "touch", "rm", "cp", "mv"];
pub(crate) const SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Split one command into words without a shell: whitespace separates, quotes group. Shell
/// operators are refused outright rather than passed through as literal arguments.
pub(crate) fn split_command_words(segment: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    for c in segment.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None => match c {
                ';' | '|' | '&' | '<' | '>' | '$' | '`' | '\n' | '\r' => {
                    return Err(format!(
                        "`{}` isn't supported — run one command at a time (`a && b` chains are fine), with no pipes, redirection, or substitution",
                        c.escape_default()
                    ));
                }
                '\'' | '"' => { quote = Some(c); in_word = true; }
                c if c.is_whitespace() => {
                    if in_word { words.push(std::mem::take(&mut cur)); in_word = false; }
                }
                _ => { cur.push(c); in_word = true; }
            },
        }
    }
    if quote.is_some() {
        return Err("Unterminated quote in command".into());
    }
    if in_word { words.push(cur); }
    Ok(words)
}

/// Parse a command line into argv steps for `run_command_steps`. Replaces the old `sh -c` +
/// prefix check, which let `echo x; <anything>` straight through: there is no shell now, the
/// program must be in `allowed` (exact match), and no argument may be an absolute path or
/// climb out of the project with `..`. `a && b` runs `a` then `b`, stopping at the first failure.
pub(crate) fn parse_command_line(cmd: &str, allowed: &[&str]) -> Result<Vec<Vec<String>>, String> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return Err("Empty command".into());
    }
    let mut steps = Vec::new();
    for segment in cmd.split("&&") {
        let argv = split_command_words(segment)?;
        let Some(program) = argv.first() else {
            return Err("Empty command next to `&&`".into());
        };
        if !allowed.contains(&program.as_str()) {
            return Err(format!("`{}` is not allowed. Allowed programs: {}", program, allowed.join(", ")));
        }
        for arg in &argv[1..] {
            // Check `--flag=value` values too, not just bare arguments.
            let value = arg.split_once('=').map(|(_, v)| v).unwrap_or(arg);
            let b = value.as_bytes();
            let absolute = value.starts_with('/')
                || value.starts_with('\\')
                || value.starts_with('~')
                || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'));
            if absolute || value.split(['/', '\\']).any(|part| part == "..") {
                return Err(format!("Argument `{}` points outside the project — only project-relative paths are allowed", arg));
            }
        }
        steps.push(argv);
    }
    Ok(steps)
}

pub(crate) struct CommandOutcome {
    success: bool,
    stdout: String,
    stderr: String,
    exit_code: i32,
}

/// Run parsed steps in `dir`, stopping at the first failure. tokio::process keeps a long build
/// from blocking the async runtime; the overall timeout (with kill_on_drop) stops a command that
/// never exits — e.g. a dev server — from hanging the request forever.
pub(crate) async fn run_command_steps(
    dir: &std::path::Path,
    steps: &[Vec<String>],
    timeout: std::time::Duration,
) -> Result<CommandOutcome, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut outcome = CommandOutcome { success: true, stdout: String::new(), stderr: String::new(), exit_code: 0 };
    for argv in steps {
        let child = tokio::process::Command::new(&argv[0])
            .args(&argv[1..])
            .current_dir(dir)
            .kill_on_drop(true)
            .output();
        let out = match tokio::time::timeout_at(deadline, child).await {
            Err(_) => {
                return Err(format!(
                    "`{}` timed out after {}s — long-running commands such as dev servers aren't supported here",
                    argv.join(" "), timeout.as_secs()
                ));
            }
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(format!("`{}` isn't installed on the Monastery server", argv[0]));
            }
            Ok(Err(e)) => return Err(format!("Failed to run `{}`: {}", argv[0], e)),
            Ok(Ok(out)) => out,
        };
        outcome.stdout.push_str(&String::from_utf8_lossy(&out.stdout));
        outcome.stderr.push_str(&String::from_utf8_lossy(&out.stderr));
        outcome.exit_code = out.status.code().unwrap_or(-1);
        if !out.status.success() {
            outcome.success = false;
            break;
        }
    }
    Ok(outcome)
}

/// Execute a shell command in a project directory
#[derive(Debug, Deserialize)]
pub struct ShellRequest {
    pub command: String,
}

pub async fn project_shell(
    project: ProjectCtx,
    Json(req): Json<ShellRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_path = project.dir.clone();

    let result = match parse_command_line(&req.command, SHELL_PROGRAMS) {
        Ok(steps) => run_command_steps(&project_path, &steps, SHELL_TIMEOUT).await,
        Err(e) => Err(e),
    };
    match result {
        Ok(o) => Ok(Json(serde_json::json!({
            "success": o.success,
            "output": o.stdout,
            "stderr": o.stderr,
            "exit_code": o.exit_code,
        }))),
        Err(e) => Ok(Json(serde_json::json!({ "success": false, "error": e }))),
    }
}
