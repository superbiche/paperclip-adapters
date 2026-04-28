export const type = "copilot_local";
export const label = "GitHub Copilot CLI (local)";

/**
 * Static fallback list returned when dynamic model discovery fails (no token,
 * offline, API unreachable). The factory wires `listModels` to call the live
 * Copilot API first; this list is the graceful-degradation path.
 */
export const FALLBACK_MODELS: { id: string; label: string }[] = [
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "grok-code-fast-1", label: "Grok Code Fast 1" },
];

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local
Registration: external plugin (loaded via adapter plugin system).

Use when:
- The host machine has GitHub Copilot CLI installed (\`npm i -g @githubnext/github-copilot-cli\`) and a pre-authenticated session (\`copilot login\` or \`gh auth login\`).
- You want a local coding agent backed by GitHub Copilot's subscription billing.
- You want session continuation across heartbeats via Copilot's native \`--resume=<sessionId>\`.

Don't use when:
- Copilot CLI is not installed or no GitHub auth state exists for the host process.
- You need per-run cost reporting in dollars (Copilot is subscription-billed; \`costUsd\` is always \`null\`).

Core fields:
- command (string, optional): defaults to \`copilot\`
- cwd (string, optional): default absolute working directory for the agent process
- model (string, optional): model id (e.g. \`gpt-5.4\`, \`claude-sonnet-4.6\`). The available list is discovered dynamically from Copilot's \`/models\` API when a token is resolvable; falls back to a hardcoded list otherwise.
- effort (string, optional): reasoning effort (\`low\` | \`medium\` | \`high\` | \`xhigh\`)
- promptTemplate (string, optional): heartbeat prompt template
- dangerouslySkipPermissions (boolean, optional): pass \`--allow-all\` instead of \`--allow-all-tools\`
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables (e.g. \`GH_TOKEN\` to inject a personal access token)
- timeoutSec (number, optional): adapter-level timeout in seconds (0 = no timeout)
- graceSec (number, optional): SIGTERM grace period before SIGKILL (default 20)

Notes:
- Paperclip runs Copilot via \`copilot -p <prompt> --output-format json -s --no-color [--resume=<id>] [--allow-all|--allow-all-tools] [--model <id>] [--effort <level>]\`.
- If a saved sessionId exists for the same cwd, Paperclip resumes it. Otherwise a fresh session is started.
- Copilot CLI errors land in stderr as plain text (zero JSONL on stdout); the adapter detects "no session or task matched" and retries fresh.
- Auth: the adapter does not inject tokens by default. Either run \`copilot login\` once on the host, or set \`GH_TOKEN\`/\`GITHUB_TOKEN\` via the \`env\` config.
`;

export { createServerAdapter } from "./server/index.js";
