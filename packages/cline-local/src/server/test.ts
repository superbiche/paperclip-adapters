import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function checkBinary(command: string): Promise<AdapterEnvironmentCheck> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          code: "cline_binary",
          level: "info",
          message: `Cline CLI present (${out.trim()}).`,
        });
      } else {
        resolve({
          code: "cline_binary_missing",
          level: "error",
          message: `Cline CLI not found or failed to execute at '${command}'.`,
          hint: "Install via `npm install -g cline` and make sure the binary is on PATH.",
        });
      }
    });
    child.on("error", () => {
      resolve({
        code: "cline_binary_missing",
        level: "error",
        message: `Cline CLI not found at '${command}'.`,
        hint: "Install via `npm install -g cline` and make sure the binary is on PATH.",
      });
    });
  });
}

async function checkConfigDir(configDir: string): Promise<AdapterEnvironmentCheck> {
  if (configDir.length === 0) {
    return {
      code: "config_dir_missing",
      level: "error",
      message: "adapterConfig.configDir is required (absolute path to a pre-authenticated Cline --config directory).",
      hint: "Seed once via `cline auth -p <provider> -k <key> -m <model> --config <dir>`.",
    };
  }
  try {
    const stat = await fs.stat(configDir);
    if (!stat.isDirectory()) {
      return {
        code: "config_dir_not_dir",
        level: "error",
        message: `configDir '${configDir}' exists but is not a directory.`,
      };
    }
  } catch {
    return {
      code: "config_dir_not_found",
      level: "error",
      message: `configDir '${configDir}' does not exist.`,
      hint: "Create it via `cline auth -p <provider> -k <key> -m <model> --config <dir>`.",
    };
  }
  return {
    code: "config_dir_set",
    level: "info",
    message: `Cline config dir: ${configDir}`,
  };
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const cfg = parseObject(ctx.config);
  const command = asString(cfg.command, "cline").trim() || "cline";
  const configDir = asString(cfg.configDir, "").trim();

  const checks = await Promise.all([checkBinary(command), checkConfigDir(configDir)]);
  const status = checks.some((c) => c.level === "error")
    ? ("fail" as const)
    : checks.some((c) => c.level === "warn")
      ? ("warn" as const)
      : ("pass" as const);

  return {
    adapterType: "cline_local",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
