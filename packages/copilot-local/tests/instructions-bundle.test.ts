import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCopilotInstructionsBundle } from "../src/server/execute.js";

const noopLog = async () => {};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-instr-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadCopilotInstructionsBundle", () => {
  it("returns an empty bundle when no instructions config is present", async () => {
    const bundle = await loadCopilotInstructionsBundle({}, noopLog);
    expect(bundle.prompt).toBe("");
    expect(bundle.addDir).toBe("");
    expect(bundle.loadedFiles).toEqual([]);
    expect(bundle.chars).toBe(0);
  });

  it("loads the entry file plus sibling bundle files (incl. HEARTBEAT) and sets add-dir", async () => {
    const root = path.join(tmpDir, "instructions");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Role\nYou are the lead agent.", "utf8");
    await fs.writeFile(
      path.join(root, "HEARTBEAT.md"),
      "# HEARTBEAT\nUpdate the issue to a clear final disposition before exiting.",
      "utf8",
    );
    await fs.writeFile(path.join(root, "SOUL.md"), "# Soul\nBe helpful.", "utf8");

    const bundle = await loadCopilotInstructionsBundle(
      {
        instructionsFilePath: path.join(root, "AGENTS.md"),
        instructionsRootPath: root,
        instructionsEntryFile: "AGENTS.md",
      },
      noopLog,
    );

    // Entry file loads first, then remaining *.md sorted.
    expect(bundle.loadedFiles).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md"]);
    // The disposition contract from HEARTBEAT.md must reach the prompt.
    expect(bundle.prompt).toContain("final disposition");
    expect(bundle.prompt).toContain("You are the lead agent.");
    expect(bundle.prompt).toContain("<paperclip_agent_instructions>");
    expect(bundle.addDir).toBe(path.resolve(root));
    expect(bundle.chars).toBeGreaterThan(0);
  });

  it("falls back to the entry file's directory when only instructionsFilePath is given", async () => {
    const root = path.join(tmpDir, "instr2");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "entry-only bundle", "utf8");

    const bundle = await loadCopilotInstructionsBundle(
      { instructionsFilePath: path.join(root, "AGENTS.md") },
      noopLog,
    );

    expect(bundle.loadedFiles).toContain("AGENTS.md");
    expect(bundle.addDir).toBe(path.resolve(root));
    expect(bundle.prompt).toContain("entry-only bundle");
  });

  it("does not duplicate the entry file when it is also discovered in the root", async () => {
    const root = path.join(tmpDir, "instr3");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "once", "utf8");

    const bundle = await loadCopilotInstructionsBundle(
      { instructionsFilePath: path.join(root, "AGENTS.md"), instructionsRootPath: root },
      noopLog,
    );

    const occurrences = bundle.loadedFiles.filter((f) => f === "AGENTS.md").length;
    expect(occurrences).toBe(1);
  });

  it("reports a note and empty prompt when configured files are unreadable", async () => {
    const bundle = await loadCopilotInstructionsBundle(
      {
        instructionsFilePath: path.join(tmpDir, "missing", "AGENTS.md"),
        instructionsRootPath: path.join(tmpDir, "missing"),
      },
      noopLog,
    );
    expect(bundle.prompt).toBe("");
    expect(bundle.notes.join(" ")).toMatch(/no files could be read/i);
  });

  it("enforces the byte cap on a real byte boundary for multibyte content", async () => {
    const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
    const root = path.join(tmpDir, "instr-cap");
    await fs.mkdir(root, { recursive: true });
    // 🎯 is 4 UTF-8 bytes and a surrogate pair in UTF-16. Produce well over the
    // cap so truncation is exercised; a char-based slice would both overshoot
    // the byte cap (~2x) and risk splitting a surrogate pair.
    const oversized = "🎯".repeat(200_000); // ~800 KB
    await fs.writeFile(path.join(root, "AGENTS.md"), oversized, "utf8");

    const bundle = await loadCopilotInstructionsBundle(
      { instructionsFilePath: path.join(root, "AGENTS.md"), instructionsRootPath: root },
      noopLog,
    );

    // Only the emoji payload is capped; count injected emoji code points.
    const emojiCount = [...bundle.prompt].filter((c) => c === "🎯").length;
    expect(emojiCount).toBeGreaterThan(0);
    // Byte cap must hold: emoji bytes injected never exceed MAX_INSTRUCTIONS_BYTES.
    expect(emojiCount * 4).toBeLessThanOrEqual(MAX_INSTRUCTIONS_BYTES);
    // No broken decoding: truncation must not leave a replacement char / lone surrogate.
    expect(bundle.prompt).not.toContain("\uFFFD");
    // Iterating by code point keeps valid surrogate pairs together (length 2);
    // a lone surrogate would surface as a single length-1 code unit in range.
    const hasLoneSurrogate = [...bundle.prompt].some((u) => {
      if (u.length !== 1) return false;
      const code = u.charCodeAt(0);
      return code >= 0xd800 && code <= 0xdfff;
    });
    expect(hasLoneSurrogate).toBe(false);
  });
});
