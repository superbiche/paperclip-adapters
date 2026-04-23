/**
 * Self-contained UI parser for cline-local adapter.
 *
 * Parses Cline's --json stdout into structured transcript entries for the
 * Paperclip run viewer. Zero runtime imports — eval'd in a sandboxed worker.
 */

type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string }
  | { kind: "thinking"; ts: string; text: string }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; content: string; isError: boolean }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function subtypeOf(msg: Record<string, unknown>): string | null {
  const type = asString(msg.type);
  if (type === "say") return asString(msg.say) || null;
  if (type === "ask") return asString(msg.ask) || null;
  return null;
}

function parseToolText(text: string): { name: string; input: unknown } {
  const parsed = safeJsonParse(text);
  const record = asRecord(parsed);
  if (record === null) return { name: "tool", input: text };
  const tool = asString(record.tool, asString(record.name, "tool"));
  const input = record.parameters ?? record.input ?? record.args ?? record;
  return { name: tool, input };
}

function parseUsageText(text: string): { tokensIn: number; tokensOut: number; cost: number } | null {
  const parsed = safeJsonParse(text);
  const record = asRecord(parsed);
  if (record === null) return null;
  const tokensIn = typeof record.tokensIn === "number" ? record.tokensIn : 0;
  const tokensOut = typeof record.tokensOut === "number" ? record.tokensOut : 0;
  const cost = typeof record.cost === "number" ? record.cost : 0;
  return { tokensIn, tokensOut, cost };
}

function isEchoedPaperclipBootstrapPrompt(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    normalized.includes("you are an agent at paperclip company.") ||
    normalized.includes("paperclip runtime note:") ||
    normalized.includes("paperclip api access note:") ||
    normalized.includes("paperclip wake context:")
  );
}

function parseLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (parsed === null) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  const subtype = subtypeOf(parsed);
  const text = asString(parsed.text);

  if (type === "say") {
    if (subtype === "text" || subtype === "assistant") {
      if (text.length === 0) return [];
      return [{ kind: "assistant", ts, text }];
    }
    if (subtype === "reasoning" || subtype === "thinking") {
      if (text.length === 0) return [];
      return [{ kind: "thinking", ts, text }];
    }
    if (subtype === "tool") {
      const { name, input } = parseToolText(text);
      return [{ kind: "tool_call", ts, name, input }];
    }
    if (subtype === "completion_result") {
      return [{ kind: "system", ts, text: text.length > 0 ? `Completion: ${text}` : "Completion" }];
    }
    if (subtype === "api_req_started" || subtype === "deleted_api_reqs" || subtype === "subagent_usage") {
      const usage = parseUsageText(text);
      if (usage === null) return [];
      const parts = [
        `${subtype}:`,
        `in=${usage.tokensIn}`,
        `out=${usage.tokensOut}`,
        usage.cost > 0 ? `cost=$${usage.cost.toFixed(4)}` : null,
      ].filter(Boolean);
      return [{ kind: "system", ts, text: parts.join(" ") }];
    }
    if (subtype === "error") {
      return [{ kind: "stderr", ts, text: text.length > 0 ? text : "cline error" }];
    }
    if (subtype === "user_feedback") {
      if (text.length === 0) return [];
      if (isEchoedPaperclipBootstrapPrompt(text)) return [];
      return [{ kind: "user", ts, text }];
    }
    if (text.length === 0) return [];
    return [{ kind: "system", ts, text: subtype ? `${subtype}: ${text}` : text }];
  }

  if (type === "ask") {
    if (subtype === "tool") {
      const { name, input } = parseToolText(text);
      return [{ kind: "tool_call", ts, name, input }];
    }
    if (subtype === "command") {
      return [{ kind: "tool_call", ts, name: "bash", input: { command: text } }];
    }
    if (subtype === "completion_result") {
      return [{ kind: "system", ts, text: text.length > 0 ? `Completion (ask): ${text}` : "Completion (ask)" }];
    }
    if (subtype === "followup" || subtype === "mistake_limit_reached" || subtype === "plan_mode_respond" || subtype === "act_mode_respond") {
      return [
        {
          kind: "system",
          ts,
          text: `⚠ cline asked for "${subtype}" — watchdog will terminate the run.${text.length > 0 ? ` Detail: ${text}` : ""}`,
        },
      ];
    }
    if (text.length === 0) return [];
    return [{ kind: "system", ts, text: subtype ? `ask ${subtype}: ${text}` : text }];
  }

  if (type === "error") {
    return [{ kind: "stderr", ts, text: stringifyUnknown(parsed.error ?? parsed.message ?? parsed) }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

function reset(): void {
  // Stateless parser — nothing to reset.
}

export { parseLine as parseStdoutLine };

export function createStdoutParser(): {
  parseLine: typeof parseLine;
  reset: typeof reset;
} {
  return { parseLine, reset };
}
