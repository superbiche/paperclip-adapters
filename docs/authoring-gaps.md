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

### `copilot_local` device-flow login is not exposable as an in-Paperclip flow

**Gap:** Copilot's interactive `copilot login` device-flow works fine on the Paperclip host (and we use it for tier-2 smoke), but it cannot be surfaced through Paperclip's UI / API the way `claude_local`'s `/api/agents/:id/claude-login` is. The relevant route in [paperclipai/paperclip#3629](https://github.com/paperclipai/paperclip/pull/3629) (HearthCore) — `/api/agents/:id/copilot-login`, an SSE endpoint streaming device-flow URL + user-code chunks — lives in `server/src/routes/agents.ts` on the paperclip side. An external adapter has no extension point to register paperclip-side HTTP routes.

**Practical impact:**
- Re-authentication after token rotation requires a host-side `copilot login` invocation by an OS user with shell access to the Paperclip process's home — not a UI-driven flow.
- Multi-tenant Paperclip deployments cannot let individual users (re)authenticate their Copilot identity through the agent-detail page; the Paperclip-instance operator does it for them.

**Workaround (shipped in `@superbiche/copilot-paperclip-adapter@0.1.0`):**
- BYOK via `adapterConfig.copilotToken` (paperclip secret) covers the multi-tenant case.
- The full auth resolution chain (env → `gh auth token`) covers the homelab + CI cases.
- Host-side `copilot login` covers the homelab + interactive case.

**Shape of fix:**
- Upstream extension point for external adapters to register HTTP routes scoped under `/api/adapters/<type>/...` or `/api/agents/:id/adapters/<type>/...`. The plugin loader would need to call the adapter's `registerRoutes(router)` at install-time. Probably wants its own RFC.
- Or: paperclip core gains a generic "device-flow proxy" route that adapters expose intent for, and core handles the SSE + state-machine bookkeeping.

**Priority:** medium-low. The BYOK + auth chain shipped in this package's v0.1.0 covers the realistic deployment shapes. The UI-driven flow is a UX nice-to-have, not a capability gap.
