# Functional & Non-Functional Requirements

## LLM Connectivity (Key Update)
- **Standalone Mode**: Harness runs independently; connects to external LLM hosts on the same network.
- Model selector with endpoint management: Add/edit/remove servers, test connection, favorite models.
- Default recommendations: Ollama (auto-detect common ports), vLLM, OpenAI-compatible proxies.
- Fallback chaining: Try local first, then frontier if configured.
- Health monitoring: Dashboard shows connected LLM status, estimated context/tokens.

## Core Coding Loop
- Streaming generation, file editing, live preview, sandbox execution.
- Agentic tools aware of homelab context ("deploy this to my Proxmox LXC", "optimize for Jetson").

## Self-Hosting Assistant (ODT)
- Wizard offers paths for the *harness itself* and for generated apps.
- Includes LLM connection templates (e.g., "Run Ollama separately: `docker run -d -p 11434:11434 ollama/ollama` then point harness to it").
- Network-aware scripts (docker network, Traefik/Nginx Proxy Manager integration).

## Non-Functional
- **Lightweight**: Harness container minimal footprint; no GPU required for the orchestrator.
- **Networking**: Robust LAN support, optional mDNS, configurable via env vars or UI.
- **Security**: No unnecessary outbound calls; sandboxed; optional VPN/GlueTun awareness.
- **Offline**: Full functionality once LLM endpoint is reachable locally.

## Stretch
- Automatic LLM service detection and setup guidance.
- Multi-LLM orchestration (route different agents to different backends).
