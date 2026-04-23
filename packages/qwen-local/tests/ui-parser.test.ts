import { describe, expect, it } from "vitest";
import { parseStdoutLine } from "../src/ui-parser.js";

const TS = "2026-04-23T00:00:00.000Z";

describe("parseStdoutLine (qwen-local)", () => {
  it("emits init on system init with session_id", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "system", subtype: "init", model: "qwen3-coder-next", session_id: "sess-1" }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "init", ts: TS, model: "qwen3-coder-next", sessionId: "sess-1" },
    ]);
  });

  it("emits assistant entries for type=assistant with inline text", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "assistant", message: { text: "hi" } }),
      TS,
    );
    expect(entries).toEqual([{ kind: "assistant", ts: TS, text: "hi" }]);
  });

  it("unwraps assistant content blocks", () => {
    const entries = parseStdoutLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", text: "pondering" },
            { type: "output_text", text: "answer" },
            { type: "tool_call", name: "read_file", input: { path: "a.txt" } },
          ],
        },
      }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "thinking", ts: TS, text: "pondering" },
      { kind: "assistant", ts: TS, text: "answer" },
      { kind: "tool_call", ts: TS, name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  it("emits result entries with usage totals", () => {
    const entries = parseStdoutLine(
      JSON.stringify({
        type: "result",
        result: "done",
        usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 },
        total_cost_usd: 0.001,
      }),
      TS,
    );
    expect(entries).toEqual([
      {
        kind: "result",
        ts: TS,
        text: "done",
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        costUsd: 0.001,
        subtype: "result",
        isError: false,
        errors: [],
      },
    ]);
  });

  it("falls back to stdout for non-JSON lines", () => {
    const entries = parseStdoutLine("not json", TS);
    expect(entries).toEqual([{ kind: "stdout", ts: TS, text: "not json" }]);
  });

  it("handles top-level tool_call started + completed events", () => {
    const started = parseStdoutLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "t1",
        tool_call: { read_file: { args: { path: "x.md" } } },
      }),
      TS,
    );
    expect(started).toEqual([
      { kind: "tool_call", ts: TS, name: "read_file", input: { path: "x.md" } },
    ]);

    const finished = parseStdoutLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "t1",
        tool_call: { read_file: { result: "file contents" } },
      }),
      TS,
    );
    expect(finished).toEqual([
      {
        kind: "tool_result",
        ts: TS,
        toolUseId: "t1",
        content: "file contents",
        isError: false,
      },
    ]);
  });
});
