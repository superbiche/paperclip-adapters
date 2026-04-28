import { describe, expect, it } from "vitest";
import {
  applyCopilotProviderEnv,
  isValidProviderBaseUrl,
} from "../src/server/provider.js";

describe("isValidProviderBaseUrl", () => {
  it("accepts http and https URLs with hosts/IPs/ports/paths", () => {
    expect(isValidProviderBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isValidProviderBaseUrl("https://api.anthropic.com/v1")).toBe(true);
    expect(isValidProviderBaseUrl("http://192.168.1.91:8000/v1")).toBe(true);
    expect(isValidProviderBaseUrl("https://my.proxy.example.com/llm/v1/")).toBe(true);
  });

  it("rejects non-string / empty", () => {
    expect(isValidProviderBaseUrl(undefined)).toBe(false);
    expect(isValidProviderBaseUrl(null)).toBe(false);
    expect(isValidProviderBaseUrl(123)).toBe(false);
    expect(isValidProviderBaseUrl({})).toBe(false);
    expect(isValidProviderBaseUrl("")).toBe(false);
    expect(isValidProviderBaseUrl("   ")).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isValidProviderBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isValidProviderBaseUrl("javascript:alert(1)")).toBe(false);
    expect(isValidProviderBaseUrl("data:text/plain,hi")).toBe(false);
    expect(isValidProviderBaseUrl("ftp://example.com/")).toBe(false);
    expect(isValidProviderBaseUrl("ws://example.com/")).toBe(false);
  });

  it("rejects URLs with embedded userinfo (credential leak vector)", () => {
    expect(isValidProviderBaseUrl("http://user@example.com/v1")).toBe(false);
    expect(isValidProviderBaseUrl("https://user:pass@example.com/v1")).toBe(false);
  });

  it("rejects URLs with fragments", () => {
    expect(isValidProviderBaseUrl("https://example.com/v1#frag")).toBe(false);
  });

  it("rejects garbage / unparseable inputs", () => {
    expect(isValidProviderBaseUrl("not a url")).toBe(false);
    expect(isValidProviderBaseUrl("//attacker.com")).toBe(false);
  });

  it("caps at 2048 chars", () => {
    const huge = "https://example.com/" + "a".repeat(2100);
    expect(isValidProviderBaseUrl(huge)).toBe(false);
  });
});

describe("applyCopilotProviderEnv", () => {
  function freshEnv(): Record<string, string> {
    return {};
  }

  it("is a no-op when copilotProvider is missing", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, {});
    expect(r.active).toBe(false);
    expect(r.errors).toEqual([]);
    expect(env).toEqual({});
  });

  it("is a no-op when copilotProvider has no baseUrl", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, {
      copilotProvider: { type: "openai", apiKey: "x" },
    });
    expect(r.active).toBe(false);
    expect(r.errors).toEqual([]);
    expect(env).toEqual({});
  });

  it("errors when copilotProvider is not an object", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, { copilotProvider: "string" });
    expect(r.active).toBe(false);
    expect(r.errors).toEqual([{ field: "copilotProvider", reason: "must be an object" }]);
    expect(env).toEqual({});
  });

  it("errors on malformed baseUrl and writes nothing", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, {
      copilotProvider: { baseUrl: "javascript:alert(1)", apiKey: "x" },
    });
    expect(r.active).toBe(false);
    expect(r.errors).toEqual([
      {
        field: "copilotProvider.baseUrl",
        reason: "must be an http(s) URL without userinfo or fragment",
      },
    ]);
    expect(env).toEqual({});
  });

  it("errors on invalid type and writes nothing", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, {
      copilotProvider: { baseUrl: "http://localhost:11434/v1", type: "deepseek" },
    });
    expect(r.active).toBe(false);
    expect(r.errors[0]?.field).toBe("copilotProvider.type");
    expect(env).toEqual({});
  });

  it("errors on invalid wireApi and writes nothing", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, {
      copilotProvider: {
        baseUrl: "http://localhost:11434/v1",
        wireApi: "graphql",
      },
    });
    expect(r.active).toBe(false);
    expect(r.errors[0]?.field).toBe("copilotProvider.wireApi");
    expect(env).toEqual({});
  });

  it("activates with defaults — type=openai, no wireApi env", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, {
      copilotProvider: { baseUrl: "http://localhost:11434/v1" },
    });
    expect(r.active).toBe(true);
    expect(r.type).toBe("openai");
    expect(r.baseUrl).toBe("http://localhost:11434/v1");
    expect(env).toEqual({
      COPILOT_PROVIDER_BASE_URL: "http://localhost:11434/v1",
      COPILOT_PROVIDER_TYPE: "openai",
    });
  });

  it("emits all the env vars when fully specified", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, {
      copilotProvider: {
        baseUrl: "https://api.example.com/v1",
        type: "openai",
        apiKey: "sk-fake",
        wireApi: "responses",
        modelId: "gpt-5.4",
        wireModel: "fine-tuned-name",
        maxPromptTokens: 100000,
        maxOutputTokens: 8000,
      },
    });
    expect(r.active).toBe(true);
    expect(env).toEqual({
      COPILOT_PROVIDER_BASE_URL: "https://api.example.com/v1",
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_WIRE_API: "responses",
      COPILOT_PROVIDER_API_KEY: "sk-fake",
      COPILOT_PROVIDER_MODEL_ID: "gpt-5.4",
      COPILOT_PROVIDER_WIRE_MODEL: "fine-tuned-name",
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "100000",
      COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "8000",
    });
  });

  it("bearerToken takes precedence over apiKey (Copilot CLI doc)", () => {
    const env = freshEnv();
    applyCopilotProviderEnv(env, {
      copilotProvider: {
        baseUrl: "https://example.com/v1",
        bearerToken: "bear-token",
        apiKey: "sk-fake",
      },
    });
    expect(env.COPILOT_PROVIDER_BEARER_TOKEN).toBe("bear-token");
    expect(env.COPILOT_PROVIDER_API_KEY).toBeUndefined();
  });

  it("emits azureApiVersion only when type=azure", () => {
    const a: Record<string, string> = {};
    applyCopilotProviderEnv(a, {
      copilotProvider: {
        baseUrl: "https://my.openai.azure.com/v1",
        type: "azure",
        azureApiVersion: "2024-08-01",
      },
    });
    expect(a.COPILOT_PROVIDER_AZURE_API_VERSION).toBe("2024-08-01");

    const b: Record<string, string> = {};
    applyCopilotProviderEnv(b, {
      copilotProvider: {
        baseUrl: "http://localhost:11434/v1",
        type: "openai",
        azureApiVersion: "2024-08-01",
      },
    });
    expect(b.COPILOT_PROVIDER_AZURE_API_VERSION).toBeUndefined();
  });

  it("ignores zero / negative / NaN numeric overrides", () => {
    const env = freshEnv();
    applyCopilotProviderEnv(env, {
      copilotProvider: {
        baseUrl: "https://example.com/v1",
        maxPromptTokens: 0,
        maxOutputTokens: -1,
      },
    });
    expect(env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS).toBeUndefined();
    expect(env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it("anthropic type works", () => {
    const env = freshEnv();
    const r = applyCopilotProviderEnv(env, {
      copilotProvider: {
        baseUrl: "https://api.anthropic.com/v1",
        type: "anthropic",
        apiKey: "sk-ant-fake",
      },
    });
    expect(r.active).toBe(true);
    expect(r.type).toBe("anthropic");
    expect(env.COPILOT_PROVIDER_TYPE).toBe("anthropic");
  });
});
