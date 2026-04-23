import fs from "node:fs/promises";
import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  isClineAuthRequiredError,
  isClineUnknownTaskError,
  parseClineOutput,
} from "./parse.js";

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasOption(args: string[], names: string[]): boolean {
  for (const raw of args) {
    const arg = raw?.trim();
    if (!arg) continue;
    if (names.includes(arg)) return true;
    if (names.some((name) => name.startsWith("--") && arg.startsWith(`${name}=`))) return true;
  }
  return false;
}

function resolveEnvValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "plain" && typeof record.value === "string") return record.value;
  return null;
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (paperclipKeys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "PAPERCLIP_API_URL") || !hasNonEmptyEnvValue(env, "PAPERCLIP_API_KEY")) return "";
  return [
    "Paperclip API access note:",
    "Use shell commands with curl for Paperclip API calls.",
    "Fast path:",
    "- If PAPERCLIP_TASK_ID is set, start with GET $PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/heartbeat-context",
    "- Only query /api/agents/me/inbox-lite when PAPERCLIP_TASK_ID is missing or unusable",
    "- Add X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on all modifying requests",
    "",
    "",
  ].join("\n");
}

interface WakeContextNoteInput {
  taskId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  linkedIssueIds: string[];
  workspaceCwd: string;
  workspaceSource: string;
}

