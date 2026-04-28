# @superbiche/copilot-paperclip-adapter

External [Paperclip](https://github.com/paperclipai/paperclip) adapter that spawns the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) as a managed employee. Wraps `copilot` as a subprocess, passes the wake prompt via `-p`, parses `--output-format json` JSONL stdout, and persists Copilot's native `sessionId` so Paperclip can resume across heartbeats via `copilot --resume=<sessionId>`.

## Origin and attribution

The runtime of this adapter combines work from two upstream PRs against [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip):

- **Foundation** — `src/server/execute.ts`, `src/server/parse.ts`, `src/server/test.ts`, `src/ui-parser.ts`, the JSONL parsing, transcript translation, stale-session retry logic, and the initial 54-test suite were **originally authored by [@tjp2021](https://github.com/tjp2021)** in PR [paperclipai/paperclip#2085](https://github.com/paperclipai/paperclip/pull/2085) as an in-tree `packages/adapters/copilot-local` package. Greptile gave the PR a 5/5 confidence score.

- **Auth + features** — `src/server/auth.ts` (token resolution + endpoint discovery + token-fingerprint cache), `src/server/models.ts` (dynamic model discovery), `src/server/detect-model.ts`, `src/server/skills.ts` (skill injection via `COPILOT_SKILLS_DIRS`), the `fetchWithRetry` helper, and the BYOK / GHE / multi-tenant identity handling were **authored by [@HearthCore](https://github.com/HearthCore)** in PR [paperclipai/paperclip#3629](https://github.com/paperclipai/paperclip/pull/3629). The Greptile-flagged SSRF P1 was already addressed at HEAD by HearthCore; this port adds defense-in-depth `gheHost` format validation on top.

After PR [paperclipai/paperclip#2218](https://github.com/paperclipai/paperclip/pull/2218) shipped the external adapter plugin system, the ecosystem direction shifted toward third-party adapter packages over in-tree additions. With both PRs sitting unmerged in the upstream queue, the adapter was assembled out-of-tree into this external package — preserving both authors' work, with the SSRF defense-in-depth fix applied during port and provider-BYOK (`adapterConfig.copilotProvider`) added as a new first-class config surface for the use case Copilot CLI's `copilot help providers` actually documents.

The external-plugin port — `src/server/index.ts` factory exposing `createServerAdapter()`, `sessionManagement` declaration, inlined self-contained `src/ui-parser.ts`, `src/server/provider.ts` provider-BYOK validation/injection, stand-alone `tsconfig.json`, and the workspace packaging — was done by [@superbiche](https://github.com/superbiche) / [@tsbwc](https://github.com/tsbwc). Smoke-tested end-to-end against a paperclip-dev instance with both GitHub-mode and provider-mode (homelab llama.cpp via `coder-qwen3.6-q6_k_xl`).

## Status

- v0.1.0 — initial release.
- 128 unit tests cover JSONL parse, transcript parse, error detection, stale-session retry, token resolution, endpoint discovery, model discovery, hostname validation, and session-codec round-trip.
- `supportsSessionResume: true`, `nativeContextManagement: "confirmed"`. Resume verified end-to-end against a paperclip-dev instance + real Copilot CLI 1.0.37.
- Subscription billing (`costUsd: null`); premium-request count tracked separately on `usage`.

## Features

- **Session resume** via Copilot's native `--resume=<sessionId>`. Stale-session detection retries cleanly with a fresh session.
- **GitHub-side BYOK** via `adapterConfig.githubToken` (paperclip secret), with classic-PAT (`ghp_`) rejection.
- **Provider BYOK** via `adapterConfig.copilotProvider` — point Copilot CLI at any OpenAI-compatible / Anthropic / Azure endpoint. **No GitHub Copilot subscription required in this mode.** Use cases: Ollama, llama.cpp, vLLM, Foundry Local, direct Anthropic Console, OpenAI direct.
- **GitHub auth resolution chain** when no `githubToken` and no provider are set: `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token` CLI fallback. Tunable via `adapterConfig.tokenSource` (`auto` / `env` / `gh_cli`).
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

### GitHub-side BYOK (multi-tenant Copilot subscription)

```json
{
  "adapterType": "copilot_local",
  "adapterConfig": {
    "command": "copilot",
    "model": "claude-sonnet-4.6",
    "githubToken": { "secret_ref": "GITHUB_FINE_GRAINED_PAT" },
    "tokenSource": "auto"
  }
}
```

Use a fine-grained PAT (`github_pat_…`) or an OAuth token (`gho_…` / `ghu_…`). Classic PATs (`ghp_…`) are rejected with a clear error. The token is injected into the spawn env as `GH_TOKEN`; never logged.

### Provider BYOK — local llama.cpp / Ollama (no GitHub Copilot subscription)

```json
{
  "adapterType": "copilot_local",
  "adapterConfig": {
    "command": "copilot",
    "model": "qwen-coder",
    "copilotProvider": {
      "baseUrl": "http://localhost:11434/v1",
      "type": "openai",
      "apiKey": "ollama"
    }
  }
}
```

For an authenticated llama.cpp server:

```json
{
  "adapterConfig": {
    "command": "copilot",
    "model": "coder-qwen3.6-q6_k_xl",
    "copilotProvider": {
      "baseUrl": "http://homelab.lan:8000/v1",
      "type": "openai",
      "bearerToken": { "secret_ref": "LLAMA_API_KEY_HL1" }
    }
  }
}
```

### Provider BYOK — Anthropic direct

```json
{
  "adapterConfig": {
    "command": "copilot",
    "model": "claude-sonnet-4-5-20250929",
    "copilotProvider": {
      "baseUrl": "https://api.anthropic.com/v1",
      "type": "anthropic",
      "apiKey": { "secret_ref": "ANTHROPIC_API_KEY" }
    }
  }
}
```

In provider-BYOK mode, `COPILOT_PROVIDER_BASE_URL` activates the bypass — GitHub Copilot's routing is skipped entirely. Per `copilot help providers`: *"GitHub authentication is not required when using a custom provider."*

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
