---
"@superbiche/copilot-paperclip-adapter": patch
---

Load the managed agent instructions bundle into Copilot runs.

The adapter advertised `supportsInstructionsBundle: true` but never consumed
`instructionsFilePath` / `instructionsRootPath`, so the Copilot CLI was launched
with only "Continue your Paperclip work" and none of the agent's `AGENTS.md` /
`HEARTBEAT.md` operating contract. Agents therefore never checked out their
assigned issue or recorded a final disposition, producing Paperclip
`successful_run_missing_state` / `clear_next_step` "Missing Disposition"
recovery failures.

`execute()` now loads the entry instructions file plus the sibling `*.md`
bundle files from the instructions root, prepends them to the run prompt, and
exposes the root to the CLI via `--add-dir` so relative references resolve.
