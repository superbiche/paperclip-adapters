/**
 * Parses Cline CLI 2.x --json stdout stream.
 *
 * Event discriminator: (msg.type === "say" ? msg.say : msg.ask).
 * Confirmed from cline's own aggregator (nLe) in dist/cli.mjs.
 *
 * Token aggregation: msg.type === "say" && msg.say in
 * {api_req_started, deleted_api_reqs, subagent_usage}, with msg.text a
 * JSON-encoded string containing {tokensIn, tokensOut, cacheWrites, cacheReads, cost}.
 *
 * Completion: (say|ask) === "completion_result".
 * Hang-prone asks: followup, mistake_limit_reached, plan_mode_respond, act_mode_respond.
 */

export interface ClineMessage {
  type: "say" | "ask" | string;
  say?: string;
  ask?: string;
  text?: string;
  ts?: number;
  partial?: boolean;
  taskId?: string;
  sessionId?: string;
}

export interface ClineUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWrites: number;
  costUsd: number;
}

export interface ParsedClineOutput {
  usage: ClineUsage;
  isError: boolean;
  errorMessage: string | null;
  completed: boolean;
  lastAssistantText: string | null;
  finalText: string | null;
  taskId: string | null;
  hangProneAsk: { subtype: string; text: string } | null;
  mistakeLimitReached: boolean;
}

const HANG_PRONE_ASK_SUBTYPES = new Set([
  "followup",
  "mistake_limit_reached",
  "plan_mode_respond",
  "act_mode_respond",
]);

const USAGE_SAY_SUBTYPES = new Set([
  "api_req_started",
  "deleted_api_reqs",
  "subagent_usage",
]);

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function getSubtype(msg: ClineMessage): string | null {
  if (msg.type === "say") return typeof msg.say === "string" ? msg.say : null;
  if (msg.type === "ask") return typeof msg.ask === "string" ? msg.ask : null;
  return null;
}

export function isCompletion(msg: ClineMessage): boolean {
  const subtype = getSubtype(msg);
  return subtype === "completion_result";
}

export function isHangProneAsk(msg: ClineMessage): boolean {
  if (msg.type !== "ask") return false;
  const subtype = getSubtype(msg);
  return subtype !== null && HANG_PRONE_ASK_SUBTYPES.has(subtype);
}

export function extractUsageFromMessage(msg: ClineMessage): Partial<ClineUsage> | null {
  if (msg.type !== "say") return null;
  const subtype = getSubtype(msg);
  if (subtype === null || !USAGE_SAY_SUBTYPES.has(subtype)) return null;
  if (typeof msg.text !== "string" || msg.text.length === 0) return null;
  const parsed = safeJsonParse(msg.text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return {
    inputTokens: asNumber(record.tokensIn),
    outputTokens: asNumber(record.tokensOut),
    cachedInputTokens: asNumber(record.cacheReads),
    cacheWrites: asNumber(record.cacheWrites),
    costUsd: asNumber(record.cost),
  };
}

export function parseClineLine(line: string): ClineMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const parsed = safeJsonParse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  return record as unknown as ClineMessage;
}

export function parseClineOutput(stdout: string): ParsedClineOutput {
  const result: ParsedClineOutput = {
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWrites: 0,
      costUsd: 0,
    },
    isError: false,
    errorMessage: null,
    completed: false,
    lastAssistantText: null,
    finalText: null,
    taskId: null,
    hangProneAsk: null,
    mistakeLimitReached: false,
  };

  const lines = stdout.split("\n");
  for (const line of lines) {
    const msg = parseClineLine(line);
    if (msg === null) continue;

    if (typeof msg.taskId === "string" && msg.taskId.length > 0 && result.taskId === null) {
      result.taskId = msg.taskId;
    }
    if (typeof msg.sessionId === "string" && msg.sessionId.length > 0 && result.taskId === null) {
      result.taskId = msg.sessionId;
    }

    const delta = extractUsageFromMessage(msg);
    if (delta !== null) {
      result.usage.inputTokens += delta.inputTokens ?? 0;
      result.usage.outputTokens += delta.outputTokens ?? 0;
      result.usage.cachedInputTokens += delta.cachedInputTokens ?? 0;
      result.usage.cacheWrites += delta.cacheWrites ?? 0;
      result.usage.costUsd += delta.costUsd ?? 0;
    }

    if (msg.type === "say") {
      const text = asString(msg.text);
      const subtype = getSubtype(msg);
      if (subtype === "text" || subtype === "assistant" || subtype === "completion_result") {
        if (text.length > 0) result.lastAssistantText = text;
      }
      if (subtype === "error") {
        result.isError = true;
        if (text.length > 0) result.errorMessage = text;
      }
    }

    if (isCompletion(msg)) {
      result.completed = true;
      if (msg.type === "say") {
        const text = asString(msg.text);
        if (text.length > 0) result.finalText = text;
      }
    }

    if (isHangProneAsk(msg)) {
      const subtype = getSubtype(msg) ?? "unknown";
      result.hangProneAsk = { subtype, text: asString(msg.text) };
      if (subtype === "mistake_limit_reached") {
        result.mistakeLimitReached = true;
      }
    }
  }

  return result;
}

export function isClineAuthRequiredError(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("authentication required") ||
    normalized.includes("not authenticated") ||
    normalized.includes("no provider configured") ||
    normalized.includes("missing api key")
  );
}

export function isClineUnknownTaskError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("task not found") ||
    combined.includes("unknown task id") ||
    combined.includes("no such task") ||
    combined.includes("task history entry not found")
  );
}
