import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type CleanupPolicy = "keep" | "ask" | "remove";

export interface GuardianConfig {
  binary: string;
  image: string;
  globalArgs: string[];
  createArgs: string[];
  logFile: string;
  cleanup: CleanupPolicy;
  allowNoSandbox: boolean;
}

type GuardianFileConfig = Partial<GuardianConfig> & { allow_no_sandbox?: unknown };

function readConfigFile(path: string): GuardianFileConfig {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Guardian configuration must be a JSON object: ${path}`);
  }
  return value as GuardianFileConfig;
}

function requiredString(config: GuardianFileConfig, name: keyof GuardianConfig): string {
  const value = config[name];
  if (typeof value !== "string") throw new Error(`Guardian configuration field ${name} is required and must be a string`);
  return value;
}

function optionalString(config: GuardianFileConfig, name: keyof GuardianConfig, fallback: string): string {
  const value = config[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`Guardian configuration field ${name} must be a string`);
  return value;
}

function cleanupConfig(config: GuardianFileConfig): CleanupPolicy {
  const value = config.cleanup;
  if (value === undefined) return "keep";
  if (value === "keep" || value === "ask" || value === "remove") return value;
  throw new Error("Guardian configuration field cleanup must be keep, ask, or remove");
}

function allowNoSandboxConfig(config: GuardianFileConfig): boolean {
  const value = config.allow_no_sandbox;
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error("Guardian configuration field allow_no_sandbox must be a boolean");
  return value;
}

function argsConfig(config: GuardianFileConfig, name: "globalArgs" | "createArgs"): string[] {
  const value = config[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Guardian configuration field ${name} is required and must be an array of strings`);
  }
  return value;
}

export function getConfig(cwd: string): GuardianConfig {
  const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "guardian.json"));
  const projectConfig = readConfigFile(join(cwd, CONFIG_DIR_NAME, "guardian.json"));
  const fileConfig = { ...globalConfig, ...projectConfig };

  return {
    binary: requiredString(fileConfig, "binary"),
    image: optionalString(fileConfig, "image", ""),
    globalArgs: argsConfig(fileConfig, "globalArgs"),
    createArgs: argsConfig(fileConfig, "createArgs").map((argument) => argument.replaceAll("$(pwd)", cwd)),
    logFile: optionalString(fileConfig, "logFile", join(tmpdir(), `guardian-pi-${process.pid}.jsonl`)),
    cleanup: cleanupConfig(fileConfig),
    allowNoSandbox: allowNoSandboxConfig(fileConfig),
  };
}
