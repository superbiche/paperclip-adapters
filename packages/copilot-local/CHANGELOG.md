# @superbiche/copilot-paperclip-adapter

## 0.2.0

### Minor Changes

- fe53764: Initial release. External Paperclip adapter that spawns the GitHub Copilot CLI as a managed employee. Wraps `copilot -p <prompt> --output-format json -s --no-color`, parses JSONL output, persists Copilot's native `sessionId`, and resumes via `copilot --resume=<sessionId>` when the saved session matches the current cwd.

  Built on [paperclipai/paperclip#2085](https://github.com/paperclipai/paperclip/pull/2085) (tjp2021), extended with the auth + dynamic-discovery + skill-injection feature set from [paperclipai/paperclip#3629](https://github.com/paperclipai/paperclip/pull/3629) (HearthCore).

  **Features**

  - Session resume via Copilot CLI's `--resume=<id>`. Stale-session detection retries cleanly with a fresh session.
  - **GitHub-side BYOK** via `adapterConfig.githubToken` (paperclip secret); classic-PAT (`ghp_`) rejection.
  - **Provider BYOK** via `adapterConfig.copilotProvider` — point Copilot CLI at any OpenAI-compatible / Anthropic / Azure endpoint. **No GitHub Copilot subscription required in this mode.** Strict baseUrl validation (rejects URLs with embedded userinfo, non-http(s) schemes, fragments). Examples: Ollama, llama.cpp, vLLM, Foundry Local, direct Anthropic Console, OpenAI direct.
  - GitHub-auth resolution chain: `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token`. Tunable via `tokenSource` (`auto` / `env` / `gh_cli`).
  - GitHub Enterprise via `adapterConfig.gheHost` with strict hostname validation (URLs/schemes/ports/paths/userinfo rejected). When `gheHost` is set, env-token fallback is suppressed (SSRF guard).
  - Dynamic model discovery via `/copilot_internal/user` + `/models`, with token-fingerprint cache. Falls back to a hardcoded list when offline.
  - Skill injection via `COPILOT_SKILLS_DIRS`. Paperclip-managed skills are symlinked into a per-cwd cache and exposed to Copilot CLI ephemerally.
  - Enriched session codec round-trips `workspaceId` / `repoUrl` / `repoRef` alongside `sessionId` + `cwd`.
  - Diagnostic env-test probes report token source, provider activation, gheHost validity, and the user's active default model from `~/.copilot/config.json`.

  **Verification**

  - 147 unit tests; tier-1 direct-call smoke harness PASS for both GitHub-mode (host-inherited auth) and provider-mode (homelab llama.cpp via `coder-qwen3.6-q6_k_xl`); tier-2 paperclip-dev integration PASS.
  - The `fetchWithRetry` helper required by HTTP-using features is vendored from #3629's `adapter-utils` source. When that helper lands in published `@paperclipai/adapter-utils`, replace `src/server/fetch-with-retry.ts` with a re-export.

  **Deferred (see `docs/authoring-gaps.md`)**

  - Device-flow login as an in-Paperclip flow needs an upstream extension point for adapter-owned HTTP routes. Host-side `copilot login` and BYOK cover the realistic deployment shapes.
