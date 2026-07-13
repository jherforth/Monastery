# Coding Workflow — Tasks, Stages & Gates

Monastery's **staged coding workflow** turns the chat from a single-shot "dump the whole repo and
hope" loop into a disciplined, token-frugal pipeline. It's inspired by safe-agentic-workflow (SAW),
distilled to a solo/homelab shape and kept **local-first** — all state lives in your project as
plain files.

> **Why it exists:** the old chat sent your *entire project* into every message, which exhausts the
> context window (fatal for local models) and burns cloud tokens. A task scopes context to a spec +
> the files that matter, and structures *how* work gets done.

---

## What a task is

A **task is one discrete piece of work** you create on demand — a feature, a bug fix, a refactor,
some tests, a new endpoint. It is **not** a fixed category you pick from a catalog; you make a task
whenever you start a new piece of work and give it a title (the outcome).

Each task moves through four stages with **gates** between them:

```
Plan ──▶ Implement ──▶ Verify ──▶ Review ──▶ Done
spec.md   scoped edits   build/test   vs AC/DoD   HITL approve
  ▲ gate: AC/DoD exist        ▲ gate: evidence exit 0      ▲ gate: you approve
       └────────── Verify failure routes back to Implement ──────────┘
```

| Stage | Role | What happens | Gate to leave it |
|---|---|---|---|
| **Plan** | 🏗️ Architect | Drafts `spec.md`: Goal, **Acceptance Criteria**, **Definition of Done**, Affected Files, Approach | AC + DoD are filled in |
| **Implement** | 💻 Coder | Edits only the affected files, working to the spec | — |
| **Verify** | 🧪 Tester/QAS | Runs your build/test command; stores the log as **evidence** | A passing run (exit code 0) |
| **Review** | 🔍 Reviewer + you | Checks the diff against AC/DoD | **You** click Approve (human-in-the-loop) |

The task's **Affected Files** list *is* the working set — it's what gets included in context, so the
model stays focused and the prompt stays small.

---

## Using it

The **🛠 Workflow** strip sits just above the chat input. Click to expand.

1. **New task** — type a title, pick a **template** (see below), click **New**. The spec is seeded.
2. **Run Plan** — the Architect fills out `spec.md`. Edit it inline and **Save spec** if you like.
   The *AC/DoD ready* badge turns green once criteria exist — that unlocks Implement.
3. **Run Implement** — the Coder makes focused edits to the affected files. Returned code blocks are
   applied to your project as usual.
4. **Mark ready for verify → Run verify** — runs the build/test command in your project and records
   a pass/fail with a saved log. A green run unlocks Review. A red run routes back to Implement.
5. **Review → Approve & done** — review against AC/DoD, then approve.

Each transition is recorded as an **exit state** (chain of custody) you can see in the panel.

### Context discipline (the token win)
- **Small projects** (≤64KB of source, ~16K tokens) still send everything — including your live
  editor buffer for the open file, unsaved edits and all.
