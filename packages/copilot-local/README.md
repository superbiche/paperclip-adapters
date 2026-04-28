# @superbiche/copilot-paperclip-adapter

External [Paperclip](https://github.com/paperclipai/paperclip) adapter that spawns the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) as a managed employee. Wraps `copilot` as a subprocess, passes the wake prompt via `-p`, parses `--output-format json` JSONL stdout, and persists Copilot's native `sessionId` so Paperclip can resume across heartbeats via `copilot --resume=<sessionId>`.

Ported from [paperclipai/paperclip#2085](https://github.com/paperclipai/paperclip/pull/2085) (tjp2021).

## Status

- v0.1.0 — initial port. Tier-1 direct-call smoke harness passes; Tier-2 paperclip-dev integration pending.
- 54 unit tests covering JSONL parse, transcript parse, error detection, and stale-session retry.
- `supportsSessionResume: true`, `nativeContextManagement: "confirmed"`. Resume verified via Copilot CLI's `--resume=<id>` flag.
- Subscription billing (`costUsd: null`); premium-request count tracked separately on `usage`.

## Prerequisites

1. **Install Copilot CLI** on the host running Paperclip:
   ```bash
   npm i -g @githubnext/github-copilot-cli
   copilot --version    # verify >= 1.0.12
   ```
2. **Authenticate.** Pick one:
   - **Interactive (preferred for local dev):** `copilot login` (device flow)
   - **Token (preferred for K8s/CI):** export `GH_TOKEN` (or `GITHUB_TOKEN`) on the Paperclip host, or pass it through `adapterConfig.env`. Copilot CLI honors both.
3. **Subscription.** Any tier with Copilot CLI access (Individual / Business / Enterprise / trial).

## Install

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H 'content-type: application/json' \
  -d '{"packageName":"@superbiche/copilot-paperclip-adapter"}'
```

Restart Paperclip once after install if you're on a release pre-`v2026.423.0-canary.2`.

## Local development

```bash
git clone https://github.com/superbiche/paperclip-adapters
cd paperclip-adapters
pnpm install
pnpm -C packages/copilot-local build
pnpm -C packages/copilot-local test
```

## Agent config

Create a Paperclip agent with `adapterType: "copilot_local"`. Minimum:

```json
{
  "adapterType": "copilot_local",
  "adapterConfig": {
    "command": "copilot",
    "model": "claude-sonnet-4.6",
    "timeoutSec": 600
  }
}
```

Full config surface is documented in the adapter's `agentConfigurationDoc` — exposed via `GET /api/adapters/copilot_local` on a Paperclip instance that has the adapter installed.

### Auth limitations (v0.1)

This release does **not** ship a first-class auth resolution chain. The adapter spawns `copilot` and inherits whatever auth state the host has. Future releases may stack:

- BYOK + GHE + token-fingerprint cache (see [paperclipai/paperclip#3629](https://github.com/paperclipai/paperclip/pull/3629))
- PAT → `gh auth token` → pre-fetched token resolution chain (see [paperclipai/paperclip#3246](https://github.com/paperclipai/paperclip/pull/3246))

## License

MIT. See [`LICENSE`](./LICENSE).
