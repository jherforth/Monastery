//! Starter templates for new projects — small, static (no build step) sites and apps that work
//! in the live preview immediately. Files live under `crates/harness-api/starters/` and are
//! compiled into the binary, so the container needs nothing extra.

pub struct Starter {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// (project-relative path, contents)
    pub files: &'static [(&'static str, &'static str)],
}

/// Placeholder in starter files replaced with the configured PocketBase URL at creation time.
pub const POCKETBASE_URL_PLACEHOLDER: &str = "{{POCKETBASE_URL}}";
/// Used when no PocketBase connection is configured (PocketBase's own default address).
pub const DEFAULT_POCKETBASE_URL: &str = "http://127.0.0.1:8090";

pub const STARTERS: &[Starter] = &[
    Starter {
        id: "blank",
        name: "Blank",
        description: "An empty project — describe what you want and build from scratch.",
        files: &[],
    },
    Starter {
        id: "landing",
        name: "Landing page",
        description: "One page with a hero, feature cards, a testimonial and a call to action.",
        files: &[
            ("index.html", include_str!("../starters/landing/index.html")),
            ("styles.css", include_str!("../starters/landing/styles.css")),
            ("script.js", include_str!("../starters/landing/script.js")),
        ],
    },
    Starter {
        id: "multipage",
        name: "Multi-page site",
        description: "Home, About and Contact pages sharing one stylesheet and nav.",
        files: &[
            ("index.html", include_str!("../starters/multipage/index.html")),
            ("about.html", include_str!("../starters/multipage/about.html")),
            ("contact.html", include_str!("../starters/multipage/contact.html")),
            ("styles.css", include_str!("../starters/multipage/styles.css")),
        ],
    },
    Starter {
        id: "webapp",
        name: "Small web app",
        description: "A to-do app that saves to the browser (localStorage) — a base for small tools.",
        files: &[
            ("index.html", include_str!("../starters/webapp/index.html")),
            ("styles.css", include_str!("../starters/webapp/styles.css")),
            ("app.js", include_str!("../starters/webapp/app.js")),
        ],
    },
    Starter {
        id: "pocketbase",
        name: "PocketBase app",
        description: "A notes app that stores data in your PocketBase server (create a `notes` collection).",
        files: &[
            ("index.html", include_str!("../starters/pocketbase/index.html")),
            ("styles.css", include_str!("../starters/pocketbase/styles.css")),
            ("config.js", include_str!("../starters/pocketbase/config.js")),
            ("app.js", include_str!("../starters/pocketbase/app.js")),
        ],
    },
];

pub fn find(id: &str) -> Option<&'static Starter> {
    STARTERS.iter().find(|s| s.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_ids_are_unique_and_static_sites_have_an_entry_point() {
        let mut ids: Vec<_> = STARTERS.iter().map(|s| s.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), STARTERS.len());
        for s in STARTERS.iter().filter(|s| !s.files.is_empty()) {
            assert!(s.files.iter().any(|(p, _)| *p == "index.html"), "{} has no index.html", s.id);
        }
    }

    #[test]
    fn pocketbase_starter_carries_the_url_placeholder() {
        let pb = find("pocketbase").unwrap();
        assert!(pb.files.iter().any(|(_, c)| c.contains(POCKETBASE_URL_PLACEHOLDER)));
    }
}
