# HomeLab AI Harness - Project Vision

## Core Purpose
A fully self-hosted, browser-based AI coding environment where users prompt frontier/local LLMs to generate, edit, run, debug, and deploy full applications. Optimized for homelab enthusiasts: low-resource (Jetson Orin Nano, Proxmox LXC, ARM), offline-first, privacy-first, and extensible for personal infrastructure.

**Tagline**: "Prompt → Code → Run → Deploy to Your Homelab — Zero Cloud Required."

## Key Differentiators from bolt.diy/bolt.new
- 100% self-hosted by default (no Vercel push as primary path).
- Native support for local models (Ollama, llama.cpp, vLLM) with unified OpenAI-compatible proxy.
- Built-in Self-Hosting Wizard (per attached ODT): Detect stack → Generate docker-compose + Coolify/PocketBase configs → One-click VPS/homelab deploy.
- Deep homelab integrations: MQTT (HA), Proxmox API, Meshtastic nodes, custom hardware (ESP32 sensors, etc.).
- Agentic workflows for infrastructure-as-code (Terraform/Ansible-like via LLMs).
- Resource-aware: Auto-optimize for CPU/GPU, quantization, low-power modes.
- Sandboxed execution with strong isolation for LLM-generated code.

## Success Metrics
- Match or exceed bolt.diy UX: Streaming prompts, Monaco editor, live preview, file sync, Git integration.
- Run comfortably on consumer homelab hardware (≤16GB RAM, GPU optional).
- Wizard reduces self-host setup time to <10 minutes for common stacks.
- 90%+ offline capability for core coding loop.
