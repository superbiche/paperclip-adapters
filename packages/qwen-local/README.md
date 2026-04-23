# @superbiche/qwen-paperclip-adapter

External [Paperclip](https://github.com/paperclipai/paperclip) adapter that spawns the [Qwen Code CLI](https://github.com/QwenLM/qwen-code) as a managed employee. Wraps `qwen` as a subprocess, pipes the wake prompt via positional argument, parses its `stream-json` output, and persists the native `session_id` so Paperclip can resume the same Qwen conversation across heartbeats via `qwen -r <sessionId>`.

## Origin and attribution

The runtime of this adapter — `src/server/execute.ts`, `src/server/parse.ts`, `src/server/skills.ts`, `src/server/test.ts`, and the supporting utilities — was **originally authored by [Alex Ivanov (@oshliaer)](https://github.com/oshliaer)** in upstream PR [paperclipai/paperclip#1490](https://github.com/paperclipai/paperclip/pull/1490) as an in-tree `packages/adapters/qwen-local` package.

After PR [paperclipai/paperclip#2218](https://github.com/paperclipai/paperclip/pull/2218) shipped the external adapter plugin system, the ecosystem direction shifted toward third-party adapter packages over in-tree additions. With @oshliaer's blessing on PR [paperclipai/paperclip#4241](https://github.com/paperclipai/paperclip/pull/4241) (the rebase branch that became the scaffold for this release), the adapter moved out of the monorepo and into this external package.

The external-plugin port — `src/server/index.ts` factory exposing `createServerAdapter()`, `sessionManagement` declaration, inlined self-contained `src/ui-parser.ts`, stand-alone `tsconfig.json`, and the workspace packaging — was done by [@superbiche](https://github.com/superbiche) / [@tsbwc](https://github.com/tsbwc). Smoke-tested end-to-end on [`superbiche/paperclip`](https://github.com/superbiche/paperclip)'s `fix/external-session-management` branch.

## Status

- v0.1.2 on npm as [`@superbiche/qwen-paperclip-adapter`](https://www.npmjs.com/package/@superbiche/qwen-paperclip-adapter).
- Session resume (`qwen -r <id>`) proven: after two consecutive heartbeats, Paperclip persists the Qwen session in `agent_task_sessions` and the adapter reuses it. Qwen's own `usage.sessionReused: true` confirms the resume.
- `supportsSessionResume: true`, `nativeContextManagement: "confirmed"`. Full session-management parity landed via [paperclipai/paperclip#4296](https://github.com/paperclipai/paperclip/pull/4296) (IIFE path) and [#4324](https://github.com/paperclipai/paperclip/pull/4324) (hot-install path); both are in master and ship in `canary/v2026.423.0-canary.2` and the next stable tag.

## Install

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H 'content-type: application/json' \
  -d '{"packageName":"@superbiche/qwen-paperclip-adapter"}'
```

On paperclip built from master commit `3d15798` or later (i.e. `canary/v2026.423.0-canary.2` or the next stable), hot-install picks up `sessionManagement` without a restart. On older releases (`v2026.416.0` and prior, pre-#4324), restart Paperclip once after install so the IIFE path can register it.

## Local development

```bash
git clone https://github.com/superbiche/paperclip-adapters
cd paperclip-adapters
pnpm install
pnpm -C packages/qwen-local build
```

## Agent config

Create a Paperclip agent with `adapterType: "qwen_local"` and an `adapterConfig` object. Minimum:

```json
{
  "adapterType": "qwen_local",
  "adapterConfig": {
    "command": "qwen",
    "env": {
      "DASHSCOPE_API_KEY": { "type": "plain", "value": "..." }
    },
    "timeoutSec": 300
  }
}
```

Authentication: Qwen OAuth (`qwen auth qwen-oauth`), Alibaba Cloud Coding Plan, or a DashScope API key. Qwen Code also reads `~/.qwen/settings.json` for provider configuration (including non-DashScope OpenAI-compatible backends such as local `llama.cpp` endpoints). See [Qwen Code CLI docs](https://github.com/QwenLM/qwen-code) for the full auth matrix.

Full config surface is documented in the adapter's `agentConfigurationDoc` — exposed via `GET /api/adapters/qwen_local` on a Paperclip instance that has the adapter installed.

## License

MIT. See [`LICENSE`](../../LICENSE) at the repo root.
