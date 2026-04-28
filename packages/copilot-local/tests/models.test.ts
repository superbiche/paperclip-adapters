import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidGheHost, listCopilotLocalModels } from "../src/server/models.js";
import { _resetEndpointCacheForTests } from "../src/server/auth.js";
import { FALLBACK_MODELS } from "../src/index.js";

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess: vi.fn(),
  };
});

import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
const runChildProcessMock = vi.mocked(runChildProcess);

function makeRunResult(stdout: string, exitCode: number = 0) {
  return {
    exitCode,
    signal: null as string | null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: null as number | null,
    startedAt: null as string | null,
  };
}

function fakeJsonResponse(body: unknown, status: number = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(""),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("isValidGheHost", () => {
  it("accepts well-formed hostnames", () => {
    expect(isValidGheHost("foo.ghe.com")).toBe(true);
    expect(isValidGheHost("corp.example.org")).toBe(true);
    expect(isValidGheHost("a.b.c.d.e")).toBe(true);
    expect(isValidGheHost("github-enterprise.acme.io")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isValidGheHost(undefined)).toBe(false);
    expect(isValidGheHost(null)).toBe(false);
    expect(isValidGheHost(123)).toBe(false);
    expect(isValidGheHost({})).toBe(false);
    expect(isValidGheHost([])).toBe(false);
  });

  it("rejects empty / whitespace", () => {
    expect(isValidGheHost("")).toBe(false);
    expect(isValidGheHost("   ")).toBe(false);
  });

  it("rejects bare TLDs (no dot)", () => {
    expect(isValidGheHost("localhost")).toBe(false);
    expect(isValidGheHost("intranet")).toBe(false);
  });

  it("rejects URLs / schemes / paths / queries / ports / userinfo", () => {
    expect(isValidGheHost("https://attacker.com")).toBe(false);
    expect(isValidGheHost("//attacker.com")).toBe(false);
    expect(isValidGheHost("attacker.com/path")).toBe(false);
    expect(isValidGheHost("attacker.com:443")).toBe(false);
    expect(isValidGheHost("attacker.com?x=1")).toBe(false);
    expect(isValidGheHost("user@attacker.com")).toBe(false);
    expect(isValidGheHost("attacker.com#frag")).toBe(false);
  });

  it("rejects malformed labels", () => {
    expect(isValidGheHost(".foo.com")).toBe(false);
    expect(isValidGheHost("foo..com")).toBe(false);
    expect(isValidGheHost("-foo.com")).toBe(false);
    expect(isValidGheHost("foo-.com")).toBe(false);
  });

  it("rejects oversize hostnames", () => {
    const huge = "a".repeat(254);
    expect(isValidGheHost(huge)).toBe(false);
    expect(isValidGheHost(`${huge}.com`)).toBe(false);
  });
});

describe("listCopilotLocalModels", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    _resetEndpointCacheForTests();
    runChildProcessMock.mockReset();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...envSnapshot };
    vi.restoreAllMocks();
  });

  it("returns FALLBACK_MODELS when no token can be resolved", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("", 1));
    const result = await listCopilotLocalModels();
    expect(result).toEqual(FALLBACK_MODELS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches and parses real models when gh CLI succeeds", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("gho_real_token\n"));
    fetchSpy
      .mockResolvedValueOnce(
        fakeJsonResponse({
          endpoints: { api: "https://api.individual.githubcopilot.com" },
        }),
      )
      .mockResolvedValueOnce(
        fakeJsonResponse({
          data: [
            { id: "gpt-5", name: "GPT 5", capabilities: { type: "chat" } },
            { id: "claude-3.5", name: "Claude 3.5", vendor: "Anthropic", capabilities: { type: "chat" } },
            { id: "text-embedding-3", capabilities: { type: "embeddings" } },
            { id: "another-embedding-model", capabilities: { type: "chat" } },
          ],
        }),
      );

    const result = await listCopilotLocalModels();
    expect(result).toEqual([
      { id: "gpt-5", label: "GPT 5" },
      { id: "claude-3.5", label: "Claude 3.5 (Anthropic)" },
    ]);
  });

  it("falls back to FALLBACK_MODELS when /models returns empty", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("gho_real_token\n"));
    fetchSpy
      .mockResolvedValueOnce(
        fakeJsonResponse({ endpoints: { api: "https://api.individual.githubcopilot.com" } }),
      )
      .mockResolvedValueOnce(fakeJsonResponse({ data: [] }));

    const result = await listCopilotLocalModels();
    expect(result).toEqual(FALLBACK_MODELS);
  });

  it("uses env-token fallback when gh CLI yields nothing AND no gheHost", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("", 1));
    process.env.GH_TOKEN = "gho_env_token";
    fetchSpy
      .mockResolvedValueOnce(
        fakeJsonResponse({ endpoints: { api: "https://api.individual.githubcopilot.com" } }),
      )
      .mockResolvedValueOnce(
        fakeJsonResponse({ data: [{ id: "gpt-5", name: "GPT 5" }] }),
      );

    const result = await listCopilotLocalModels();
    expect(result).toEqual([{ id: "gpt-5", label: "GPT 5" }]);
  });

  it("rejects ghp_ env-token even on default host", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("", 1));
    process.env.GH_TOKEN = "ghp_classic_pat";
    const result = await listCopilotLocalModels();
    expect(result).toEqual(FALLBACK_MODELS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT use env-token fallback when a valid gheHost is set (SSRF guard)", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("", 1));
    process.env.GH_TOKEN = "gho_env_token";
    const result = await listCopilotLocalModels({ gheHost: "foo.ghe.com" });
    expect(result).toEqual(FALLBACK_MODELS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back when malformed gheHost is supplied (defense-in-depth)", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("", 1));
    process.env.GH_TOKEN = "gho_env_token";
    // attacker-controlled URL-shaped gheHost — must be rejected.
    // After rejection, we treat as default github.com and the env-token
    // path opens up (which is safe for github.com).
    fetchSpy
      .mockResolvedValueOnce(
        fakeJsonResponse({ endpoints: { api: "https://api.individual.githubcopilot.com" } }),
      )
      .mockResolvedValueOnce(fakeJsonResponse({ data: [{ id: "ok", name: "ok" }] }));

    const result = await listCopilotLocalModels({ gheHost: "https://attacker.com" });
    // Got real models — proves we reset to default github.com after rejecting the bad host.
    expect(result).toEqual([{ id: "ok", label: "ok" }]);
    // gh CLI was invoked with the safe default host (--hostname github.com),
    // never the attacker-controlled string.
    const ghCall = runChildProcessMock.mock.calls[0]!;
    expect(ghCall[2]).toEqual(["auth", "token", "--hostname", "github.com"]);
  });

  it("calls gh auth token --hostname for valid gheHost", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("gho_ghe_token\n"));
    fetchSpy
      .mockResolvedValueOnce(
        fakeJsonResponse({ endpoints: { api: "https://copilot-api.foo.ghe.com" } }),
      )
      .mockResolvedValueOnce(fakeJsonResponse({ data: [{ id: "ghe-model", name: "GHE Model" }] }));

    const result = await listCopilotLocalModels({ gheHost: "foo.ghe.com" });
    expect(result).toEqual([{ id: "ghe-model", label: "GHE Model" }]);
    const ghCall = runChildProcessMock.mock.calls[0]!;
    expect(ghCall[2]).toEqual(["auth", "token", "--hostname", "foo.ghe.com"]);
  });

  it("returns FALLBACK_MODELS when /models returns a non-retryable error", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("gho_real_token\n"));
    fetchSpy
      .mockResolvedValueOnce(
        fakeJsonResponse({ endpoints: { api: "https://api.individual.githubcopilot.com" } }),
      )
      // 500 is NOT in the default retryableStatuses set — fetchWithRetry returns immediately,
      // which lets fetchModelsWithToken exit with [] and trigger the fallback path.
      .mockResolvedValueOnce(fakeJsonResponse({}, 500));

    const result = await listCopilotLocalModels();
    expect(result).toEqual(FALLBACK_MODELS);
  });
});
