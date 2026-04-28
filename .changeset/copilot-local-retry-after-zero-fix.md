---
"@superbiche/copilot-paperclip-adapter": patch
---

Fix `fetchWithRetry` to treat `Retry-After: 0` as "retry immediately" rather than relying on the implementation-defined Date-parsing fallback.

Greptile flagged a P1 against this guard upstream in [paperclipai/paperclip#4682](https://github.com/paperclipai/paperclip/pull/4682). The reported mechanism (`new Date("0")` returning Invalid Date) doesn't reproduce on Node 20+ — V8 parses `"0"` as year-2000 in local TZ, so `Math.max(0, year2000 - now)` coincidentally returns 0 and the helper happens to behave correctly. The fix is still worth shipping because the previous code leaned on V8's non-spec Date parsing and would break under future engine changes or system clocks set before year 2000. Switching `parsed > 0` to `parsed >= 0` also matches RFC 7231 §7.1.3 explicitly and skips the date-construction branch on the common-zero path.

No behavior change on current Node 20+ deployments. Pinned with a new test that uses `baseDelayMs: 60_000` / `maxDelayMs: 60_000` so a regression would surface as a hung test rather than a silent slowdown.

The vendor copy at `packages/copilot-local/src/server/fetch-with-retry.ts` will go away once the upstream PR merges and `@paperclipai/adapter-utils` republishes; this patch keeps the live adapter on a hardened version until then.
