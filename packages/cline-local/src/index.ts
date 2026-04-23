export const type = "cline_local";
export const label = "Cline (local)";

export const models: { id: string; label: string }[] = [
  { id: "deepseek-chat", label: "deepseek-chat" },
  { id: "deepseek-reasoner", label: "deepseek-reasoner" },
  { id: "anthropic/claude-sonnet-4-6", label: "claude-sonnet-4-6" },
  { id: "anthropic/claude-opus-4-7", label: "claude-opus-4-7" },
  { id: "anthropic/claude-haiku-4-5", label: "claude-haiku-4-5" },
];

export const agentConfigurationDoc = `# cline_local agent configuration

Adapter: cline_local
Registration: external plugin (loaded via adapter plugin system).

Use when:
- The host machine has Cline CLI 2.x installed (\`npm install -g cline\`) and a pre-authenticated \`--config\` directory.
- You want a local coding agent with session continuation across heartbeats via Cline's native \`--taskId\`.
- You want structured JSONL run logs for transcript rendering.

Don't use when:
- Cline CLI is not installed or its config directory lacks authenticated provider credentials.
- You need browser-driven or MCP-heavy workflows that Cline CLI can't deliver headlessly.

Core fields:
- command (string, optional): defaults to \`cline\`
- configDir (string, required): path to pre-authenticated Cline \`--config\` directory. Seed via \`cline auth -p <provider> -k <key> -m <model> --config <dir>\` once.
- model (string, optional): model id passed as \`-m\` (e.g. \`deepseek-chat\`)
- cwd (string, optional): absolute working directory fallback when paperclipWorkspace is not provided
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the prompt
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): sent only when a fresh session is started
- extraArgs (string[], optional): additional CLI args appended before \`-c\`/\`--taskId\`/\`--timeout\`/prompt
- env (object, optional): environment variables
- timeoutSec (number, optional): adapter-level timeout in seconds (default 600)
- graceSec (number, optional): SIGTERM grace period before SIGKILL (default 20)

Notes:
- Paperclip runs Cline via \`cline -a -y --json --config <dir> -m <model> -c <cwd> [--timeout <sec>] [--taskId <id>] <prompt>\`.
- Prompt is passed as Cline's positional argument. Length is bounded by the OS argv limit (~2MB on Linux).
- If a saved taskId exists for the same cwd, Paperclip resumes it with \`--taskId\`. Otherwise a fresh session is started.
- Hang-prone \`ask\` messages (followup, mistake_limit_reached, plan_mode_respond, act_mode_respond) trigger a watchdog that kills the run with a clear error.
`;

export { createServerAdapter } from "./server/index.js";
