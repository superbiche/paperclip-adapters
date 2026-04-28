# @superbiche/copilot-paperclip-adapter

External [Paperclip](https://github.com/paperclipai/paperclip) adapter that spawns the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) as a managed employee. Wraps `copilot` as a subprocess, passes the wake prompt via `-p`, parses `--output-format json` JSONL stdout, and persists Copilot's native `sessionId` so Paperclip can resume across heartbeats via `copilot --resume=<sessionId>`.

Built on [paperclipai/paperclip#2085](https://github.com/paperclipai/paperclip/pull/2085) (tjp2021), extended with the auth + dynamic-discovery + skill-injection feature set from [paperclipai/paperclip#3629](https://github.com/paperclipai/paperclip/pull/3629) (HearthCore).

## Status

- v0.1.0 — initial release.
- 128 unit tests cover JSONL parse, transcript parse, error detection, stale-session retry, token resolution, endpoint discovery, model discovery, hostname validation, and session-codec round-trip.
- `supportsSessionResume: true`, `nativeContextManagement: "confirmed"`. Resume verified end-to-end against a paperclip-dev instance + real Copilot CLI 1.0.37.
- Subscription billing (`costUsd: null`); premium-request count tracked separately on `usage`.

## Features

- **Session resume** via Copilot's native `--resume=<sessionId>`. Stale-session detection retries cleanly with a fresh session.
- **BYOK** via `adapterConfig.copilotToken` (paperclip secret), with classic-PAT (`ghp_`) rejection.
- **Auth resolution chain** when no `copilotToken` is set: `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token` CLI fallback. Tunable via `adapterConfig.tokenSource` (`auto` / `env` / `gh_cli`).
- **GitHub Enterprise** support via `adapterConfig.gheHost`. Strict hostname validation rejects malformed values before any side-effect (URLs, schemes, ports, paths, userinfo). When `gheHost` is set, env-token fallback is suppressed (SSRF guard) and `gh auth token --hostname <host>` is used.
- **Dynamic model discovery** via Copilot's `/models` API (with token-fingerprint cache for endpoint discovery). Falls back to a hardcoded `FALLBACK_MODELS` list when offline / no token.
- **Skill injection** via `COPILOT_SKILLS_DIRS`. Paperclip-managed skills are symlinked into a per-cwd cache and exposed to the Copilot CLI ephemerally.

## Prerequisites

1. **Install Copilot CLI** on the host running Paperclip:
   ```bash
   npm i -g @githubnext/github-copilot-cli
   copilot --version    # verify >= 1.0.12 (tested against 1.0.37)
   ```
2. **Authenticate.** Pick one:
   - **Interactive (preferred for local dev):** `copilot login` (device flow)
   - **Token (preferred for K8s/CI):** set `adapterConfig.copilotToken` (BYOK) or export `GH_TOKEN` / `COPILOT_GITHUB_TOKEN` on the Paperclip host
   - **gh CLI:** `gh auth login` once, then leave `tokenSource: "auto"` — the adapter falls back to `gh auth token`
3. **Subscription.** Any tier with Copilot CLI access (Individual / Business / Enterprise / trial / free).

## Install

```bash
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H 'content-type: application/json' \
  -d '{"packageName":"@superbiche/copilot-paperclip-adapter"}'
```

Restart Paperclip once after install if you're on a release pre-`v2026.423.0-canary.2` (the hot-install path landed in `paperclipai/paperclip#4324`).

## Local development

```bash
git clone https://github.com/superbiche/paperclip-adapters
cd paperclip-adapters
pnpm install
pnpm -C packages/copilot-local build
pnpm -C packages/copilot-local test
```

## Agent config

Create a Paperclip agent with `adapterType: "copilot_local"`.

### Minimal (host-inherited auth)

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

The host's `~/.copilot/` state (after `copilot login`) is used. No token in the agent config.

### BYOK (multi-tenant)

```json
{
  "adapterType": "copilot_local",
  "adapterConfig": {
    "command": "copilot",
    "model": "claude-sonnet-4.6",
    "copilotToken": { "secret_ref": "GITHUB_FINE_GRAINED_PAT" },
    "tokenSource": "auto"
  }
}
```

Use a fine-grained PAT (`github_pat_…`) or an OAuth token (`gho_…` / `ghu_…`). Classic PATs (`ghp_…`) are rejected with a clear error. The token is injected into the spawn env as `GH_TOKEN`; never logged.

### GitHub Enterprise

```json
{
  "adapterType": "copilot_local",
  "adapterConfig": {
    "command": "copilot",
    "gheHost": "corp.ghe.com",
    "tokenSource": "gh_cli"
  }
}
```

The token is fetched via `gh auth token --hostname corp.ghe.com`, the `/models` endpoint is discovered via `https://api.corp.ghe.com/copilot_internal/user`, and env-var fallback is suppressed (SSRF guard).

### Skills

Skills declared by Paperclip's runtime (`paperclipRuntimeSkills` in `adapterConfig`) are symlinked into a per-cwd cache (`<cwd>/.paperclip/copilot-skill-cache/`) on every run, and the cache directory is exposed to Copilot CLI via `COPILOT_SKILLS_DIRS`. Stale entries are pruned automatically.

Full config surface is documented in the adapter's `agentConfigurationDoc` — exposed via `GET /api/adapters/copilot_local` on a Paperclip instance that has the adapter installed.

## What's deferred

- **Device-flow login as an in-paperclip flow.** Copilot's interactive `copilot login` works on the Paperclip host but is not yet exposed via Paperclip's UI / API. Adding this requires an upstream extension point for adapter-owned HTTP routes (the relevant SSE endpoint in `paperclipai/paperclip#3629`'s `login.ts` is paperclip-side and can't ship in an external adapter today). Tracked in `docs/authoring-gaps.md`.

## License

MIT. See [`LICENSE`](./LICENSE).
