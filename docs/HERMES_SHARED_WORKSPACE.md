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

### Recipe A — Host bind-mount (simplest if Hermes runs on the host)

1. In Monastery's `docker-compose.yml`, change the data volume from the named volume to a **host
   bind-mount** so the files exist on your host:
   ```yaml
   services:
     harness:
       volumes:
         - ./data:/app/data            # was: harness_data:/app/data
   ```
   (Re-create the container; copy any existing project data into `./data` first.)
2. Run Hermes on the host and point it at the project:
   ```yaml
   # ~/.hermes/config.yaml
   terminal:
     cwd: /absolute/path/to/Monastery/data/<project-name>
   ```
   or per-run: `TERMINAL_CWD=/absolute/path/to/Monastery/data/<project-name>`.

### Recipe B — Co-locate Hermes in the same Compose (shared named volume)

Keep the named volume and give Hermes a container that mounts it too:
```yaml
services:
  harness:
    volumes:
      - harness_data:/app/data
  hermes:
    image: <your-hermes-image>
    volumes:
      - harness_data:/app/data        # same volume Monastery uses
    environment:
      - TERMINAL_CWD=/app/data/<project-name>
volumes:
  harness_data:
```

Either way, Hermes's `write_file` now lands in `…/data/<project>`, which **is** your Monastery
project.

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

- **One project at a time.** Hermes's `terminal.cwd` is a single config value (not a per-request
  parameter on the standard `/v1/chat/completions` API), so the shared workspace targets **one**
  project directory until you change the config. (The `project_path` Monastery sends to
  `/api/hermes/run` is currently informational — Hermes ignores it.)
- **Constrain writes.** Set `HERMES_WRITE_SAFE_ROOT` to the project directory so Hermes can't write
  outside it:
  ```
  HERMES_WRITE_SAFE_ROOT=/app/data/<project-name>
  ```
- **Same path on both sides.** Whatever path Monastery sees (`/app/data/<project>`) must be the same
  path Hermes writes to. With a host bind-mount the host path and container path differ — point
  Hermes at whichever path *Hermes itself* sees.
- This is a filesystem bridge only. Tighter coupling (Hermes's API accepting a per-request project
  path, or Monastery driving Hermes's tool loop) is future work.
