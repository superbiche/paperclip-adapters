import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
}));

import { readFile } from "node:fs/promises";
import { detectCopilotLocalModel } from "../src/server/detect-model.js";

const readFileMock = vi.mocked(readFile);

describe("detectCopilotLocalModel", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the model from ~/.copilot/config.json when set", async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ model: "claude-sonnet-4.6", firstLaunchAt: "2026-04-27" }),
    );
    const result = await detectCopilotLocalModel();
    expect(result).toEqual({
      model: "claude-sonnet-4.6",
      provider: "copilot",
      source: "~/.copilot/config.json",
    });
    expect(readFileMock).toHaveBeenCalledWith("/home/test/.copilot/config.json", "utf-8");
  });

  it("trims surrounding whitespace from the model name", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ model: "  gpt-5  " }));
    const result = await detectCopilotLocalModel();
    expect(result?.model).toBe("gpt-5");
  });

  it("returns null when config.json is missing (ENOENT)", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    readFileMock.mockRejectedValueOnce(err);
    const result = await detectCopilotLocalModel();
    expect(result).toBeNull();
  });

  it("returns null when config.json is invalid JSON", async () => {
    readFileMock.mockResolvedValueOnce("{ not json");
    const result = await detectCopilotLocalModel();
    expect(result).toBeNull();
  });

  it("returns null when no model field is set", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ firstLaunchAt: "2026-04-27" }));
    const result = await detectCopilotLocalModel();
    expect(result).toBeNull();
  });

  it("returns null when model is empty string", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ model: "" }));
    const result = await detectCopilotLocalModel();
    expect(result).toBeNull();
  });

  it("returns null when model is non-string", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ model: 42 }));
    const result = await detectCopilotLocalModel();
    expect(result).toBeNull();
  });
});
