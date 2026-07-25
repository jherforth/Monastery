# Coolify Deployment — Requirements & Setup

How Monastery deploys your project to a self-hosted **Coolify** instance, what your
homelab needs in place first, and how updates work.

---

## How it works (clone-at-build)

Monastery deploys to Coolify using an **inline Dockerfile that clones your repository at
build time**. On deploy it:

1. Detects your project's framework and generates a Dockerfile whose first step is a
   `git clone` of your forge repo (using your existing forge token).
2. Sends that Dockerfile to Coolify, which builds it on your chosen deploy server.
3. During the build, the deploy server clones your repo — so your real source (your
   `index.html`, app code, etc.) ends up in the image and the site actually serves.
4. Remembers the created app, so future deploys **redeploy the same app** instead of
   creating a new one.

> **Why clone-at-build instead of letting Coolify clone?** Coolify's own git flows only
> support SSH deploy keys or provider OAuth apps (GitHub/GitLab). Given an arbitrary
> self-hosted URL it strips the host down to `owner/repo` and tries to clone over SSH,
> which fails for a self-hosted Forgejo. Cloning *inside the Docker build* sidesteps all of
> that: it's a plain `git clone` on your deploy server, with **no host/URL restrictions** —
> so IP addresses, `.local` hostnames, and self-signed certs all work. This keeps Monastery
> true to its all-local design.

---

## Prerequisites

### 1. The deploy server must be able to reach your forge

The `git clone` runs **on the Coolify deploy server you select in the wizard**. That server
must be able to resolve and reach your forge over the network. In an all-local setup where
Coolify and Forgejo are on the same LAN, this just works. Any address form is fine —
`https://git.home.arpa`, `http://192.168.1.10:3000`, `https://forgejo.local` — there's no
hostname validation, because Coolify isn't the one cloning.

### 2. Self-signed TLS is fine

The in-build clone runs with TLS verification **disabled** (`http.sslVerify=false`), so a
self-signed or private-CA cert on your forge will not block the clone. (HTTP-only forges
work too.) This is a deliberate trade-off for local/homelab use.

### 3. The project must be pushed to a forge

Monastery clones from the repo, so the project needs a git remote (`origin`) and a
configured forge connection (**Settings → Git**) whose token it reuses. Push your work to
the forge before deploying (the normal Monastery flow does this).

---

## Authentication & security note

Monastery reuses the **token from your existing forge connection**, embedded in the clone
URL the Dockerfile uses:

```
git clone https://oauth2:<token>@<your-forge>/you/your-repo.git
```

The Dockerfile removes the cloned `.git` directory afterward, but **the token does appear in
the Coolify build log and image build history**. For a private homelab this is an acceptable
trade-off; do not use this flow to deploy to an untrusted or shared Coolify instance.

---

## Updating a deployed app

Updates go to the **same** Coolify app:

1. Refine your app in Monastery.
2. Commit & push to your forge (the normal flow).
3. Deploy again — Monastery detects the existing app for this project and triggers a
   **forced, no-cache redeploy** (`/deploy?uuid=…&force=true`), so the in-Dockerfile clone
   re-fetches the latest commit. The wizard shows *"Redeployed existing app"*.

Monastery tracks this with a per-project mapping (`project → Coolify app UUID`), so repeated
deploys never pile up duplicate apps.

**Deleted the app in Coolify?** No problem — just deploy again from Monastery. If the tracked
app no longer exists (Coolify returns 404), Monastery forgets the stale mapping and
automatically **creates a fresh app**. You don't need to clear anything by hand.

---

## Choosing the deploy server

If your Coolify has more than one server, the Self-Host Wizard shows a **Deployment Server**
dropdown:

- The built-in **localhost** server is the Coolify host itself — deploying there runs the app
  on the Coolify box (and may collide with whatever already serves port 80). Pick a remote
  server to deploy to a VPS/other host.
