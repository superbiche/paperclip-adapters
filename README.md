# paperclip-adapters

External adapter pack for [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — adds runtime support for new agent CLIs beyond the builtin set.

Each adapter ships as its own npm package under `@superbiche/*`. They plug into a Paperclip instance via the external adapter plugin system (`POST /api/adapters/install`).

## Packages

| Package | Wraps | Status |
|---|---|---|
| [`@superbiche/cline-paperclip-adapter`](./packages/cline-local) | [Cline CLI 2.x](https://github.com/cline/cline) | v0.1 — smoke-proven, not yet on npm |
| [`@superbiche/qwen-paperclip-adapter`](./packages/qwen-local) | [Qwen Code CLI](https://github.com/QwenLM/qwen-code) | v0.1 — smoke-proven, not yet on npm |

Both adapters declare `sessionManagement` with `supportsSessionResume: true`. Their CLI-native session handles (`cline -T <taskId>`, `qwen -r <sessionId>`) round-trip through Paperclip's `agent_task_sessions` table and resume across heartbeats.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test
```

## Installing an adapter into a Paperclip instance

**Local path (dev / Berceuse smoke):**

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H 'content-type: application/json' \
  -d '{"packageName":"/absolute/path/to/paperclip-adapters/packages/cline-local","isLocalPath":true}'
```

After installing, restart Paperclip so the IIFE path re-loads the module with `sessionManagement` preserved (hot-install still strips it pending a follow-up to [paperclipai/paperclip#4296](https://github.com/paperclipai/paperclip/pull/4296) — see [`docs/authoring-gaps.md`](./docs/authoring-gaps.md)).

**npm (once published):**

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H 'content-type: application/json' \
  -d '{"packageName":"@superbiche/cline-paperclip-adapter"}'
```

## Adapter authoring notes

Gaps in Paperclip's plugin system that affect adapter authors — branches on [`superbiche/paperclip`](https://github.com/superbiche/paperclip), open/upstream PRs, deferred items — live in [`docs/authoring-gaps.md`](./docs/authoring-gaps.md).

## License

MIT
