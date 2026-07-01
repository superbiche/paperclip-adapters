import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
  joinPromptSections,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  ensurePaperclipSkillSymlink,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseCopilotJsonl,
  describeCopilotFailure,
  detectCopilotAuthRequired,
  isCopilotUnknownSessionError,
} from "./parse.js";
import { resolveCopilotToken, validateCopilotToken } from "./auth.js";
import { isValidGheHost } from "./models.js";
import { applyCopilotProviderEnv } from "./provider.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Ensure desired Paperclip-managed skills are present (as symlinks) in the
 * per-cwd cache dir, and prune stale entries. Returns warnings from any
 * symlink failures. The directory itself is set as `COPILOT_SKILLS_DIRS`
 * elsewhere in the runtime config builder.
 */
async function ensureCopilotSkillsInjected(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
  skillsCacheDir: string,
): Promise<string[]> {
  const allSkillsEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = resolvePaperclipDesiredSkillNames(config, allSkillsEntries);
  const desiredSet = new Set(desiredSkillNames);
  const skillsEntries = allSkillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (skillsEntries.length === 0) return [];

  await fs.mkdir(skillsCacheDir, { recursive: true });
  const warnings: string[] = [];
  const activeNames = new Set<string>();

  for (const entry of skillsEntries) {
    activeNames.add(entry.runtimeName);
    const target = path.join(skillsCacheDir, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stdout",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Copilot skill "${entry.runtimeName}" into ${skillsCacheDir}\n`,
      );
    } catch (err) {
      const msg = `Failed to inject Copilot skill "${entry.key}" into ${skillsCacheDir}: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(msg);
      await onLog("stderr", `[paperclip] ${msg}\n`);
    }
  }

  // Prune stale symlinks no longer in the desired set.
  const dirEntries = await fs.readdir(skillsCacheDir, { withFileTypes: true }).catch(() => []);
  for (const entry of dirEntries) {
    if (activeNames.has(entry.name) || !entry.isSymbolicLink()) continue;
    const target = path.join(skillsCacheDir, entry.name);
    await fs.unlink(target).catch(() => {});
    await onLog(
      "stdout",
      `[paperclip] Removed stale Copilot skill "${entry.name}" from ${skillsCacheDir}\n`,
    );
  }

  return warnings;
}

/**
 * Result of loading the Paperclip-managed agent instructions bundle.
 */
interface CopilotInstructionsBundle {
  /** Markdown block to prepend to the run prompt (empty when nothing loaded). */
  prompt: string;
  /** Absolute directory to expose to Copilot via `--add-dir` (empty when none). */
  addDir: string;
  /** Human-readable notes surfaced in adapter meta/diagnostics. */
  notes: string[];
  /** Total characters of instruction content injected into the prompt. */
  chars: number;
  /** Bundle files that were successfully loaded (basenames). */
  loadedFiles: string[];
}

// Cap the injected bundle so a misconfigured instructions directory cannot
// balloon the prompt. Paperclip's managed bundle is a handful of small files.
const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

/**
 * Load the Paperclip-managed agent instructions bundle and turn it into a
 * prompt preamble for the Copilot CLI.
 *
 * Paperclip advertises the bundle to adapters that set
 * `supportsInstructionsBundle: true` via three adapter-config keys:
 * - `instructionsFilePath`  — absolute path to the entry file (e.g. AGENTS.md)
 * - `instructionsRootPath`  — directory holding the full managed bundle
 * - `instructionsEntryFile` — the entry file's basename
 *
 * Copilot only natively auto-loads `AGENTS.md`; the operational contract that
 * drives issue checkout and, crucially, the *final issue disposition* lives in
 * sibling files (e.g. `HEARTBEAT.md`). We therefore concatenate the entry file
 * plus every other `*.md` in the bundle root into the prompt so the agent has
 * the complete operating contract on a fresh, non-resumed run. The root is also
 * returned for `--add-dir` so relative references and re-reads resolve.
 */
export async function loadCopilotInstructionsBundle(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<CopilotInstructionsBundle> {
  const empty: CopilotInstructionsBundle = {
    prompt: "",
    addDir: "",
    notes: [],
    chars: 0,
    loadedFiles: [],
  };

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsRootPath = asString(config.instructionsRootPath, "").trim();
  if (!instructionsFilePath && !instructionsRootPath) return empty;

  const rootDir = instructionsRootPath
    ? path.resolve(instructionsRootPath)
    : path.dirname(path.resolve(instructionsFilePath));
  const entryFile = instructionsFilePath ? path.resolve(instructionsFilePath) : "";

  // Ordered, de-duplicated list of bundle files: entry first, then remaining
  // top-level `*.md` files in the root (sorted for determinism).
  const files: string[] = [];
  const seen = new Set<string>();
  const pushFile = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    files.push(resolved);
  };
  if (entryFile) pushFile(entryFile);
  try {
    const dirEntries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const dirEntry of dirEntries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      pushFile(path.join(rootDir, dirEntry.name));
    }
  } catch {
    // Root unreadable (or only an entry file was supplied) — fall back to entry.
  }

  const sections: string[] = [];
  const loadedFiles: string[] = [];
  const notes: string[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (totalBytes >= MAX_INSTRUCTIONS_BYTES) {
      notes.push(`Skipped remaining instruction files after ${MAX_INSTRUCTIONS_BYTES} bytes.`);
      break;
    }
    try {
      // Read as raw bytes so the MAX_INSTRUCTIONS_BYTES cap is enforced on a
      // real byte boundary. Truncating a UTF-8 *string* by character count
      // (String.prototype.slice) overshoots the byte cap for multibyte content
      // and can also split a surrogate pair. StringDecoder.write() decodes only
      // the complete characters in the truncated buffer and drops any partial
      // trailing multibyte sequence, giving a clean byte-bounded slice.
      const raw = await fs.readFile(file);
      const remaining = MAX_INSTRUCTIONS_BYTES - totalBytes;
      const contents =
        raw.length > remaining
          ? new StringDecoder("utf8").write(raw.subarray(0, remaining))
          : raw.toString("utf8");
      totalBytes += Buffer.byteLength(contents, "utf8");
      const base = path.basename(file);
      sections.push(`===== ${base} =====\n${contents.trim()}`);
      loadedFiles.push(base);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read instructions file "${file}": ${reason}\n`,
      );
    }
  }

  if (sections.length === 0) {
    notes.push(
      `Configured instructions (file "${instructionsFilePath}", root "${instructionsRootPath}"), ` +
        `but no files could be read; continuing without injected instructions.`,
    );
    await onLog(
      "stdout",
      `[paperclip] Warning: instructions bundle configured but no files could be read.\n`,
    );
    return { ...empty, notes };
  }

  const preamble =
    `<paperclip_agent_instructions>\n` +
    `${sections.join("\n\n")}\n` +
    `</paperclip_agent_instructions>\n\n` +
    `The instructions above are your managed Paperclip operating contract, loaded from ${rootDir}${path.sep}. ` +
    `Follow them on every run: run the HEARTBEAT checklist, fetch and check out your assigned issue(s) via the Paperclip API, ` +
    `do the work, and end the run by updating the issue to a clear final disposition (done, in_review, blocked, or delegated) — ` +
    `never stop without recording a next step. Resolve any relative file references from ${rootDir}${path.sep}.`;

  await onLog(
    "stdout",
    `[paperclip] Loaded agent instructions bundle (${loadedFiles.join(", ")}) from ${rootDir}\n`,
  );
  notes.push(`Loaded instructions bundle: ${loadedFiles.join(", ")} (${totalBytes} bytes).`);

  return {
    prompt: preamble,
    addDir: rootDir,
    notes,
    chars: preamble.length,
    loadedFiles,
  };
}