- Monastery preselects a usable, non-localhost server by default.
- Whichever server you pick is the one that must reach your forge (Prereq #1).

---

## Cloudflare Tunnel (optional)

If you supply a Cloudflare Tunnel token, Monastery launches a `cloudflared` connector as a
sidecar Coolify **Service** (host networking) and publishes the app's port on the host.

### Automated routing (recommended)

Connect **Cloudflare** in Settings → Hosting (an API token with **Account → Cloudflare
Tunnel: Edit** and **Zone → DNS: Edit**). Then, whenever a deploy specifies a domain and a
tunnel, Monastery configures the routing itself via the Cloudflare API:

- adds/updates the tunnel **Public Hostname** ingress rule (`your-domain → http://127.0.0.1:<host_port>`), and
- creates/updates the proxied **CNAME** (`your-domain → <tunnel-id>.cfargotunnel.com`).

No Zero Trust dashboard steps. Routing failures never fail the deploy — the wizard shows the
error plus the manual instructions below as fallback. (Locally-managed config-file tunnels
ignore remote config; use a token tunnel for automation.)

### Manual routing (fallback)

Token tunnels are **remotely managed**: in the Cloudflare Zero Trust dashboard → Networks →
Tunnels → your tunnel → **Public Hostname**, set the **Service** to:

```
http://127.0.0.1:<host_port>
```

(The wizard prints the exact URL.) Use **127.0.0.1, not `localhost`** — cloudflared resolves
`localhost` to IPv6 `::1`, but the published port binds IPv4, so `localhost` gives
"connection refused". Never point it at the public HTTPS URL — that loops back out through
Cloudflare.

### Multiple sites behind one tunnel

One tunnel (and one connector per server) fronts **any number of sites across any number of
domains** in the same Cloudflare account:

- Every app Monastery deploys gets its **own stable host port** (recorded in the deploy
  manifest), published on the server — so a host-networked connector reaches each app at
  `http://127.0.0.1:<that app's host_port>`.
- To add another site: deploy it with the tunnel toggle **off** (a second connector is
  unnecessary), then add one Public Hostname per site — or let the Cloudflare connection do
  it automatically. The wizard prints each app's service URL even when the tunnel toggle is
  off.
- Per-app `{app}-cloudflared` sidecars from earlier tunnel-on deploys are legal duplicates
  (Cloudflare treats them as replica connectors of the same tunnel). Keep one and remove the
  rest, or leave them.
- **Different-server caveat:** a connector reaches `127.0.0.1` ports only on its *own*
  server. An app on a different server needs that server's LAN IP as the Service target, or
  its own connector.

---

## The deploy manifest — `.monastery/deploy.json`

The first deploy writes a small identity file into the project (commit it — it contains no
secrets, only identifiers):

- `deploy_id` — stable unique id; also embedded in the platform app's description as
  `monastery-deploy-id:<id>`. Another Monastery instance (a collaborator, a rebuilt DB)
  deploying the same repo **adopts** the existing platform app instead of creating a
  duplicate.
- `targets.<platform>` — app name, tracked branch, the **pinned host port** (stable across
  renames and instances, so tunnel routing keeps working), the domain, and the Cloudflare
  account/tunnel ids (so token-less redeploys can still re-ensure routing).

Merge-conflict rule: keep the **older** `deploy_id`. Deleting the file simply mints a new
identity on the next deploy (a fresh platform app).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build log: `fatal: '…' does not appear to be a git repository` / clone over SSH | Old approach where Coolify itself cloned — should no longer happen | Ensure you're on the clone-at-build build (Monastery sends an inline Dockerfile, not a git URL) |
| Site shows **"Index of /app/"** | The image has no `index.html` at the served root | Confirm your repo has `index.html` at its root (static) or the build output dir is correct |
| Build log: clone fails with auth/403 | Token lacks repo read access, or wrong forge connection matched | Check the forge token's scope in Settings → Git; ensure the connection matches the repo's host |
| Build log: clone fails to connect / DNS | The **deploy server** can't reach the forge | Put them on the same network/DNS, or pick a deploy server that can reach the forge (Prereq #1) |
| App reachable in Coolify but domain hits something else | Deployed to the localhost (Coolify host) server | Pick the correct remote server in the wizard and redeploy |
| Redeploy serves stale code | Build cache reused | Monastery forces `force=true` (no-cache); if you redeploy from Coolify's UI, use its "force rebuild" option |

---

## Notes & limitations

- The clone runs with TLS verification disabled and embeds the token in the build — see the
  security note above. Intended for trusted local/homelab Coolify instances.
- **Dokploy** deployments currently use a different (inline-Dockerfile, no clone) path and do
  not yet share this flow.
- The container port is derived from the framework (e.g. `80` for nginx-served static/React
  builds, the app's port for Node servers) and used for Coolify's port mapping.
