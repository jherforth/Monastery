# Monastery - Project Vision

## Core Purpose
A calm, focused, self-hosted sanctuary for AI-assisted coding. Monastery is a fully self-hosted, browser-based AI coding environment where users prompt local or frontier LLMs to generate, edit, run, debug, and deploy full applications. The harness runs as a **standalone service** (Docker-first) and connects to LLM backends over the network.

**Tagline**: "AI's self-hosted sanctuary for coding."

## Key Differentiators
- **Decoupled Architecture**: Harness runs independently of LLM servers. Auto-discovery or manual config for local endpoints (e.g., `http://ollama:11434` or IP:port on LAN).
- 100% self-hosted by default with built-in Self-Hosting Wizard (per ODT).
- Native priority for local models via OpenAI-compatible proxy.
- Deep homelab integrations: Proxmox, Coolify, PocketBase, MQTT, etc.
- Resource-aware and low-overhead: Harness itself is lightweight; offload heavy inference.

## Deployment Flexibility
- Single `docker compose up` for the harness.
- Users run LLMs separately (same host, separate container, or different machine on LAN).
- Wizard helps configure network connections, service discovery (mDNS/Avahi), and proxying.

## Success Metrics
- Match/exceed bolt.diy UX while being lighter and more homelab-native.
- Harness container <1GB RAM idle; works on low-power nodes.
- Seamless connection to Ollama/vLLM/etc. with zero extra config in common setups.
