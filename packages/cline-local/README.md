# @superbiche/cline-paperclip-adapter

External [Paperclip](https://github.com/paperclipai/paperclip) adapter that spawns [Cline CLI 2.x](https://github.com/cline/cline) as a managed employee. Wraps `cline` as a subprocess, passes the wake prompt as a positional argument, parses `--json` stdout, and persists Cline's native `taskId` so Paperclip can resume the same task across heartbeats via `cline -T <taskId>`.

## Status

- v0.1.0 on npm as [`@superbiche/cline-paperclip-adapter`](https://www.npmjs.com/package/@superbiche/cline-paperclip-adapter).
- Session resume (`cline -T <id>`) proven: 9 consecutive 30-second-interval heartbeats against the same issue all resumed the same Cline task.
- Watchdog kills the run on hang-prone asks (`followup`, `mistake_limit_reached`, `plan_mode_respond`, `act_mode_respond`) with a structured `cline_hang_prone_ask_<subtype>` error code.
- Event discriminator and token aggregation verified against Cline's own aggregator in `dist/cli.mjs`.
- `supportsSessionResume: true`, `nativeContextManagement: "confirmed"`. Requires [paperclipai/paperclip#4296](https://github.com/paperclipai/paperclip/pull/4296) for `sessionManagement` to survive hot-install without a Paperclip restart; today the IIFE path (post-restart) preserves it.

## Install

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H 'content-type: application/json' \
  -d '{"packageName":"@superbiche/cline-paperclip-adapter"}'
```

Restart Paperclip once after install so the IIFE path picks up `sessionManagement` (tracked as a parity-fix follow-up to paperclipai/paperclip#4296).

## Local development

```bash
git clone https://github.com/superbiche/paperclip-adapters
cd paperclip-adapters
pnpm install
pnpm -C packages/cline-local build
pnpm -C packages/cline-local test
```

## Agent config

Create a Paperclip agent with `adapterType: "cline_local"` and an `adapterConfig` object. Minimum:

```json
{
  "adapterType": "cline_local",
  "adapterConfig": {
    "command": "cline",
    "configDir": "/absolute/path/to/preauth/cline-config",
    "model": "deepseek-chat",
    "timeoutSec": 600
  }
}
```

`configDir` must be a pre-authenticated Cline config directory. Seed once:

```bash
cline auth -p deepseek -k "$DEEPSEEK_API_KEY" -m deepseek-chat \
  --config /absolute/path/to/preauth/cline-config
```

Full config surface is documented in the adapter's `agentConfigurationDoc` — exposed via `GET /api/adapters/cline_local` on a Paperclip instance that has the adapter installed.

## License

MIT. See [`LICENSE`](../../LICENSE) at the repo root.
