import { describe, expect, it } from "vitest";
import {
  extractUsageFromMessage,
  getSubtype,
  isClineAuthRequiredError,
  isClineUnknownTaskError,
  isCompletion,
  isHangProneAsk,
  parseClineLine,
  parseClineOutput,
} from "../src/server/parse.js";

describe("getSubtype", () => {
  it("reads say subtype", () => {
    expect(getSubtype({ type: "say", say: "text", text: "hi" })).toBe("text");
  });

  it("reads ask subtype", () => {
    expect(getSubtype({ type: "ask", ask: "followup" })).toBe("followup");
  });

  it("returns null for unknown types", () => {
    expect(getSubtype({ type: "other" })).toBeNull();
  });

  it("returns null when subtype field is missing", () => {
    expect(getSubtype({ type: "say" })).toBeNull();
  });
});

describe("isCompletion", () => {
  it("recognizes say completion_result", () => {
    expect(isCompletion({ type: "say", say: "completion_result", text: "done" })).toBe(true);
  });

  it("recognizes ask completion_result", () => {
    expect(isCompletion({ type: "ask", ask: "completion_result" })).toBe(true);
  });

  it("rejects other subtypes", () => {
    expect(isCompletion({ type: "say", say: "text", text: "hi" })).toBe(false);
  });
});

describe("isHangProneAsk", () => {
  it.each(["followup", "mistake_limit_reached", "plan_mode_respond", "act_mode_respond"])(
    "flags ask %s",
    (subtype) => {
      expect(isHangProneAsk({ type: "ask", ask: subtype })).toBe(true);
    },
  );

  it("ignores say variants of the same subtype", () => {
    expect(isHangProneAsk({ type: "say", say: "followup" })).toBe(false);
  });

  it("ignores unknown asks", () => {
    expect(isHangProneAsk({ type: "ask", ask: "something_else" })).toBe(false);
  });
});

describe("extractUsageFromMessage", () => {
  it("extracts tokens from api_req_started", () => {
    const delta = extractUsageFromMessage({
      type: "say",
      say: "api_req_started",
      text: JSON.stringify({ tokensIn: 10, tokensOut: 5, cacheWrites: 2, cacheReads: 1, cost: 0.01 }),
    });
    expect(delta).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 1,
      cacheWrites: 2,
      costUsd: 0.01,
    });
  });

  it("returns null for non-usage events", () => {
    expect(extractUsageFromMessage({ type: "say", say: "text", text: "hi" })).toBeNull();
  });

  it("returns null when text is not valid JSON", () => {
    expect(
      extractUsageFromMessage({ type: "say", say: "api_req_started", text: "not json" }),
    ).toBeNull();
  });

  it("excludes api_req_finished — cline's own aggregator does not sum it", () => {
    expect(
      extractUsageFromMessage({
        type: "say",
        say: "api_req_finished",
        text: JSON.stringify({ tokensIn: 100, tokensOut: 50 }),
      }),
    ).toBeNull();
  });
});

describe("parseClineLine", () => {
  it("parses a valid JSON line", () => {
    const msg = parseClineLine('{"type":"say","say":"text","text":"hello"}');
    expect(msg).toEqual({ type: "say", say: "text", text: "hello" });
  });

  it("ignores blank lines", () => {
    expect(parseClineLine("   ")).toBeNull();
  });

  it("ignores non-object JSON", () => {
    expect(parseClineLine("42")).toBeNull();
  });

  it("ignores objects missing a type field", () => {
    expect(parseClineLine('{"text":"hi"}')).toBeNull();
  });
});

describe("parseClineOutput", () => {
  it("aggregates usage across the three eligible say events", () => {
    const stdout = [
      JSON.stringify({
        type: "say",
        say: "api_req_started",
        text: JSON.stringify({ tokensIn: 10, tokensOut: 5, cacheReads: 1, cost: 0.01 }),
      }),
      JSON.stringify({
        type: "say",
        say: "subagent_usage",
        text: JSON.stringify({ tokensIn: 3, tokensOut: 2, cost: 0.005 }),
      }),
      JSON.stringify({
        type: "say",
        say: "deleted_api_reqs",
        text: JSON.stringify({ tokensIn: 1, tokensOut: 1, cost: 0.001 }),
      }),
      JSON.stringify({
        type: "say",
        say: "api_req_finished",
        text: JSON.stringify({ tokensIn: 1000, tokensOut: 500 }),
      }),
    ].join("\n");
    const parsed = parseClineOutput(stdout);
    expect(parsed.usage.inputTokens).toBe(14);
    expect(parsed.usage.outputTokens).toBe(8);
    expect(parsed.usage.cachedInputTokens).toBe(1);
    expect(parsed.usage.costUsd).toBeCloseTo(0.016, 6);
  });

  it("captures completion and final text", () => {
    const stdout = [
      JSON.stringify({ type: "say", say: "text", text: "thinking" }),
      JSON.stringify({ type: "say", say: "completion_result", text: "done" }),
    ].join("\n");
    const parsed = parseClineOutput(stdout);
    expect(parsed.completed).toBe(true);
    expect(parsed.finalText).toBe("done");
  });

  it("flags hang-prone asks", () => {
    const stdout = JSON.stringify({ type: "ask", ask: "followup", text: "need info" });
    const parsed = parseClineOutput(stdout);
    expect(parsed.hangProneAsk).toEqual({ subtype: "followup", text: "need info" });
  });

  it("sets mistakeLimitReached when the subtype matches", () => {
    const stdout = JSON.stringify({ type: "ask", ask: "mistake_limit_reached" });
    const parsed = parseClineOutput(stdout);
    expect(parsed.mistakeLimitReached).toBe(true);
  });

  it("captures errors from say error events", () => {
    const stdout = JSON.stringify({ type: "say", say: "error", text: "boom" });
    const parsed = parseClineOutput(stdout);
    expect(parsed.isError).toBe(true);
    expect(parsed.errorMessage).toBe("boom");
  });

  it("captures taskId when present on any message", () => {
    const stdout = JSON.stringify({ type: "say", say: "text", text: "hi", taskId: "task-123" });
    const parsed = parseClineOutput(stdout);
    expect(parsed.taskId).toBe("task-123");
  });
});

describe("isClineAuthRequiredError", () => {
  it.each([
    "Authentication required for provider",
    "You are not authenticated",
    "No provider configured",
    "Missing API key",
  ])("recognizes '%s'", (text) => {
    expect(isClineAuthRequiredError(text)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isClineAuthRequiredError("Network timeout")).toBe(false);
  });
});

describe("isClineUnknownTaskError", () => {
  it("recognizes task-not-found messages", () => {
    expect(isClineUnknownTaskError("", "Task not found: task-123")).toBe(true);
    expect(isClineUnknownTaskError("No such task", "")).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isClineUnknownTaskError("", "Permission denied")).toBe(false);
  });
});
