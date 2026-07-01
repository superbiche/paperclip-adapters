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
});
