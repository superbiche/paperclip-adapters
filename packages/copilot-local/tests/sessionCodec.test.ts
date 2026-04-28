import { describe, expect, it } from "vitest";
import { sessionCodec } from "../src/server/sessionCodec.js";

describe("sessionCodec.deserialize", () => {
  it("returns null for non-object inputs", () => {
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("string")).toBeNull();
    expect(sessionCodec.deserialize(42)).toBeNull();
    expect(sessionCodec.deserialize([])).toBeNull();
  });

  it("returns null when sessionId is missing", () => {
    expect(sessionCodec.deserialize({ cwd: "/tmp" })).toBeNull();
    expect(sessionCodec.deserialize({ sessionId: "" })).toBeNull();
    expect(sessionCodec.deserialize({ sessionId: "   " })).toBeNull();
  });

  it("accepts both sessionId and session_id", () => {
    expect(sessionCodec.deserialize({ sessionId: "abc" })).toEqual({ sessionId: "abc" });
    expect(sessionCodec.deserialize({ session_id: "def" })).toEqual({ sessionId: "def" });
  });

  it("round-trips cwd / workdir / folder", () => {
    expect(sessionCodec.deserialize({ sessionId: "a", cwd: "/p1" })).toEqual({ sessionId: "a", cwd: "/p1" });
    expect(sessionCodec.deserialize({ sessionId: "a", workdir: "/p2" })).toEqual({ sessionId: "a", cwd: "/p2" });
    expect(sessionCodec.deserialize({ sessionId: "a", folder: "/p3" })).toEqual({ sessionId: "a", cwd: "/p3" });
  });

  it("round-trips workspaceId, repoUrl, repoRef (new in C5)", () => {
    expect(
      sessionCodec.deserialize({
        sessionId: "abc",
        workspaceId: "ws-1",
        repoUrl: "https://github.com/owner/repo",
        repoRef: "main",
      }),
    ).toEqual({
      sessionId: "abc",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/owner/repo",
      repoRef: "main",
    });
  });

  it("accepts snake_case aliases for the new fields", () => {
    expect(
      sessionCodec.deserialize({
        sessionId: "abc",
        workspace_id: "ws-1",
        repo_url: "https://github.com/o/r",
        repo_ref: "feat/x",
      }),
    ).toEqual({
      sessionId: "abc",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/o/r",
      repoRef: "feat/x",
    });
  });

  it("omits unset optional fields rather than emitting undefined", () => {
    const out = sessionCodec.deserialize({ sessionId: "abc" });
    expect(out).toEqual({ sessionId: "abc" });
    expect(out).not.toHaveProperty("cwd");
    expect(out).not.toHaveProperty("workspaceId");
    expect(out).not.toHaveProperty("repoUrl");
    expect(out).not.toHaveProperty("repoRef");
  });
});

describe("sessionCodec.serialize", () => {
  it("returns null for null input", () => {
    expect(sessionCodec.serialize(null)).toBeNull();
  });

  it("requires a sessionId", () => {
    expect(sessionCodec.serialize({ cwd: "/tmp" })).toBeNull();
    expect(sessionCodec.serialize({ sessionId: "" })).toBeNull();
  });

  it("round-trips the full enriched shape", () => {
    expect(
      sessionCodec.serialize({
        sessionId: "abc",
        cwd: "/work",
        workspaceId: "ws-1",
        repoUrl: "https://github.com/o/r",
        repoRef: "main",
      }),
    ).toEqual({
      sessionId: "abc",
      cwd: "/work",
      workspaceId: "ws-1",
      repoUrl: "https://github.com/o/r",
      repoRef: "main",
    });
  });
});

describe("sessionCodec.getDisplayId", () => {
  it("returns the sessionId for display", () => {
    expect(sessionCodec.getDisplayId({ sessionId: "abc" })).toBe("abc");
    expect(sessionCodec.getDisplayId({ session_id: "def" })).toBe("def");
  });

  it("returns null when no id present", () => {
    expect(sessionCodec.getDisplayId(null)).toBeNull();
    expect(sessionCodec.getDisplayId({})).toBeNull();
  });
});
