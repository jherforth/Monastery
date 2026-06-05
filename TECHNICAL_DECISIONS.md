# Key Technical Decisions

## Language & Runtime
- Rust primary (performance, safety, small binaries for homelab).
- Python for AI depth.
- Avoid heavy Electron; prefer lightweight web (Leptos) or Tauri desktop option.

## Model Integration
- OpenAI-compatible endpoint unification.
- Auto-quantization & context management based on hardware detection.

## Storage & Isolation
- Browser FS + server sync.
- Strict sandbox for generated code (seccomp, namespaces, or WASM).

## Self-Host Focus
- All templates Docker-first.
- Integration with Coolify APIs where available; fallback scripts.
