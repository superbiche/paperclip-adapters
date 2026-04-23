import { describe, expect, it } from "vitest";
import { createStdoutParser, parseStdoutLine } from "../src/ui-parser.js";

const TS = "2026-04-23T00:00:00.000Z";

describe("parseStdoutLine", () => {
  it("emits assistant entries for say/text", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "say", say: "text", text: "hello" }),
      TS,
    );
    expect(entries).toEqual([{ kind: "assistant", ts: TS, text: "hello" }]);
  });

  it("emits thinking entries for say/reasoning", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "say", say: "reasoning", text: "deliberating" }),
      TS,
    );
    expect(entries).toEqual([{ kind: "thinking", ts: TS, text: "deliberating" }]);
  });

  it("emits tool_call entries for say/tool", () => {
    const entries = parseStdoutLine(
      JSON.stringify({
        type: "say",
        say: "tool",
        text: JSON.stringify({ tool: "read_file", parameters: { path: "README.md" } }),
      }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "tool_call", ts: TS, name: "read_file", input: { path: "README.md" } },
    ]);
  });

  it("emits system entries for api_req_started usage snapshots", () => {
    const entries = parseStdoutLine(
      JSON.stringify({
        type: "say",
        say: "api_req_started",
        text: JSON.stringify({ tokensIn: 10, tokensOut: 5, cost: 0.002 }),
      }),
      TS,
    );
    expect(entries[0]?.kind).toBe("system");
    const entry = entries[0];
    expect(entry && entry.kind === "system" && entry.text).toMatch(/in=10 out=5/);
  });

  it("flags hang-prone asks with a warning line", () => {
    const entries = parseStdoutLine(
      JSON.stringify({ type: "ask", ask: "followup", text: "please clarify" }),
      TS,
    );
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry && entry.kind === "system" && entry.text).toMatch(/watchdog/);
  });

  it("falls back to stdout for non-JSON lines", () => {
    const entries = parseStdoutLine("not json at all", TS);
    expect(entries).toEqual([{ kind: "stdout", ts: TS, text: "not json at all" }]);
  });

  it("suppresses echoed paperclip bootstrap prompts", () => {
    const entries = parseStdoutLine(
      JSON.stringify({
        type: "say",
        say: "user_feedback",
        text: "You are an agent at Paperclip company. Do things.",
      }),
      TS,
    );
    expect(entries).toEqual([]);
  });
});

describe("createStdoutParser", () => {
  it("returns a parser with parseLine + reset", () => {
    const parser = createStdoutParser();
    expect(typeof parser.parseLine).toBe("function");
    expect(typeof parser.reset).toBe("function");
    parser.reset();
  });
});
