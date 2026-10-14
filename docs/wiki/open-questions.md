# Open questions

- Can the v2 public API enforce plan-mode read-only permissions while preserving normal host prompts, or should the port use the built-in Plan agent explicitly?
- Which Pi session orchestration behaviors can be represented with public OpenCode sessions without exposing undocumented internals?
- Which statusline data can the public CLI/TUI API supply for Starship modules that currently render empty, and how much of the Pi statusline settings model can be represented without a custom collector lifecycle?
- How can transcript decoration and editor insertion be represented if OpenCode adds public TUI slots for those behaviors?
- For provider integrations, which credentials and quota APIs can be used without changing global or session ownership semantics?
- For external sync and networking, what explicit transport configuration and conflict behavior should the OpenCode port support?

## Last updated

2026-10-13
