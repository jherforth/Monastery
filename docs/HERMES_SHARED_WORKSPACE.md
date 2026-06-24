# Hermes Shared Workspace — Seeing Hermes's Files in Monastery

By default, when Hermes does agent work it writes files into **its own** workspace — not your
Monastery project — so Monastery's file tree can't see them. This guide sets up a **shared
workspace** so Hermes writes directly into your Monastery project, where you can view, edit, and
commit the results.

---

## Why this is needed

- **Hermes writes to `terminal.cwd`.** Hermes's `write_file` tool roots paths at its configured
  working directory (`terminal.cwd` in `~/.hermes/config.yaml`, default = wherever Hermes runs),
  which is why you see things like `.hermes/plans/…` on the Hermes side.
- **Monastery reads `data_dir/{project}`.** Monastery's editor and file tree only show files under
  its project directory (in Docker: `/app/data/<project>`).
- These are **different directories**, so Hermes's output is invisible to Monastery until you point
  them at the **same** place on a shared filesystem.

> Note: reconstructing Hermes's writes from the chat stream isn't possible — Hermes's streaming API
> reports only tool *name/status*, not file path/content. The shared workspace is the bridge.

---

## The bridge: point Hermes at the Monastery project directory

Monastery stores each project at **`/app/data/<project-name>`** inside its container
(`DATA_DIR=/app/data`; the default outside Docker is `./data`). The goal is to make that path
**also** Hermes's working directory, on a filesystem both can see.

### Three things to know about the `nousresearch/hermes-agent` image

1. **`/opt/data` is Hermes's *home* dir** (`HERMES_HOME` — config.yaml, sessions, skills), **not**
   the project workspace. Leave it mounted as-is; add a **separate** mount for projects.
2. The image sets **`HERMES_WRITE_SAFE_ROOT=/opt/data`**, which **restricts `write_file` to
   `/opt/data`**. To let Hermes write into the shared project mount you **must override** this.
3. With **`HERMES_DASHBOARD=1` + a non-loopback bind + no auth provider**, Hermes raises a fatal
   error and the **whole gateway (API included) won't start**. Disabling the dashboard avoids it
   (the API stays protected by `API_SERVER_KEY`).

### Step 1 — Pick a shared host directory

Use a host folder both containers mount, e.g. **`/apps/monastery/data`**. Projects will live at
`/apps/monastery/data/<project>` on the host.

### Step 2 — Point Monastery at it (host bind-mount) + migrate existing data

In Monastery's `docker-compose.yml`, replace the named volume with the bind-mount:
```yaml
services:
  harness:
    volumes:
      - /apps/monastery/data:/app/data        # was: harness_data:/app/data
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - DATA_DIR=/app/data
# remove the top-level `volumes: { harness_data: ... }` block once migrated
```
Copy your existing projects out of the old named volume first:
```bash
docker volume ls | grep harness_data     # find the real name, e.g. monastery_harness_data
docker run --rm -v monastery_harness_data:/from -v /apps/monastery/data:/to \
  alpine sh -c "cp -a /from/. /to/"
```

### Step 3 — Mount the same host dir into Hermes + set the write root

Add a **second** volume to Hermes at `/workspace` (keep `/opt/data` for Hermes's own home), and set
the agent's working dir + safe root to it. Disable the dashboard:
```yaml
services:
  hermes:
    image: nousresearch/hermes-agent:latest
    command: gateway run
    ports:
      - "8642:8642"                          # API only; dashboard port removed
    volumes:
      - /apps/hermes/data:/opt/data          # Hermes home — unchanged
      - /apps/monastery/data:/workspace      # SAME host dir Monastery uses
    environment:
      - HERMES_DASHBOARD=0                    # avoid the auth-gate startup failure
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
      - API_SERVER_ENABLED=true
      - API_SERVER_HOST=0.0.0.0
      - API_SERVER_KEY=${API_SERVER_KEY}
      - TERMINAL_CWD=/workspace/<project-name>     # where the agent writes
      - HERMES_WRITE_SAFE_ROOT=/workspace          # OVERRIDE the image default (/opt/data)
```

Now Hermes's `write_file` writes to `/workspace/<project>` = `/apps/monastery/data/<project>` =
Monastery's `/app/data/<project>` — the same files.

### Step 4 — Order of operations

Create the project in **Monastery first** (so `/apps/monastery/data/<project>` exists — `TERMINAL_CWD`
must point at an existing directory, or Hermes silently falls back to its own dir). Then start Hermes
with `TERMINAL_CWD` set to that project.

---

## Using it

1. In Monastery, select (or create) the project whose directory you pointed Hermes at.
2. Work with Hermes (via Monastery's Agent mode, or Hermes's own CLI) — it writes into the shared dir.
   Monastery's chat also shows Hermes's tool steps (e.g. `🔧 Hermes is running tool write_file…`).
3. Back in Monastery, click the **Refresh** button in the **Files** sidebar toolbar (or just refocus
   the window) to re-read the project from disk — Hermes's new/changed files appear in the tree and
   open in the editor.
4. Review, then **Commit & Push** as usual to persist them to your git repo.

---

## Caveats & safety

- **One project at a time.** `TERMINAL_CWD` is a single value (not a per-request parameter on the
  standard `/v1/chat/completions` API), so Hermes targets **one** project until you change it and
  restart — or set it in `/opt/data/config.yaml`:
  ```yaml
  terminal:
    cwd: /workspace/<project-name>
  ```
  (The `project_path` Monastery sends to `/api/hermes/run` is currently informational — Hermes ignores it.)
- **Write root must include the workspace.** The image defaults `HERMES_WRITE_SAFE_ROOT=/opt/data`,
  which blocks writes to `/workspace`. Override it (to `/workspace`, or a specific project dir) or
  Hermes will refuse to write your files.
- **Same underlying directory, possibly different container paths.** With the bind-mount, Monastery
  sees `/app/data/<project>` and Hermes sees `/workspace/<project>` — both map to host
  `/apps/monastery/data/<project>`. Point `TERMINAL_CWD` at whichever path *Hermes itself* sees.
- **File ownership.** Monastery (Rust) and Hermes may run as different UIDs; if you hit permission
  errors on the shared dir, `chown`/`chmod` it so both can read/write (homelab-acceptable).
- This is a filesystem bridge only. Tighter coupling (Hermes's API accepting a per-request project
  path, or Monastery driving Hermes's tool loop) is future work.