function renderWakeContextNote(input: WakeContextNoteInput): string {
  const lines: string[] = [];
  if (input.taskId) {
    lines.push(`- This heartbeat was triggered for issue/task ${input.taskId}. Prioritize it first if it is assigned to you.`);
  }
  if (input.wakeReason) {
    lines.push(`- Wake reason: ${input.wakeReason}.`);
  }
  if (input.wakeReason === "issue_assigned") {
    lines.push("- Do not spend a tool call checking for assigned issues before you start. This wake already identifies the task to begin with.");
  }
  if (input.wakeCommentId) {
    lines.push(`- Triggering comment id: ${input.wakeCommentId}. Read that comment thread first when relevant.`);
  }
  if (input.linkedIssueIds.length > 0) {
    lines.push(`- Linked issue ids: ${input.linkedIssueIds.join(", ")}.`);
  }
  if (input.workspaceCwd) {
    lines.push(`- Working directory for this run: ${input.workspaceCwd}.`);
  }
  if (input.workspaceSource) {
    lines.push(`- Workspace source: ${input.workspaceSource}.`);
  }
  if (lines.length === 0) return "";
  return ["Paperclip wake context:", ...lines, "", ""].join("\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const command = asString(config.command, "cline").trim();
  const model = asString(config.model, "").trim();
  const configDir = asString(config.configDir, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? (context.paperclipWorkspaces as unknown[]).filter(
        (value) => typeof value === "object" && value !== null,
      )
    : [];

  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  if (configDir.length === 0) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "cline_local: adapterConfig.configDir is required (absolute path to a pre-authenticated Cline --config directory).",
      errorCode: "cline_config_dir_missing",
    };
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    PAPERCLIP_RUN_ID: runId,
  };

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? (context.issueIds as unknown[]).filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    const resolved = resolveEnvValue(value);
    if (resolved !== null) env[key] = resolved;
  }
  if (!(typeof env.PAPERCLIP_API_KEY === "string" && env.PAPERCLIP_API_KEY.trim().length > 0) && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 600);
  const graceSec = asNumber(config.graceSec, 20);
  const clineTimeoutSec = Math.max(timeoutSec - graceSec, 30);

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeTaskId = asString(
    runtimeSessionParams.taskId,
    asString(runtimeSessionParams.sessionId, runtime.sessionId ?? ""),
  ).trim();
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "").trim();
  const canResumeSession =
    runtimeTaskId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const resumeTaskId = canResumeSession ? runtimeTaskId : null;
  if (runtimeTaskId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Cline task "${runtimeTaskId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath ? path.resolve(cwd, instructionsFilePath) : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsReadFailed = false;
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.`;
    } catch (err) {
      instructionsReadFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData: Record<string, unknown> = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !resumeTaskId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const wakeContextNote = renderWakeContextNote({
    taskId: wakeTaskId,
    wakeReason,
    wakeCommentId,
    linkedIssueIds,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
  });

  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    wakeContextNote,
    paperclipEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);

  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: wakeContextNote.length + paperclipEnvNote.length + apiAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const commandNotes = [
    "Prompt is passed as Cline's positional argument.",
    "Paperclip forces -a -y --json --config <dir> -c <cwd> --timeout <sec> for headless acting runs and stable transcript parsing.",
  ];
  if (resolvedInstructionsFilePath) {
    if (instructionsReadFailed) {
      commandNotes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
    } else {
      commandNotes.push(
        `Loaded agent instructions from ${resolvedInstructionsFilePath}.`,
        `Prepended instructions and a relative-path directive based on ${instructionsDir}.`,
      );
    }
  }

  const buildArgs = (resumeId: string | null): string[] => {
    const args: string[] = [];
    if (!hasOption(extraArgs, ["-a", "--act", "-p", "--plan"])) args.push("-a");
    if (!hasOption(extraArgs, ["-y", "--yolo"])) args.push("-y");
    if (!hasOption(extraArgs, ["--json"])) args.push("--json");
    if (!hasOption(extraArgs, ["--config"])) {
      args.push("--config", configDir);
    }
    if (model && !hasOption(extraArgs, ["--model", "-m"])) {
      args.push("-m", model);
    }
    if (!hasOption(extraArgs, ["--cwd", "-c"])) {
      args.push("-c", cwd);
    }
    if (!hasOption(extraArgs, ["--timeout", "-t"])) {
      args.push("--timeout", String(clineTimeoutSec));
    }
    if (resumeId) {
      args.push("--taskId", resumeId);
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push(prompt);
    return args;
  };

  const runAttempt = async (resumeId: string | null) => {
    const args = buildArgs(resumeId);
    if (onMeta) {
      await onMeta({
        adapterType: "cline_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    let stdoutBuffer = "";
    let watchdogTriggered = false;
    let watchdogSubtype: string | null = null;
    let watchdogText = "";
    const hangProneRegex = /"ask"\s*:\s*"(followup|mistake_limit_reached|plan_mode_respond|act_mode_respond)"/;

    const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
      if (stream === "stderr") {
        await onLog(stream, chunk);
        return;
      }
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        if (!watchdogTriggered && hangProneRegex.test(line)) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const ask = typeof parsed.ask === "string" ? parsed.ask : null;
            if (
              ask === "followup" ||
              ask === "mistake_limit_reached" ||
              ask === "plan_mode_respond" ||
              ask === "act_mode_respond"
            ) {
              watchdogTriggered = true;
              watchdogSubtype = ask;
              watchdogText = typeof parsed.text === "string" ? parsed.text : "";
              await onLog(
                "stdout",
                `[paperclip] Cline emitted hang-prone ask "${ask}"; killing run.\n`,
              );
              const running = (await import("@paperclipai/adapter-utils/server-utils")).runningProcesses.get(runId);
              running?.child.kill("SIGTERM");
            }
          } catch {
            // ignore parse errors
          }
        }
        await onLog(stream, `${line}\n`);
      }
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: bufferedOnLog,
    });
    if (stdoutBuffer) {
      await onLog("stdout", stdoutBuffer);
    }

    return {
      proc,
      parsed: parseClineOutput(proc.stdout),
      watchdog: watchdogTriggered ? { subtype: watchdogSubtype ?? "unknown", text: watchdogText } : null,
    };
  };

  type AttemptResult = Awaited<ReturnType<typeof runAttempt>>;

  const toResult = (attempt: AttemptResult, clearOnMissingSession = false, isRetry = false): AdapterExecutionResult => {
    const authRequired = isClineAuthRequiredError(
      `${attempt.parsed.errorMessage ?? ""}\n${attempt.proc.stdout}\n${attempt.proc.stderr}`,
    );
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authRequired ? "cline_auth_required" : null,
        clearSession: clearOnMissingSession,
      };
    }

    const resolvedTaskId = attempt.parsed.taskId ?? (isRetry ? null : resumeTaskId);
    const resolvedSessionParams = resolvedTaskId
      ? {
          taskId: resolvedTaskId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(workspaceBranch ? { branchName: workspaceBranch } : {}),
          ...(workspaceWorktreePath ? { worktreePath: workspaceWorktreePath } : {}),
          ...(workspaceStrategy ? { workspaceStrategy } : {}),
        }
      : null;

    const parsedError = attempt.parsed.errorMessage?.trim() ?? "";
    const watchdogError = attempt.watchdog
      ? `Cline emitted hang-prone ask "${attempt.watchdog.subtype}" and was killed. Inspect run log for details.`
      : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      parsedError ||
      watchdogError ||
      stderrLine ||
      `Cline exited with code ${attempt.proc.exitCode ?? -1}`;
    const failed =
      (attempt.proc.exitCode ?? 0) !== 0 ||
      attempt.parsed.isError ||
      attempt.watchdog !== null;

    let errorCode: string | null = null;
    if (failed) {
      if (authRequired) errorCode = "cline_auth_required";
      else if (attempt.watchdog) errorCode = `cline_hang_prone_ask_${attempt.watchdog.subtype}`;
      else if (attempt.parsed.mistakeLimitReached) errorCode = "cline_mistake_limit";
    }

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: failed ? fallbackErrorMessage : null,
      errorCode,
      sessionId: resolvedTaskId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedTaskId,
      provider: "cline",
      biller: "cline",
      model: model || null,
      billingType: "unknown",
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      costUsd: attempt.parsed.usage.costUsd > 0 ? attempt.parsed.usage.costUsd : null,
      resultJson: {
        stdout: attempt.proc.stdout.slice(-8192),
        stderr: attempt.proc.stderr.slice(-8192),
        cacheWrites: attempt.parsed.usage.cacheWrites,
      },
      summary: attempt.parsed.finalText ?? attempt.parsed.lastAssistantText ?? null,
      clearSession: Boolean(clearOnMissingSession && !resolvedTaskId),
    };
  };

  const initial = await runAttempt(resumeTaskId);
  if (
    resumeTaskId &&
    !initial.proc.timedOut &&
    ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.isError) &&
    isClineUnknownTaskError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Cline task "${resumeTaskId}" failed to resume cleanly; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true, true);
  }
  return toResult(initial);
}
