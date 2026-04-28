import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asBoolean,
  asStringArray,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";
import { parseCopilotJsonl, detectCopilotAuthRequired } from "./parse.js";
import { resolveCopilotToken, validateCopilotToken } from "./auth.js";
import { isValidGheHost } from "./models.js";
import { detectCopilotLocalModel } from "./detect-model.js";
import { applyCopilotProviderEnv } from "./provider.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "copilot");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "copilot_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "copilot_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "copilot_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
      hint: "Install GitHub Copilot CLI (https://docs.github.com/copilot/how-tos/copilot-cli), then run `copilot login`.",
    });
  }

  // gheHost validation (defense-in-depth — same validator as listModels uses).
  const rawGheHost = config.gheHost;
  if (rawGheHost !== undefined && rawGheHost !== null && rawGheHost !== "") {
    if (isValidGheHost(rawGheHost)) {
      checks.push({
        code: "copilot_ghehost_valid",
        level: "info",
        message: `GitHub Enterprise host: ${(rawGheHost as string).trim()}`,
      });
    } else {
      checks.push({
        code: "copilot_ghehost_invalid",
        level: "error",
        message: "Configured `gheHost` is not a valid hostname.",
        detail: typeof rawGheHost === "string" ? rawGheHost : String(rawGheHost),
        hint: "Use a bare DNS hostname (e.g. `corp.ghe.com`). URLs, schemes, ports, paths, and userinfo are not allowed.",
      });
    }
  }

  // Provider BYOK probe — when activated, GitHub auth is irrelevant.
  // Run validation in a throwaway env so we don't leak secret values to
  // the diagnostic output (the actual injection happens in execute.ts).
  const probeProviderEnv: Record<string, string> = {};
  const providerActivation = applyCopilotProviderEnv(probeProviderEnv, config);
  if (providerActivation.errors.length > 0) {
    for (const err of providerActivation.errors) {
      checks.push({
        code: "copilot_provider_invalid",
        level: "error",
        message: `\`${err.field}\` is invalid: ${err.reason}`,
      });
    }
  } else if (providerActivation.active) {
    checks.push({
      code: "copilot_provider_active",
      level: "info",
      message: `Custom provider active: ${providerActivation.type}`,
      detail: providerActivation.baseUrl,
    });
  }

  // GitHub-auth probe — only meaningful when provider BYOK is NOT active.
  // Surfaces which credential source is active for this agent's runtime.
  // Never logs the token itself. Mirrors execute.ts validation: classic
  // PATs are rejected at BYOK before the path is accepted, falling
  // through to the resolution chain.
  const explicitToken = asString(config.githubToken, "").trim();
  const tokenSourceHint = asString(config.tokenSource, "auto");
  const validatedGheHost =
    rawGheHost !== undefined && rawGheHost !== null && rawGheHost !== "" && isValidGheHost(rawGheHost)
      ? (rawGheHost as string).trim()
      : undefined;
  let byokAccepted = false;
  if (explicitToken) {
    const validation = validateCopilotToken(explicitToken);
    if (validation.valid) {
      byokAccepted = true;
      checks.push({
        code: "copilot_token_source",
        level: "info",
        message: "GitHub token sourced from `adapterConfig.githubToken` (BYOK).",
      });
    } else {
      checks.push({
        code: "copilot_token_byok_invalid",
        level: "error",
        message: "`adapterConfig.githubToken` was rejected by validation.",
        detail: validation.reason ?? "Token is empty or not a supported type.",
        hint: "Use a fine-grained PAT (`github_pat_…`) or OAuth token (`gho_…` / `ghu_…`). Classic PATs (`ghp_…`) are not accepted by the Copilot API.",
      });
    }
  }
  if (!byokAccepted && !providerActivation.active) {
    const searchEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(envConfig as Record<string, string | undefined>),
    };
    const resolved = await resolveCopilotToken(searchEnv, validatedGheHost, tokenSourceHint);
    if (resolved) {
      checks.push({
        code: "copilot_token_source",
        level: "info",
        message: `Token resolved via ${resolved.source}.`,
      });
    } else {
      checks.push({
        code: "copilot_token_unresolved",
        level: "info",
        message: "No token resolved from env or `gh auth token`. Copilot CLI will use its own `~/.copilot/` auth state.",
        hint: "Run `copilot login` on the host, or set GH_TOKEN / COPILOT_GITHUB_TOKEN in adapterConfig.env, or set adapterConfig.copilotToken.",
      });
    }
  }

  // Active default model probe — shows what the user's `~/.copilot/config.json`
  // points to. Doesn't fail; just informational.
  const detectedModel = await detectCopilotLocalModel();
  if (detectedModel) {
    checks.push({
      code: "copilot_default_model",
      level: "info",
      message: `Active default model: ${detectedModel.model}`,
      detail: detectedModel.source,
    });
  }

  const canRunProbe = checks.every(
    (check) =>
      check.code !== "copilot_cwd_invalid" &&
      check.code !== "copilot_command_unresolvable" &&
      check.code !== "copilot_ghehost_invalid" &&
      check.code !== "copilot_provider_invalid",
  );
  if (canRunProbe) {
    if (!commandLooksLike(command, "copilot")) {
      checks.push({
        code: "copilot_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `copilot`.",
        detail: command,
      });
    } else {
      const model = asString(config.model, "").trim();
      const effort = asString(config.effort, "").trim();
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["-p", "Respond with hello.", "--output-format", "json", "-s", "--no-color"];
      if (dangerouslySkipPermissions) args.push("--allow-all");
      else args.push("--allow-all-tools");
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runChildProcess(
        `copilot-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsedStream = parseCopilotJsonl(probe.stdout);
      const authMeta = detectCopilotAuthRequired({
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "copilot_hello_probe_timed_out",
          level: "warn",
          message: "Copilot hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Copilot can run from this directory manually.",
        });
      } else if (authMeta.requiresLogin) {
        checks.push({
          code: "copilot_hello_probe_auth_required",
          level: "warn",
          message: "Copilot CLI is installed, but GitHub authentication is required.",
          ...(detail ? { detail } : {}),
          hint: "Run `copilot login` or `gh auth login` to authenticate with GitHub.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "copilot_hello_probe_passed" : "copilot_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Copilot hello probe succeeded."
            : "Copilot probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        });
      } else {
        checks.push({
          code: "copilot_hello_probe_failed",
          level: "error",
          message: "Copilot hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: 'Run `copilot -p "Respond with hello." --output-format json -s --no-color --allow-all-tools` manually to debug.',
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
