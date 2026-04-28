import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateCopilotToken,
  isCopilotAuthError,
  buildCopilotHeaders,
  resolveCopilotToken,
  discoverCopilotApiUrl,
  _resetEndpointCacheForTests,
} from "../src/server/auth.js";

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

function makeRunResult(
  stdout: string,
  exitCode: number = 0,
): Awaited<ReturnType<typeof runChildProcess>> {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: null,
    startedAt: null,
  };
}

describe("validateCopilotToken", () => {
  it("rejects empty / whitespace tokens", () => {
    expect(validateCopilotToken("").valid).toBe(false);
    expect(validateCopilotToken("   ").valid).toBe(false);
  });

  it("rejects classic PATs (ghp_)", () => {
    const result = validateCopilotToken("ghp_abc123def456");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/Classic personal access tokens/i);
  });

  it("accepts fine-grained PATs (github_pat_)", () => {
    expect(validateCopilotToken("github_pat_11ABC").valid).toBe(true);
  });

  it("accepts OAuth tokens (gho_)", () => {
    expect(validateCopilotToken("gho_abc123").valid).toBe(true);
  });

  it("accepts user-server tokens (ghu_)", () => {
    expect(validateCopilotToken("ghu_abc123").valid).toBe(true);
  });
});

describe("isCopilotAuthError", () => {
  it("matches 401/403 in any of message/stdout/stderr", () => {
    expect(isCopilotAuthError("HTTP 401 Unauthorized", "", "")).toBe(true);
    expect(isCopilotAuthError(null, "", "403 forbidden by policy")).toBe(true);
    expect(isCopilotAuthError(null, "auth required for /chat", "")).toBe(true);
  });

  it("matches invalid-token / unauthorized / not-authenticated phrasing", () => {
    expect(isCopilotAuthError("invalid token", "", "")).toBe(true);
    expect(isCopilotAuthError(null, "", "not authenticated")).toBe(true);
    expect(isCopilotAuthError(null, "unauthorized request", "")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isCopilotAuthError("timeout exceeded", "", "")).toBe(false);
    expect(isCopilotAuthError(null, "model not found", "")).toBe(false);
  });
});

describe("buildCopilotHeaders", () => {
  it("includes the bearer token + required client identification", () => {
    const headers = buildCopilotHeaders("test-token");
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Editor-Version"]).toMatch(/^vscode\//);
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
  });
});

