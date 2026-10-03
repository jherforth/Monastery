# Working with External Agents

Monastery's chat doesn't route through an agent framework. It's one model with two modes:
**Build**, which writes files, and **Discuss**, which plans. If you also want an autonomous
agent such as Hermes, Claude Code or Aider to work on a project, it joins as **another
contributor to the project's git repo**. Monastery doesn't need to know the agent exists.

> Hermes used to be wired into the chat as an "Agent mode" with role chips. That was hidden in
> simplification Phase 1. It duplicated the chat's job, and the files Hermes wrote with its own
> tools landed in Hermes's workspace instead of the project. See
> [SIMPLIFICATION_PLAN.md](SIMPLIFICATION_PLAN.md), decision D1.

---

## The git bridge

You need a project with a git remote. If it doesn't have one yet, open **History & Ship →
Advanced · Git sync → Create repo on your forge & push this project**.

1. **On the agent's machine, clone the project's repo** and point the agent at the clone. For
   Hermes, that's in `~/.hermes/config.yaml`:
   ```yaml
   terminal:
     cwd: /path/to/clone
   ```
   Give that machine push rights, either a PAT in the remote URL or an SSH key. For the Hermes
   Docker image, also set `TERMINAL_CWD` to the clone, and make sure `HERMES_WRITE_SAFE_ROOT`
   covers it (the image defaults it to `/opt/data`).
2. **Make syncing part of the agent's task.** End the prompt or task template with:
   *"Start by running `git pull`. When complete and verified: `git add -A && git commit -m '<summary>' && git push`."*
3. **In Monastery, watch for the agent's push.** The top-bar **History · Ship** chip shows an amber
   **↓N** once the remote has new commits. Open **History & Ship → Advanced · Git sync → Pull**.
   Monastery takes a snapshot first, rebases your local edits on top, and reloads the files,
   chat context and live preview.

The rhythm to keep: the agent pulls before it starts and pushes when it's done, and you Pull
before editing in Monastery.

---

## Alternative: a shared folder (same machine)

If the agent runs on the same host, it can write straight into Monastery's project folder through
a shared volume. That avoids push/pull, but it's fiddlier: write roots, file ownership, one
project at a time. The full setup for Hermes is in
[HERMES_SHARED_WORKSPACE.md](HERMES_SHARED_WORKSPACE.md). After the agent writes, click
**Refresh** in the Files sidebar, or refocus the window, to pick up the changes.

---

## Caveats

- **Conflicts are reported, not resolved.** If you and the agent both edit the same lines, Pull
  stops with an error. Your work is safe, because Pull takes a snapshot first. Resolve the
  conflict in the clone, or revert to the snapshot.
- **The agent's commits skip Monastery's per-edit snapshots.** You still get the snapshot taken
  before each Pull, which is the restore point for everything the agent changed.
