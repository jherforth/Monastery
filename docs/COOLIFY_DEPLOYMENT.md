# Coolify Deployment — Requirements & Setup

How Monastery deploys your project to a self-hosted **Coolify** instance, what your
homelab needs to have in place first, and how updates work.

---

## How it works

Monastery deploys your app to Coolify **from your git repository**, not by uploading
files. On deploy it:

1. Commits and pushes a generated `Dockerfile` to your project's forge repo (Forgejo,
   Gitea, GitLab, GitHub) so the repo is self-contained and reproducible.
2. Tells Coolify to **clone that repo** and build the Dockerfile.
3. Remembers the created app, so future deploys **redeploy the same app** instead of
   creating a new one each time.

Because Coolify clones the repo, your real source (your `index.html`, app code, etc.)
is present in the build — which is what makes the site actually serve.

> **Why git-based?** An inline Dockerfile has no build context, so `COPY . .` copies
> nothing and the site serves an empty directory listing ("Index of /app/"). Cloning
> the repo is what carries your source into the build.

---

## Prerequisites

### 1. Your forge must be reachable by Coolify over HTTPS, at a real hostname

Coolify validates the git URL and **rejects** repositories whose host is:

- a raw IP address (e.g. `192.168.1.10`)
- `localhost` / `127.0.0.1`
- any hostname ending in **`.local`** (e.g. `forgejo.local`)

So your forge needs a **real hostname** that the Coolify host can resolve and reach.
Internal DNS is fine — these all pass:

| ✅ Works | ❌ Rejected |
|---|---|
| `https://git.home.arpa` | `https://192.168.1.10` |
| `https://git.lan.example.com` | `https://forgejo.local` |
| `https://git.mydomain.com` | `http://localhost:3000` |

A reverse proxy (nginx, Caddy, Traefik) in front of your forge is the usual way to get
this in a homelab.

### 2. The TLS certificate must be trusted by the Coolify host

Coolify clones over HTTPS, so the build environment has to trust your forge's cert:

- **Public-CA cert** (e.g. Let's Encrypt via DNS-01 on your internal domain) — just works.
- **Self-signed / private-CA cert** — `git clone` will fail unless that CA is installed
  and trusted on the **Coolify host**. Either trust the CA there, or use a public-CA cert.

### 3. Network reachability

Whatever machine runs Coolify must be able to resolve the hostname and route to the
forge. If Coolify runs on a VPS and the forge is only on your home LAN, the VPS cannot
reach it — keep them on the same network/DNS, or expose the forge appropriately.

### 4. The project must be pushed to a forge

Monastery deploys from the repo, so the project needs a git remote (`origin`) and a
configured forge connection (**Settings → Git**) whose token Monastery reuses to clone.
The remote URL must use the HTTPS hostname from requirement #1 — **not** an IP or
`.local`. If your `origin` currently points at an IP, repoint it at the hostname.

---

## Authentication

Monastery reuses the **token from your existing forge connection**. It builds an
authenticated clone URL of the form:

```
https://oauth2:<token>@git.yourhost/you/your-repo.git
```

and hands that to Coolify. No SSH deploy keys to manage. The token is stored in Coolify's
app configuration (acceptable for a local/homelab trust model).

---

## Updating a deployed app

Once deployed, updates go to the **same** Coolify app:

1. Refine your app in Monastery.
2. Commit & push to your forge (the normal flow).
3. Deploy again — Monastery detects the existing app for this project and triggers a
   **redeploy in place** (Coolify re-clones and rebuilds the latest commit). The wizard
   shows *"Redeployed existing app"* rather than *"App created"*.

Monastery tracks this with a per-project mapping (`project → Coolify app UUID`), so you
never accumulate duplicate apps from repeated deploys.

---

## Choosing the deploy server

If your Coolify has more than one server, the Self-Host Wizard shows a **Deployment
Server** dropdown. Notes:

- The built-in **localhost** server is the Coolify host itself — deploying there runs the
  app on the Coolify box (and may collide with whatever already serves port 80). To deploy
  to a VPS/remote, pick that server.
- Monastery preselects a usable, non-localhost server by default.

---

## Cloudflare Tunnel (optional)

If you supply a Cloudflare Tunnel token, Monastery launches a `cloudflared` connector as a
sidecar Coolify **Service** (host networking) and publishes the app's port on the host.

One manual step remains, because token tunnels are **remotely managed**: in the Cloudflare
Zero Trust dashboard → Networks → Tunnels → your tunnel → **Public Hostname**, set the
**Service** to:

```
http://localhost:<port>
```

(The wizard prints the exact URL.) Never point it at the public HTTPS URL — that loops back
out through Cloudflare.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Site shows **"Index of /app/"** with only `Dockerfile` / `docker-compose.yaml` | Source never reached the build (old inline-Dockerfile method, or repo wasn't cloned) | Ensure you're on the git-based deploy and the repo actually contains your source |
| Coolify rejects the deploy with a git URL validation error | Forge host is an IP, `localhost`, or `.local` | Put the forge behind a real HTTPS hostname (Prereq #1) |
| `git clone` fails in the Coolify build log with a TLS/cert error | Coolify host doesn't trust the forge's cert | Use a public-CA cert, or trust the private CA on the Coolify host (Prereq #2) |
| Clone fails with auth/403 | Token can't access the repo, or Coolify didn't use the embedded credentials | Verify the forge token has repo read access; confirm the repo is reachable with the token |
| App deployed to the wrong machine / domain hits something else | Deployed to the localhost (Coolify host) server | Pick the correct remote server in the wizard and redeploy |
| A new app is created every deploy | Project→app mapping missing | Expected only on the **first** deploy; subsequent deploys reuse it automatically |

---

## Notes & limitations

- **Dokploy** deployments currently still use the older inline-Dockerfile path and do not
  yet share this git-based flow.
- The generated `Dockerfile` is committed to your repo on first deploy (consistent with how
  Monastery already commits your work, and it makes the repo independently deployable).