- **Large projects** send only the **file tree** (names) + the **active file** + the **working set**
  (the spec's affected files + anything pulled in). The model has two tools to grow that set
  mid-turn, and both are **auto-fed back** (capped rounds, honoring the auto-continue toggle):
  - `@read path/to/file` — fetches a file's current on-disk contents.
  - `@search <text or identifier>` — greps the whole project (ripgrep server-side) and returns
    `path:line` matches; used when neither the user nor the model knows *which* file matters
    ("fix the login button"), then it `@read`s what it found.
- **Filename mentions work too**: if the user's message names a file that exists in the tree
  ("center the nav in styles.css"), it's included in that request's context and persisted to the
  working set — no `@read` round needed.
- The scoped-mode instructions **forbid writing a file the model hasn't seen** — it must
  `@search`/`@read` first — which prevents the model from "confidently rewriting" files it never read.
- **Editing a section vs. replacing a file**: to change part of an existing file the model emits
  `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` hunk(s) inside a path-tagged block, applied in place
  (`/files/edit`) so the rest of the file is untouched. A path-tagged block WITHOUT those markers
  replaces the whole file (create/rewrite). The backend **refuses** a whole-file block that is just
  a slice of the existing file — the failure mode where a model emitted only the edited section and
  wiped the rest. The chat feedback distinguishes "✅ Wrote" (whole file) from "✏️ Edited (N hunks)".
- **Freshness invariant:** the context map is updated on every write path (AI code blocks, manual
  editor saves, shell commands trigger a full re-read), and older assistant code blocks in chat
  history are collapsed to placeholders — the system context is the *single source of truth* for
  current file contents.

### The workflow nudge
When a freeform message lands on a large project with **no active task**, the chat shows a one-time
tip explaining that the staged workflow scopes context better, with a **"Create a task for this &
plan it"** button — one click creates the task (titled from the message) and immediately runs the
Architect's Plan stage. Shown at most once per session; ignoring it changes nothing.

### Hybrid execution (Hermes hand-off)
Every stage has **Run** (your connected LLM) and, when a Hermes agent is configured, **Hand to
Hermes** — same scoped context + stage prompt, run by the agent. Use it for autonomy on a single
stage while keeping control of the rest.

### Roles vs. stages
The chat's **agent role chips** (under the Agent-mode toggle) and the workflow **stages** are the
same roles at two ceremony levels. Role chips are the *quick, ad-hoc lens* for one-off messages
("review this") with no task, spec, or gates. The workflow is the *structured* path. To avoid two
parallel "pick a role" controls, the chip row is **contextual**: with **no active task** it shows
the full set (Review, Plan, Test, Docs, Implement, Deploy); once a **task is active**, the stage
roles (Plan/Implement/Verify/Review) are driven from the Workflow panel and the chip row shows only
the extras the workflow doesn't cover — **Docs** and **Deploy**.

### Verify command
Verify defaults to `npm run build`. For other stacks set a `verify_command` on the task (e.g.
`cargo test`, `pytest`, `npm test`). Allowed prefixes include npm/npx/pnpm/yarn/node, cargo, python,
pytest, go, make, tsc, jest, vitest.

---

## Task templates

When creating a task you pick a **template** that seeds `spec.md` with the right shape for that work
type (you don't have to write the structure each time):

| Template | Seeds |
|---|---|
| ✨ **Feature** | User-story AC; DoD: build + tests + no regressions |
| 🐛 **Bug fix** | Reproduction, **Root cause**, **Regression test** in DoD |
| 🧹 **Refactor** | "No behavior change" invariant; existing tests still pass |
| 🧪 **Add tests** | What to cover, edge cases, target files |
| 🔌 **New API endpoint** | Route, request/response, validation, auth, error cases |
| 🧩 **New UI component** | Props, states, accessibility, styling consistency |
| 🗄️ **Pocketbase CRUD** | Collection/fields + CRUD AC (only shown when a Pocketbase connection is configured; auto-enables the Pocketbase skill) |

Templates only seed the spec — the task is still yours to shape. (Generic templates never force a
backend skill; only the Pocketbase template opts in.)

---

## Where state lives (local-first)

Everything is plain files in your project, so it's transparent and version-controlled:

```
<project>/.monastery/tasks/<task-id>/
├── spec.md        # the system of record (goal + AC/DoD + affected files + approach)
├── task.json      # stage + exit-state chain + verify command
└── evidence/      # verify-<timestamp>.log — build/test output
```

No cloud, no external system of record. Commit `.monastery/` to keep the history with your code (or
gitignore `evidence/` if you find the logs noisy).

---

## Related

- [Agents](AGENTS.md) — Hermes integration and the role lenses the stages build on.
- Skills live in `packages/web-ui/src/lib/skills.ts`; templates in
  `packages/web-ui/src/lib/taskTemplates.ts`; the task store in `crates/harness-api/src/handlers.rs`.
