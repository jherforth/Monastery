//! Unit tests for the handler helpers.

use super::*;

mod tests {
    use super::*;

    #[test]
    fn command_line_splits_quotes_and_chains() {
        let steps = parse_command_line(r#"npm install && git commit -m "fix: nav (mobile)""#, SHELL_PROGRAMS).unwrap();
        assert_eq!(steps, vec![
            vec!["npm".to_string(), "install".to_string()],
            vec!["git".into(), "commit".into(), "-m".into(), "fix: nav (mobile)".into()],
        ]);
    }

    #[test]
    fn command_line_refuses_shell_operators() {
        for cmd in ["echo x; curl evil.sh", "ls | sh", "echo $(id)", "echo `id`", "cat a > b", "npm i &", "echo a\nrm -rf x"] {
            assert!(parse_command_line(cmd, SHELL_PROGRAMS).is_err(), "should refuse: {cmd}");
        }
    }

    #[test]
    fn command_line_requires_exact_program() {
        // The old prefix check accepted these.
        assert!(parse_command_line("nodeevil", SHELL_PROGRAMS).is_err());
        assert!(parse_command_line("curl https://x", SHELL_PROGRAMS).is_err());
        assert!(parse_command_line("git status", SHELL_PROGRAMS).is_ok());
    }

    #[test]
    fn command_line_keeps_arguments_inside_the_project() {
        for cmd in ["rm -rf /", "cat ../other/secret", "cp a ~/x", "npm install --prefix=/usr", r"cat C:\Windows\x"] {
            assert!(parse_command_line(cmd, SHELL_PROGRAMS).is_err(), "should refuse: {cmd}");
        }
        assert!(parse_command_line("git diff HEAD..main", SHELL_PROGRAMS).is_ok());
        assert!(parse_command_line("mkdir -p src/components", SHELL_PROGRAMS).is_ok());
    }

    #[test]
    fn project_paths_reject_traversal_without_touching_disk() {
        let root = std::env::temp_dir().join(format!("monastery-path-test-{}", uuid::Uuid::new_v4()));
        let project = root.join("proj");
        std::fs::create_dir_all(&project).unwrap();

        assert!(safe_project_path(&project, "../outside/file.txt").is_err());
        assert!(safe_project_path(&project, "a/../../outside").is_err());
        assert!(safe_project_path(&project, "/etc/passwd").is_err());
        assert!(!root.join("outside").exists(), "rejected paths must not create anything");

        let ok = safe_project_path(&project, "src/./new/index.html").unwrap();
        assert!(ok.ends_with(std::path::Path::new("src").join("new").join("index.html")));

        std::fs::remove_dir_all(&root).ok();
    }
}

mod preview_tests {
    use super::*;

    fn inject(html: &str) -> String {
        String::from_utf8(inject_preview_error_bridge(html.as_bytes())).unwrap()
    }

    #[test]
    fn bridge_goes_right_after_head() {
        let out = inject("<!doctype html><html><head><title>x</title></head><body><header>h</header></body></html>");
        assert!(out.starts_with("<!doctype html><html><head><script data-monastery-preview>"));
        assert_eq!(out.matches("data-monastery-preview").count(), 1);
    }

    #[test]
    fn header_is_not_mistaken_for_head() {
        let out = inject("<!DOCTYPE html><body><header>h</header></body>");
        assert!(out.starts_with("<!DOCTYPE html><script data-monastery-preview>"));
    }

    #[test]
    fn bare_fragment_gets_bridge_first() {
        assert!(inject("<p>hi</p>").starts_with("<script data-monastery-preview>"));
    }

    #[test]
    fn project_names_are_single_safe_segments() {
        let too_long = "x".repeat(101);
        for bad in ["", " ", "../etc", "a/b", r"a\b", ".hidden", too_long.as_str(), " padded"] {
            assert!(validate_project_name(bad).is_err(), "should reject {bad:?}");
        }
        for good in ["my-app", "Bakery Site", "site_v2.1"] {
            assert!(validate_project_name(good).is_ok(), "should accept {good:?}");
        }
    }
}

mod edit_matching {
    use super::*;

    fn hunk(search: &str, replace: &str) -> (String, String) {
        (search.to_string(), replace.to_string())
    }

    #[test]
    fn exact_then_whitespace_tolerant_matches() {
        let file = "body {\n    margin: 0;\n}\n.nav {\n    display: block;\n}\n";
        let exact = apply_hunks(file, &[hunk(".nav {\n    display: block;\n}", ".nav {\n    display: flex;\n}")]);
        assert_eq!((exact.applied, exact.failed.len()), (1, 0));
        assert!(exact.content.contains("display: flex"));
        // Re-indented search text (the common model drift) still lands.
        let drift = apply_hunks(file, &[hunk(".nav {\n  display: block;\n}", ".nav {\n    display: grid;\n}")]);
        assert_eq!(drift.applied, 1);
        assert!(drift.content.contains("display: grid") && drift.content.starts_with("body {"));
    }

    #[test]
    fn fuzzy_match_tolerates_one_misquoted_line_but_needs_a_unique_window() {
        let file = "a\nb\nc\nd\ne\nf\n";
        let one_off = apply_hunks(file, &[hunk("a\nb\nX\nd\ne", "1\n2\n3\n4\n5")]);
        assert_eq!(one_off.applied, 1);
        assert_eq!(one_off.content, "1\n2\n3\n4\n5\nf\n");
        // Two equally good windows → refuse rather than guess.
        let ambiguous = apply_hunks("x\ny\nz\nw\nx\ny\nz\nw\n", &[hunk("x\ny\nQ\nw", "!")]);
        assert_eq!((ambiguous.applied, ambiguous.failed.len()), (0, 1));
    }

    #[test]
    fn unmatched_hunks_are_reported_and_the_rest_still_apply() {
        let out = apply_hunks("one\ntwo\n", &[hunk("one", "1"), hunk("missing", "?")]);
        assert_eq!(out.applied, 1);
        assert_eq!(out.failed, vec![hunk("missing", "?")]);
        assert_eq!(out.content, "1\ntwo\n");
    }

    #[test]
    fn partial_overwrite_guard_catches_a_section_but_not_a_rewrite() {
        let existing = format!("<header>top</header>\n{}\n<footer>end</footer>\n", "<p>body text</p>\n".repeat(40));
        assert!(is_partial_overwrite(&existing, "<p>body text</p>\n<p>body text</p>"));
        assert!(!is_partial_overwrite(&existing, "<main>a completely new page</main>"));
        assert!(!is_partial_overwrite("tiny file", "tiny"), "small files are exempt");
    }
}