describe("resolveCopilotToken", () => {
  beforeEach(() => {
    runChildProcessMock.mockReset();
  });

  it("prefers COPILOT_GITHUB_TOKEN over GH_TOKEN over GITHUB_TOKEN", async () => {
    const env = {
      COPILOT_GITHUB_TOKEN: "gho_copilot_specific",
      GH_TOKEN: "gho_gh",
      GITHUB_TOKEN: "gho_github",
    };
    const result = await resolveCopilotToken(env);
    expect(result?.token).toBe("gho_copilot_specific");
    expect(result?.source).toBe("env:COPILOT_GITHUB_TOKEN");
    expect(runChildProcessMock).not.toHaveBeenCalled();
  });

  it("falls back to GH_TOKEN when COPILOT_GITHUB_TOKEN absent", async () => {
    const result = await resolveCopilotToken({
      GH_TOKEN: "gho_gh_only",
    });
    expect(result?.token).toBe("gho_gh_only");
    expect(result?.source).toBe("env:GH_TOKEN");
  });

  it("rejects ghp_ env token and falls through to gh CLI", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("gho_from_gh\n"));
    const result = await resolveCopilotToken({
      GH_TOKEN: "ghp_classic_pat",
    });
    expect(result?.token).toBe("gho_from_gh");
    expect(result?.source).toBe("gh_cli");
  });

  it("calls gh auth token with --hostname for GHE", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("gho_ghe_token\n"));
    const result = await resolveCopilotToken({}, "foo.ghe.com");
    expect(result?.source).toBe("gh_cli:foo.ghe.com");
    const call = runChildProcessMock.mock.calls[0]!;
    expect(call[2]).toEqual(["auth", "token", "--hostname", "foo.ghe.com"]);
  });

  it("strips GH_TOKEN/GITHUB_TOKEN from gh CLI env so gh reads its own store", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("gho_clean\n"));
    await resolveCopilotToken({
      GH_TOKEN: "ghp_should_be_stripped",
      GITHUB_TOKEN: "ghp_also_stripped",
      PATH: "/usr/bin",
    });
    const call = runChildProcessMock.mock.calls[0]!;
    const passedEnv = (call[3] as { env: Record<string, string> }).env;
    expect(passedEnv.GH_TOKEN).toBeUndefined();
    expect(passedEnv.GITHUB_TOKEN).toBeUndefined();
    expect(passedEnv.PATH).toBe("/usr/bin");
  });

  it("returns null when gh CLI fails", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("", 1));
    const result = await resolveCopilotToken({});
    expect(result).toBeNull();
  });

  it("returns null when gh CLI throws", async () => {
    runChildProcessMock.mockRejectedValueOnce(new Error("gh: command not found"));
    const result = await resolveCopilotToken({});
    expect(result).toBeNull();
  });

  it("tokenSource=env skips gh CLI even if env has nothing", async () => {
    const result = await resolveCopilotToken({}, undefined, "env");
    expect(result).toBeNull();
    expect(runChildProcessMock).not.toHaveBeenCalled();
  });

  it("tokenSource=gh_cli skips env and goes straight to CLI", async () => {
    runChildProcessMock.mockResolvedValueOnce(makeRunResult("gho_cli\n"));
    const result = await resolveCopilotToken(
      { GH_TOKEN: "gho_env_should_be_ignored" },
      undefined,
      "gh_cli",
    );
    expect(result?.source).toBe("gh_cli");
    expect(runChildProcessMock).toHaveBeenCalled();
  });
});

describe("discoverCopilotApiUrl", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetEndpointCacheForTests();
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses api.github.com when no gheHost", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({
        login: "u",
        copilot_plan: "individual",
        chat_enabled: true,
        endpoints: { api: "https://api.individual.githubcopilot.com" },
      }),
    });
    const result = await discoverCopilotApiUrl("gho_abc");
    expect(result?.apiUrl).toBe("https://api.individual.githubcopilot.com");
    const call = fetchSpy.mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.github.com/copilot_internal/user");
  });

  it("uses api.<gheHost> when gheHost provided", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({
        endpoints: { api: "https://copilot-api.foo.ghe.com" },
      }),
    });
    await discoverCopilotApiUrl("gho_abc", "foo.ghe.com");
    const call = fetchSpy.mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.foo.ghe.com/copilot_internal/user");
  });

  it("strips trailing slashes from discovered URL", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({
        endpoints: { api: "https://api.individual.githubcopilot.com///" },
      }),
    });
    const result = await discoverCopilotApiUrl("gho_abc");
    expect(result?.apiUrl).toBe("https://api.individual.githubcopilot.com");
  });

  it("returns null on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({}),
    });
    const result = await discoverCopilotApiUrl("gho_abc");
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await discoverCopilotApiUrl("gho_abc");
    expect(result).toBeNull();
  });

  it("caches discovered URL keyed by token fingerprint + host", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({
        endpoints: { api: "https://api.individual.githubcopilot.com" },
      }),
    });
    const token = "gho_abcdef0123456789xyz";
    const a = await discoverCopilotApiUrl(token);
    const b = await discoverCopilotApiUrl(token);
    expect(a?.apiUrl).toBe(b?.apiUrl);
    // Second call hits cache, so only one fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not collide cache across different gheHosts for same token", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({
          endpoints: { api: "https://api.individual.githubcopilot.com" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(""),
        json: () => Promise.resolve({
          endpoints: { api: "https://copilot-api.foo.ghe.com" },
        }),
      });
    const token = "gho_abcdef0123456789xyz";
    const a = await discoverCopilotApiUrl(token);
    const b = await discoverCopilotApiUrl(token, "foo.ghe.com");
    expect(a?.apiUrl).toBe("https://api.individual.githubcopilot.com");
    expect(b?.apiUrl).toBe("https://copilot-api.foo.ghe.com");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
