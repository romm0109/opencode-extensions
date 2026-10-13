# Open questions

- Can the v2 public API enforce plan-mode read-only permissions while preserving normal host prompts, or should the port use the built-in Plan agent explicitly?
- Which OpenCode CLI session-attachment contract can safely launch a child in tmux, Zellij, or Ghostty while preserving Fleet's terminal-process behavior?
- Can child request-response state survive plugin reload using only public server APIs, without moving coordination messages into model context unexpectedly?
- Can OpenCode expose a prompt-editor insertion API for direct answer insertion? Until then, session coordination uses an explicit synthetic transcript message.
- Which OpenCode session API can enforce per-child tool restrictions while preserving the host's normal permission behavior?
- For provider integrations, which credentials and quota APIs can be used without changing global or session ownership semantics?
- For external sync and networking, what explicit transport configuration and conflict behavior should the OpenCode port support?

## Last updated

2026-10-13
