# OpenCode terminal extensions

This directory contains a native OpenCode v2 server plugin port, built against `@opencode/plugin` 2.0.28. It is an early port of selected workflow behavior from [`narumiruna/pi-extensions`](https://github.com/narumiruna/pi-extensions), not a drop-in conversion of all 34 Pi extensions.

## Install locally

From an OpenCode project, add this directory to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-extensions/opencode/extensions"]
}
```

Or copy the directory to `.opencode/plugins/romm0109-workflow/`. The plugin uses the host's `effect` runtime; keep `effect` external when bundling it. OpenCode's ordinary tool and permission handling remains in effect.

## Current commands and tool

- `/goal <objective>` records an active goal for the current session. `/goal status` inspects it; `/goal clear` removes it. The goal is included in subsequent model context, but the plugin does not autonomously continue or declare completion.
- `/plan on|off|status` adds/removes a read-only planning instruction in subsequent model context. This is advisory; it does not change the active agent or enforce tool permissions.
- `update_progress` records a bounded checklist in the current session and exposes it in subsequent model context.

All state is stored by OpenCode's plugin storage under session-scoped keys. These features do not call an external model or service.

## Coverage and known gaps

See [the parity ledger](./docs/parity.md) for every current manifest extension and the `pi-tui-kit` library. In particular, this package does not port the custom Pi transcript/editor UI, Pi-owned OAuth storage, session continuation machinery, peer networking, cloud sync, or TypeSafe service integration. Several have plausible OpenCode APIs, but need dedicated implementations and host tests before they can be called equivalent.

The plugin API and local install flow follow the [OpenCode v2 plugin guide](https://opencode.ai/v2/docs/build/plugins); this package targets the pinned [OpenCode 2.0.28 declarations](https://www.npmjs.com/package/@opencode/plugin/v/2.0.28).

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

The MIT license and original copyright attribution are retained from the upstream repository.
