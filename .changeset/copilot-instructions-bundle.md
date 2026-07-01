---
"@superbiche/copilot-paperclip-adapter": patch
---

Implement the advertised instructions-bundle and local-agent-JWT capabilities.

The adapter set `supportsInstructionsBundle: true` and `supportsLocalAgentJwt:
true` but implemented neither, so Copilot ran with no `AGENTS.md` / `HEARTBEAT.md`
operating contract and no Paperclip API credential. Agents never checked out
their assigned issue or recorded a final disposition — producing Paperclip
`successful_run_missing_state` / `clear_next_step` "Missing Disposition"
recovery failures — and any API call returned HTTP 401.

- `execute()` now loads the entry instructions file plus the sibling `*.md`
  bundle files from the instructions root, prepends them to the run prompt, and
  exposes the root to the CLI via `--add-dir` so relative references resolve.
- `execute()` now forwards the per-run `ctx.authToken` as `PAPERCLIP_API_KEY`
  (unless already set via `config.env`), matching the `qwen-local` /
  `cline-local` adapters, so the agent can authenticate its Paperclip API calls.
