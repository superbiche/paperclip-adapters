/**
 * Copilot model discovery for copilot_local.
 *
 * Fetches available models from the Copilot API. When a `gheHost` hint is
 * provided (from the agent's adapterConfig), uses the GHE token; otherwise
 * uses the default github.com token.
 *
 * The models endpoint URL is discovered dynamically via /copilot_internal/user.
 * Falls back to a hardcoded list (`FALLBACK_MODELS` in src/index.ts) when the
 * API call fails or no token is available — graceful-degradation so the agent
 * config UI always renders something.
 *
 * Ported from paperclipai/paperclip#3629 (HearthCore). Defense-in-depth
 * gheHost format validation added on top of the upstream env-token gate
 * (Greptile P1 #3629). Per-process state — endpoint cache + token cache live
 * in `auth.ts`.
 */
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { buildCopilotHeaders, discoverCopilotApiUrl } from "./auth.js";
import { fetchWithRetry } from "./fetch-with-retry.js";
import { FALLBACK_MODELS } from "../index.js";

/**
 * Validate a `gheHost` hint against a strict hostname pattern.
 *
 * Defense-in-depth: even though `auth.ts`/`models.ts` already gate env-token
 * fallback on `!gheHost` (the Greptile P1 fix from #3629), an attacker who
 * supplies a malformed `gheHost` like `attacker.com:443/x` could still cause
 * `gh auth token --hostname` to call out to a controlled host. We reject
 * anything that doesn't look like a bare DNS hostname before any side-effect.
 *
 * Accepted:  `foo.ghe.com`, `corp.example.org`, `bar.baz.qux`
 * Rejected:  empty, slashes, colons, schemes, query, ports, embedded auth
 */
export function isValidGheHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;
  // RFC 1123 hostname: labels of [a-z0-9] with hyphens (not at edges),
  // separated by dots. At least one dot (we don't allow bare TLDs as gheHost).
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
    trimmed,
  );
}

/**
 * Get an auth token for a specific GitHub host via `gh auth token`.
 * Strips GITHUB_TOKEN/GH_TOKEN from env so gh reads from its own credential store.
 */
async function getTokenForHost(host?: string): Promise<string | null> {
  try {
    const args = ["auth", "token"];
    if (host) args.push("--hostname", host);
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .filter(([k]) => k !== "GITHUB_TOKEN" && k !== "GH_TOKEN"),
    );
    const result = await runChildProcess(
      `copilot-token-${host ?? "default"}-${Date.now()}`,
      "gh",
      args,
      {
        cwd: process.cwd(),
        env: cleanEnv,
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    const token = (result.stdout ?? "").trim();
    if (token && (result.exitCode ?? 1) === 0 && !token.startsWith("ghp_")) {
      return token;
    }
  } catch {
    // ignore
  }
  return null;
}

interface CopilotModelRaw {
  id?: string;
  name?: string;
  model_picker_enabled?: boolean;
  vendor?: string;
  capabilities?: {
    type?: string;
  };
}

/**
 * Fetch models from the Copilot API using a specific token and discovered URL.
 * Only filters out embedding models — everything else is shown.
 */
async function fetchModelsWithToken(
  token: string,
  gheHost?: string,
): Promise<Array<{ id: string; label: string }>> {
  const discovered = await discoverCopilotApiUrl(token, gheHost);
  const baseUrl = discovered?.apiUrl ?? "https://api.githubcopilot.com";

  try {
    const response = await fetchWithRetry(`${baseUrl}/models`, {
      method: "GET",
      headers: buildCopilotHeaders(token),
    }, {
      timeoutMs: 10_000,
      maxRetries: 2,
      retryableStatuses: [429, 502, 503, 504],
    });
    if (!response.ok) return [];

    const body = (await response.json()) as unknown;
    const data = Array.isArray(body)
      ? (body as unknown[])
      : Array.isArray((body as Record<string, unknown>)?.data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : null;
    if (!data) return [];

    const models: Array<{ id: string; label: string }> = [];
    for (const item of data) {
      const m = item as CopilotModelRaw;
      if (!m.id) continue;
      if (m.capabilities?.type === "embeddings") continue;
      if (m.id.includes("embedding")) continue;

      const label = m.name ?? m.id;
      const vendorHint =
        m.vendor && m.vendor !== "Azure OpenAI" && m.vendor !== "OpenAI"
          ? ` (${m.vendor})`
          : "";
      models.push({ id: m.id, label: `${label}${vendorHint}` });
    }

    // Deduplicate by id
    const seen = new Map<string, { id: string; label: string }>();
    for (const model of models) {
      if (!seen.has(model.id)) {
        seen.set(model.id, model);
      }
    }
    return Array.from(seen.values());
  } catch {
    return [];
  }
}

/**
 * Discover available Copilot models dynamically.
 *
 * @param hints - Optional config hints (typically from the agent's persisted config).
 *   `hints.gheHost` — GitHub Enterprise hostname for token resolution.
 *
 * The env-token fallback path is gated on `!gheHost` (already in #3629 source)
 * AND on `gheHost` passing strict hostname validation (defense-in-depth added
 * here): a malformed `gheHost` is rejected up front rather than passed to
 * `gh auth token --hostname` or used to construct an API URL.
 */
export async function listCopilotLocalModels(
  hints?: Record<string, unknown>,
): Promise<Array<{ id: string; label: string }>> {
  const rawGheHost = hints?.gheHost;
  // Reject malformed gheHost values up front — never reach the token fetch
  // or the API URL construction with anything that isn't a clean hostname.
  const gheHost =
    rawGheHost !== undefined && rawGheHost !== null && rawGheHost !== ""
      ? (isValidGheHost(rawGheHost) ? (rawGheHost as string).trim() : undefined)
      : undefined;

  const tokenHost = gheHost ?? "github.com";
  const token = await getTokenForHost(tokenHost);
  if (!token) {
    // Try env vars as fallback — but ONLY for the default host (github.com).
    // Sending env-var tokens to an arbitrary gheHost would allow token
    // exfiltration via a user-controlled hostname (SSRF / credential leak).
    if (!gheHost) {
      const envToken =
        process.env.COPILOT_GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim();
      if (envToken && !envToken.startsWith("ghp_")) {
        const models = await fetchModelsWithToken(envToken, undefined);
        return models.length > 0 ? models : FALLBACK_MODELS;
      }
    }
    return FALLBACK_MODELS;
  }

  const models = await fetchModelsWithToken(token, gheHost);
  return models.length > 0 ? models : FALLBACK_MODELS;
}