interface CopilotRuntimeConfig {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
  /**
   * Where the GitHub auth token came from on this run, or `null` when no
   * token was resolved (the host's `~/.copilot/` state is the only auth path,
   * or provider-BYOK mode is active and the GitHub token is irrelevant).
   * Surfaced via `onMeta` for diagnostics; never logged in plaintext.
   */
  tokenSource: string | null;
  /**
   * When provider BYOK is active, the configured base URL. Surfaced via
   * `onMeta` so diagnostics can confirm which provider drove the run.
   */
  providerBaseUrl: string | null;
}

async function buildCopilotRuntimeConfig(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}): Promise<CopilotRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "copilot");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  // Local agent JWT: Paperclip mints a per-run token in `ctx.authToken` when the
  // adapter declares `supportsLocalAgentJwt: true`. Expose it as PAPERCLIP_API_KEY
  // (unless explicitly set via config.env) so the agent can authenticate its
  // Paperclip API calls — checkout, comments, and the final issue disposition.
  if (
    !(typeof env.PAPERCLIP_API_KEY === "string" && env.PAPERCLIP_API_KEY.trim().length > 0) &&
    authToken
  ) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // Provider BYOK takes precedence: when COPILOT_PROVIDER_BASE_URL is set
  // Copilot CLI bypasses GitHub auth entirely. Validation runs even when
  // `copilotProvider` is unset (no-op), so any later invalid attempt also
  // fails closed rather than silently injecting garbage env.
  const providerActivation = applyCopilotProviderEnv(env, config);

  // GitHub auth resolution chain — only meaningful when provider BYOK is NOT
  // active. Order: BYOK token (config.githubToken) > env (config.env +
  // process.env) > `gh auth token` CLI fallback. The resolved token is
  // injected into the spawn env as GH_TOKEN so Copilot CLI picks it up.
  // Malformed gheHost values are rejected up front (defense-in-depth on top
  // of the env-token gate in models.ts).
  const rawGheHost = config.gheHost;
  const gheHost =
    rawGheHost !== undefined && rawGheHost !== null && rawGheHost !== ""
      ? (isValidGheHost(rawGheHost) ? (rawGheHost as string).trim() : undefined)
      : undefined;
  const tokenSourceHint = asString(config.tokenSource, "auto");

  let tokenSource: string | null = null;
  const explicitToken = asString(config.githubToken, "").trim();
  if (explicitToken) {
    const validation = validateCopilotToken(explicitToken);
    if (validation.valid) {
      env.GH_TOKEN = explicitToken;
      tokenSource = "config:githubToken";
    }
  }

  if (!tokenSource && !providerActivation.active) {
    // Merge process.env + adapter env so resolveCopilotToken sees both.
    const searchEnv: Record<string, string | undefined> = { ...process.env, ...env };
    const resolved = await resolveCopilotToken(searchEnv, gheHost, tokenSourceHint);
    if (resolved) {
      env.GH_TOKEN = resolved.token;
      tokenSource = resolved.source;
    }
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    cwd,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
    tokenSource,
    providerBaseUrl: providerActivation.active ? (providerActivation.baseUrl ?? null) : null,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);

  const runtimeConfig = await buildCopilotRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const { command, cwd, env, timeoutSec, graceSec, extraArgs, tokenSource, providerBaseUrl } = runtimeConfig;

  // Skill injection (ephemeral): symlink Paperclip-managed skills into a
  // per-cwd cache, then point Copilot CLI at the cache via COPILOT_SKILLS_DIRS.
  // Empty `desiredSkills` → no-op (cache untouched, env var unset).
  const skillsCacheDir = path.join(cwd, ".paperclip", "copilot-skill-cache");
  await ensureCopilotSkillsInjected(config, onLog, skillsCacheDir);
  const skillCacheContents = await fs.readdir(skillsCacheDir).catch(() => [] as string[]);
  if (skillCacheContents.length > 0) {
    env.COPILOT_SKILLS_DIRS = skillsCacheDir;
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;

  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const instructionsBundle = await loadCopilotInstructionsBundle(config, onLog);
  const prompt = joinPromptSections([
    instructionsBundle.prompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);

  const buildCopilotArgs = (resumeSessionId: string | null) => {
    const args = ["-p", prompt, "--output-format", "json", "-s", "--no-color"];
    if (instructionsBundle.addDir) args.push("--add-dir", instructionsBundle.addDir);
    if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);
    if (dangerouslySkipPermissions) args.push("--allow-all");
    else args.push("--allow-all-tools");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildCopilotArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "copilot_local",
        command,
        cwd,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt,
        context: {
          ...context,
          // Surface auth provenance for diagnostics — never the secret itself.
          copilotTokenSource: tokenSource,
          copilotProviderBaseUrl: providerBaseUrl,
          // Surface instructions-bundle provenance for diagnostics.
          copilotInstructionsChars: instructionsBundle.chars,
          copilotInstructionsFiles: instructionsBundle.loadedFiles,
          copilotInstructionsAddDir: instructionsBundle.addDir || null,
          copilotInstructionsNotes: instructionsBundle.notes,
        },
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });

    const parsedStream = parseCopilotJsonl(proc.stdout);
    return { proc, parsedStream };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseCopilotJsonl>;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream } = attempt;
    const authMeta = detectCopilotAuthRequired({
      stdout: proc.stdout,
      stderr: proc.stderr,
    });

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const resolvedSessionId = parsedStream.sessionId ?? opts.fallbackSessionId;
    const resolvedSessionParams = resolvedSessionId
      ? ({ sessionId: resolvedSessionId, cwd } as Record<string, unknown>)
      : null;

    // Build error message from stderr (where Copilot puts its errors) and parsed result.
    const errorMessage =
      (proc.exitCode ?? 0) === 0
        ? null
        : describeCopilotFailure(parsedStream.resultJson, proc.stderr);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: authMeta.requiresLogin ? "copilot_auth_required" : null,
      usage: parsedStream.usage ?? undefined,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "github",
      biller: "github",
      model: parsedStream.model || model,
      billingType: "subscription",
      costUsd: null, // subscription-based, no per-run cost
      resultJson: parsedStream.resultJson,
      summary: parsedStream.summary,
      // Include stderr excerpt in resultJson when there's no JSONL output (error cases)
      ...(proc.stderr && !parsedStream.resultJson
        ? {
            resultJson: {
              stderr: proc.stderr,
              stdout: proc.stdout,
            },
          }
        : {}),
      clearSession: Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  // Run the initial attempt, with session resume if available.
  const initial = await runAttempt(sessionId ?? null);

  // Copilot outputs session errors to stderr with zero JSONL on stdout.
  // Check stderr (not parsed result) for unknown session detection.
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isCopilotUnknownSessionError(initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Copilot resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
  }

  return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
}
