# Adapter-authoring gaps in paperclipai/paperclip

Gaps surfaced while building external adapters against the plugin system. **Adapter-author view only** — concerns that affect someone writing a new `@paperclipai/adapter-utils`-based adapter and plugging it into a Paperclip instance. Consumer-side concerns (orchestrator API shape, agent lifecycle, workspace strategy) live in the consumer's own repo.

Organised by state:

- **Active** — branch exists on [`superbiche/paperclip`](https://github.com/superbiche/paperclip), awaiting maintainer review or follow-up.
- **Deferred** — catalogued only. No branch, no immediate plan. Candidate for future contributions.

When a new gap surfaces, categorise as:

1. Works — no action.
2. Doesn't work, acceptable for this adapter pack — add to Deferred. No branch.
3. Doesn't work, blocks an adapter — draft branch on `superbiche/paperclip`, add to Active.

---

## Active

### External adapters cannot declare `sessionManagement` — hot-install path (parity follow-up to #4296)

**Gap:** with #4296 merged the init-time IIFE preserves module-provided `sessionManagement`, but the hot-install path at `server/src/routes/adapters.ts:174 registerWithSessionManagement` still unconditionally overwrites it with the registry lookup. Practical impact: an adapter installed via `POST /api/adapters/install` needs a Paperclip restart before its declared `sessionManagement` becomes effective (the IIFE runs on next boot and preserves it, but until then the hot-install overwrite wins).

**Fix:** delegate `registerWithSessionManagement` to the same `resolveExternalAdapterRegistration` helper introduced by #4296. Unifies the init-time IIFE and hot-install paths behind one resolver. Plus one integration test in `server/src/__tests__/adapter-routes.test.ts` that installs an external module carrying a non-trivial `sessionManagement` declaration and asserts the registered module preserves it after `POST /api/adapters/install` returns 201.

**Local verification:** `pnpm -w run test` — 1923/1924 passed (1 skipped, unrelated).

**Branch:** `fix/external-session-management-hot-install` on `superbiche/paperclip`, now rebased onto `upstream/master` as a clean single-commit follow-up.

**PR:** [paperclipai/paperclip#4324](https://github.com/paperclipai/paperclip/pull/4324) — ready-for-review.

---

## Landed upstream

### External adapters cannot declare `sessionManagement` — init-time IIFE path (merged)

**Fix landed:** [paperclipai/paperclip#4296](https://github.com/paperclipai/paperclip/pull/4296) merged 2026-04-23 as commit `24232078fd64575a31713428c3df13e57dd66f38`. Exported `resolveExternalAdapterRegistration` helper honors module-provided `sessionManagement` first, falls back to `getAdapterSessionManagement(type)`, else `undefined`. The init-time IIFE delegates to the helper. Plus three unit tests covering module-provided / registry-fallback / undefined paths.

**Context:** PR [#2218](https://github.com/paperclipai/paperclip/pull/2218) (the foundational external-adapter plugin system) explicitly deferred this: *"Adapter execution model, heartbeat protocol, and session management are untouched."* #4296 closed the gap on the cold-start path; the hot-install follow-up above closes it on the `POST /api/adapters/install` path.

---

## Deferred

### CLI dynamic loader parity for external adapters

**Gap:** `cli/src/adapters/registry.ts:61-63` falls back to a generic `processCLIAdapter` for external types. `paperclipai run --watch` renders external-adapter transcripts with generic formatting, while the web UI loads the adapter's `./ui-parser` export dynamically via `ui/src/adapters/dynamic-loader.ts:218-260`.

**Shape of fix:** CLI-side dynamic loader fetching `/api/adapters/:type/ui-parser.js`. Heavier than the sessionManagement fix — the CLI has no sandboxed worker, would need an alternative sandbox or documented trust boundary.

**Priority:** low. Neither adapter here targets the paperclipai CLI surface.

### `InviteLanding.tsx` compile-time type list

**Gap:** `ui/src/pages/InviteLanding.tsx` iterates the compile-time `AGENT_ADAPTER_TYPES` from `packages/shared/src/constants.ts:27-37`. External adapter types never appear in the invite-flow dropdown.

**Shape of fix:** fetch the runtime adapter list from `/api/adapters` and render that. Probably needs the adapter-display-registry fix (below) to land first to avoid fallback-icon flicker.

**Priority:** low. Invite flow is a convenience path; programmatic agent creation via API works fine.

### `adapter-display-registry.ts` runtime resolution

**Gap:** `ui/src/adapters/adapter-display-registry.ts` falls back to a generic `Cpu` icon + `humanizeType(type)` label for unknown types. External adapters cannot supply their own icon or human label to the web UI.

**Shape of fix:** allow external packages to declare icon + label metadata (e.g. via `paperclip.adapterDisplay` in `package.json` or a dedicated export). Resolve at runtime.

**Priority:** cosmetic.

### `AgentConfigForm.tsx` placeholder heuristic

**Gap:** `AgentConfigForm.tsx:701-710` uses a hardcoded `_local`-suffix-stripping heuristic to generate placeholders for adapter config fields.

**Shape of fix:** read per-adapter placeholder metadata from `/api/adapters/:type` or the adapter's own schema.

**Priority:** cosmetic. Works for `cline_local` and `qwen_local` because both match the `_local` convention.

### `copilot_local` v0.1 has no first-class auth resolution chain

**Gap:** `@superbiche/copilot-paperclip-adapter@0.1.0` ports [paperclipai/paperclip#2085](https://github.com/paperclipai/paperclip/pull/2085) (tjp2021), which spawns the `copilot` binary directly and inherits whatever auth state the host has — pre-authenticated `~/.copilot/` (after `copilot login`) or `GH_TOKEN`/`GITHUB_TOKEN` env. The adapter's `detectCopilotAuthRequired` flags failures via stderr regex but does not resolve, refresh, or inject tokens.

**Practical impact:**
- K8s/CI deployments must bake the token into Paperclip's env via a Secret. No per-agent BYOK.
- No GitHub Enterprise (GHE) host override — the upstream Copilot host is implicit.
- No token-fingerprint cache, so multi-tenant Paperclip instances can't safely run different `copilot_local` agents under different identities concurrently.
- Copilot CLI's interactive `copilot login` device-flow is not exposed to Paperclip — the user must run it on the host as the same OS user Paperclip runs as.

**Shape of fix (deferred to v0.2+):**
- Port [#3629](https://github.com/paperclipai/paperclip/pull/3629) (HearthCore) — adds BYOK + GHE host override + `fetchWithRetry` + token-fingerprint cache (`tokenFingerprint(token)@host` keyed). One P1 (SSRF via `gheHost` query) must be fixed during port: validate `gheHost` against the persisted agent config, never trust request hints with env-token fallback.
- Port [#3246](https://github.com/paperclipai/paperclip/pull/3246) (oespinozai) — token-resolution chain: pre-fetched token → PAT → `gh auth token`. Cleaner separation of concerns than #3629's single execute.ts.
- Either route requires an upstream extension point for adapter-owned HTTP routes if we want the device-flow login surface (#3629's `/api/agents/:id/copilot-login` SSE endpoint isn't shippable in an external adapter today).

**Priority:** medium. Acceptable for the current Berceuse threat model (single-tenant homelab Paperclip on HL3, single GitHub identity). Becomes blocking when:
- Multiple Copilot identities need to run concurrently in the same Paperclip instance, OR
- A GHE host (vs github.com) is required, OR
- We want UI-driven re-auth instead of host-side `copilot login`.
