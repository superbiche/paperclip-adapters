/**
 * Copilot CLI custom-provider BYOK helpers.
 *
 * Copilot CLI 1.0.x ships a "Custom Model Providers (BYOK)" mode activated
 * when `COPILOT_PROVIDER_BASE_URL` is set in the spawn env. In that mode,
 * GitHub authentication is not required — Copilot routes its prompts directly
 * to the configured provider (any OpenAI-compatible endpoint, Anthropic API,
 * or Azure OpenAI deployment).
 *
 * This module reads the agent's `adapterConfig.copilotProvider` and emits
 * the corresponding `COPILOT_PROVIDER_*` + `COPILOT_MODEL` env vars into the
 * spawn env, with strict validation up front:
 *   - `baseUrl` must parse as `http(s)://...` with no embedded credentials.
 *   - `type` must be one of `openai` | `azure` | `anthropic`.
 *   - `wireApi` must be one of `completions` | `responses`.
 *
 * Reference: `copilot help providers` (Copilot CLI 1.0.37).
 */

const VALID_PROVIDER_TYPES = ["openai", "azure", "anthropic"] as const;
type ProviderType = (typeof VALID_PROVIDER_TYPES)[number];

const VALID_WIRE_APIS = ["completions", "responses"] as const;
type WireApi = (typeof VALID_WIRE_APIS)[number];

export interface CopilotProviderActivation {
  /** True when the spawn env was configured with COPILOT_PROVIDER_BASE_URL. */
  active: boolean;
  /** The activated base URL (already validated). */
  baseUrl?: string;
  /** Provider type ("openai" | "azure" | "anthropic"). */
  type?: ProviderType;
  /** Validation errors keyed by config field path. Non-empty → activation skipped. */
  errors: Array<{ field: string; reason: string }>;
}

/**
 * Validate a provider base URL.
 *
 * Accepts: `http://` and `https://` URLs without embedded userinfo or query.
 * Hostname/IP/port are allowed (Ollama, llama.cpp, vLLM all use LAN URLs).
 * Path is allowed (most providers want `/v1` or similar).
 *
 * Rejects: non-string, non-URL, javascript:/file:/data: schemes, embedded
 * `user:pass@`, fragments. Length-capped at 2048.
 */
export function isValidProviderBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.hash !== "") return false;
  return true;
}

function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && (VALID_PROVIDER_TYPES as readonly string[]).includes(value);
}

function isWireApi(value: unknown): value is WireApi {
  return typeof value === "string" && (VALID_WIRE_APIS as readonly string[]).includes(value);
}

/**
 * Read `config.copilotProvider` and apply COPILOT_PROVIDER_* env vars to the
 * spawn env. Mutates `env` in place. Returns activation status + any
 * validation errors.
 *
 * Token-only fields (`apiKey`, `bearerToken`) are NEVER logged. The caller
 * passes the env down to `runChildProcess`, which redacts known-secret keys
 * via `redactEnvForLogs`.
 *
 * If `copilotProvider` is unset/empty/invalid, the env is left untouched
 * and `active: false` is returned. Callers can check `errors.length` to
 * surface configuration mistakes via the env-test diagnostic path.
 */
export function applyCopilotProviderEnv(
  env: Record<string, string>,
  config: Record<string, unknown>,
): CopilotProviderActivation {
  const errors: Array<{ field: string; reason: string }> = [];
  const raw = config.copilotProvider;
  if (raw === undefined || raw === null) {
    return { active: false, errors };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ field: "copilotProvider", reason: "must be an object" });
    return { active: false, errors };
  }
  const provider = raw as Record<string, unknown>;

  // baseUrl is the activation gate.
  const rawBaseUrl = provider.baseUrl;
  if (rawBaseUrl === undefined || rawBaseUrl === null || rawBaseUrl === "") {
    // No baseUrl → BYOK provider mode is not requested. Other fields
    // become inert (we don't error on them — a partial config might be
    // a UI-construction in progress).
    return { active: false, errors };
  }
  if (!isValidProviderBaseUrl(rawBaseUrl)) {
    errors.push({
      field: "copilotProvider.baseUrl",
      reason: "must be an http(s) URL without userinfo or fragment",
    });
    return { active: false, errors };
  }
  const baseUrl = (rawBaseUrl as string).trim();

  // type defaults to "openai".
  const rawType = provider.type;
  let type: ProviderType = "openai";
  if (rawType !== undefined && rawType !== null && rawType !== "") {
    if (!isProviderType(rawType)) {
      errors.push({
        field: "copilotProvider.type",
        reason: `must be one of ${VALID_PROVIDER_TYPES.join(" | ")}`,
      });
      return { active: false, errors };
    }
    type = rawType;
  }

  // wireApi defaults to Copilot CLI's default ("completions"); only emit env
  // when explicitly set so the CLI's own default applies.
  const rawWireApi = provider.wireApi;
  let wireApi: WireApi | undefined;
  if (rawWireApi !== undefined && rawWireApi !== null && rawWireApi !== "") {
    if (!isWireApi(rawWireApi)) {
      errors.push({
        field: "copilotProvider.wireApi",
        reason: `must be one of ${VALID_WIRE_APIS.join(" | ")}`,
      });
      return { active: false, errors };
    }
    wireApi = rawWireApi;
  }

  // bearerToken takes precedence over apiKey per Copilot CLI docs.
  const bearerToken = typeof provider.bearerToken === "string" ? provider.bearerToken.trim() : "";
  const apiKey = typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";

  const azureApiVersion =
    typeof provider.azureApiVersion === "string" ? provider.azureApiVersion.trim() : "";
  const modelId = typeof provider.modelId === "string" ? provider.modelId.trim() : "";
  const wireModel = typeof provider.wireModel === "string" ? provider.wireModel.trim() : "";

  const numericField = (raw: unknown): number | null =>
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  const maxPromptTokens = numericField(provider.maxPromptTokens);
  const maxOutputTokens = numericField(provider.maxOutputTokens);

  // All gates passed — write env.
  env.COPILOT_PROVIDER_BASE_URL = baseUrl;
  env.COPILOT_PROVIDER_TYPE = type;
  if (wireApi) env.COPILOT_PROVIDER_WIRE_API = wireApi;
  if (bearerToken) env.COPILOT_PROVIDER_BEARER_TOKEN = bearerToken;
  if (apiKey && !bearerToken) env.COPILOT_PROVIDER_API_KEY = apiKey;
  if (type === "azure" && azureApiVersion) {
    env.COPILOT_PROVIDER_AZURE_API_VERSION = azureApiVersion;
  }
  if (modelId) env.COPILOT_PROVIDER_MODEL_ID = modelId;
  if (wireModel) env.COPILOT_PROVIDER_WIRE_MODEL = wireModel;
  if (maxPromptTokens !== null) {
    env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS = String(maxPromptTokens);
  }
  if (maxOutputTokens !== null) {
    env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  }

  return { active: true, baseUrl, type, errors };
}
