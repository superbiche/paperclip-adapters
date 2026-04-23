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

### External adapters cannot declare `sessionManagement` — init-time IIFE path

**Gap:** `server/src/adapters/registry.ts:363-369` overwrote any module-provided `sessionManagement` field with `getAdapterSessionManagement(type) ?? undefined`. The hardcoded registry at `packages/adapter-utils/src/session-compaction.ts:49-85` is keyed by builtin type strings only, so external adapters always resolved to `undefined`. `supportsSessionResume`, `nativeContextManagement`, and `defaultSessionCompaction` were therefore unsettable for external adapters, and the runtime's compaction policy paths (which gate on those flags) were disabled — even when the external adapter provided a working `sessionCodec`.

**Fix (submitted):** honor module-provided `sessionManagement` when non-null, falling back to the registry lookup. Extracted as `resolveExternalAdapterRegistration`; IIFE delegates to it. Plus unit tests.

**Context:** PR [#2218](https://github.com/paperclipai/paperclip/pull/2218) (the foundational external-adapter plugin system) explicitly deferred this: *"Adapter execution model, heartbeat protocol, and session management are untouched."* The current fix is the natural follow-up.

**Branch:** `fix/external-session-management` on `superbiche/paperclip`.

**PR:** [paperclipai/paperclip#4296](https://github.com/paperclipai/paperclip/pull/4296) — ready-for-review.

### External adapters cannot declare `sessionManagement` — hot-install path (parity follow-up to #4296)

**Gap:** even with #4296 merged, the hot-install path at `server/src/routes/adapters.ts:174 registerWithSessionManagement` still unconditionally overwrote module `sessionManagement` with the registry lookup. Practical impact: an adapter installed via `POST /api/adapters/install` needed a Paperclip restart before its declared `sessionManagement` became effective (the IIFE path runs on next boot).

**Fix (drafted locally, hold-push pattern):** delegate `registerWithSessionManagement` to the same `resolveExternalAdapterRegistration` helper introduced by #4296. Unifies the init-time IIFE and hot-install paths behind one resolver. Plus one integration test in `server/src/__tests__/adapter-routes.test.ts` that installs an external module carrying a non-trivial `sessionManagement` declaration and asserts the registered module preserves it after `POST /api/adapters/install` returns 201.

**Local verification:** `pnpm -w run test` — 1923/1924 passed (1 skipped, unrelated).

**Branch:** `fix/external-session-management-hot-install` on `superbiche/paperclip`. Stacked on `fix/external-session-management`; should merge after #4296 lands.

**PR:** [paperclipai/paperclip#4324](https://github.com/paperclipai/paperclip/pull/4324) — ready-for-review, explicitly stacked on #4296.

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
