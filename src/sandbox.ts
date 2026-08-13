import type { ChildProcess } from "node:child_process";
import type {
  BashOperations,
  EditOperations,
  ExtensionAPI,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  BashExecutor,
  EditExecutor,
  ReadExecutor,
  Sandbox,
  WriteExecutor,
} from "./backend.ts";
import {
  GuardianClient,
  type ExecutionOptions,
  type ExecutionResult,
} from "./guardian.ts";

const GUARDIAN_CWD = "/workspace";
const HOST_ONLY_TOOLS = new Set(["ls", "find", "grep"]);

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args.map(quoteShellArgument)].join(" ");
}

function failure(action: string, result: ExecutionResult): Error {
  const detail = result.stderr.toString("utf8").trim();
  return new Error(
    `${action} failed (exit ${result.exitCode ?? "signal"})${detail ? `: ${detail}` : ""}`,
  );
}

export class GuardianSandbox implements Sandbox {
  readonly id: string;
  private readonly client: GuardianClient;
  private readonly suspendedTools = new Set<string>();
  private startChild?: ChildProcess;

  constructor(client: GuardianClient, id: string) {
    this.client = client;
    this.id = id;
  }

  start(): void {
    const child = this.client.start(this.id);
    this.startChild = child;
    const clear = (): void => {
      if (this.startChild === child) this.startChild = undefined;
    };
    child.once("error", clear);
    child.once("close", clear);
  }

  async stop(): Promise<Error | undefined> {
    this.startChild = undefined;
    try {
      const result = await this.client.stop(this.id);
      return result.exitCode === 0 ? undefined : failure(`Stop Guardian sandbox ${this.id}`, result);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  activateHook(pi: ExtensionAPI): void {
    const active = pi.getActiveTools();
    const suspended = active.filter((name) => HOST_ONLY_TOOLS.has(name));
    if (suspended.length === 0) return;
    suspended.forEach((name) => this.suspendedTools.add(name));
    pi.setActiveTools(active.filter((name) => !HOST_ONLY_TOOLS.has(name)));
  }

  deactivateHook(pi: ExtensionAPI): void {
    if (this.suspendedTools.size === 0) return;
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...this.suspendedTools])]);
    this.suspendedTools.clear();
  }

  bash: BashExecutor = async (id, params, signal, onUpdate, ctx) => {
    return createBashToolDefinition(GUARDIAN_CWD, {
      operations: this.createBashOperations(),
    }).execute(id, params, signal, onUpdate, ctx);
  };

  read: ReadExecutor = async (id, params, signal, onUpdate, ctx) => {
    return createReadToolDefinition(GUARDIAN_CWD, {
      operations: this.createReadOperations(signal),
    }).execute(id, params, signal, onUpdate, ctx);
  };

  write: WriteExecutor = async (id, params, signal, onUpdate, ctx) => {
    return createWriteToolDefinition(GUARDIAN_CWD, {
      operations: this.createWriteOperations(signal),
    }).execute(id, params, signal, onUpdate, ctx);
  };

  edit: EditExecutor = async (id, params, signal, onUpdate, ctx) => {
    return createEditToolDefinition(GUARDIAN_CWD, {
      operations: this.createEditOperations(signal),
    }).execute(id, params, signal, onUpdate, ctx);
  };

  private async execute(
    script: string,
    options?: Omit<ExecutionOptions, "input">,
  ): Promise<ExecutionResult> {
    return this.client.exec(this.id, {
      input: Buffer.from(`${script}\n`),
      ...options,
    });
  }

  private async runFileScript(script: string, signal?: AbortSignal): Promise<ExecutionResult> {
    const result = await this.execute(script, { signal });
    if (result.exitCode !== 0) throw failure("Guardian file operation", result);
    return result;
  }

  private createBashOperations(): BashOperations {
    return {
      exec: async (command, cwd, { onData, signal, timeout }) => {
        const result = await this.execute(`${buildShellCommand("cd", [cwd])} && ${command}`, {
          signal,
          timeoutMs: timeout === undefined ? undefined : timeout * 1000,
          onStdout: onData,
          onStderr: onData,
        });
        return { exitCode: result.exitCode };
      },
    };
  }

  private createReadOperations(signal?: AbortSignal): ReadOperations {
    return {
      readFile: async (path) => {
        const result = await this.runFileScript(
          `${buildShellCommand("base64", [])} < ${quoteShellArgument(path)}`,
          signal,
        );
        return Buffer.from(result.stdout.toString("utf8").replaceAll(/\s/g, ""), "base64");
      },
      access: async (path) => {
        await this.runFileScript(buildShellCommand("test", ["-r", path]), signal);
      },
    };
  }

  private createWriteOperations(signal?: AbortSignal): WriteOperations {
    return {
      writeFile: async (path, content) => {
        const data = Buffer.from(content, "utf8").toString("base64");
        const decode = `${buildShellCommand("printf", ["%s", data])} | ${buildShellCommand("base64", ["-d"])}`;
        await this.runFileScript(`${decode} > ${quoteShellArgument(path)}`, signal);
      },
      mkdir: async (path) => {
        await this.runFileScript(buildShellCommand("mkdir", ["-p", path]), signal);
      },
    };
  }

  private createEditOperations(signal?: AbortSignal): EditOperations {
    const read = this.createReadOperations(signal);
    const write = this.createWriteOperations(signal);
    return {
      readFile: read.readFile,
      writeFile: write.writeFile,
      access: async (path) => {
        await this.runFileScript(
          `${buildShellCommand("test", ["-r", path])} && ${buildShellCommand("test", ["-w", path])}`,
          signal,
        );
      },
    };
  }
}

export class DirectSandbox implements Sandbox {
  readonly id = null;

  start(): void {}

  async stop(): Promise<undefined> {
    return undefined;
  }

  bash: BashExecutor = async (id, params, signal, onUpdate, ctx) => {
    return createBashToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
  };

  read: ReadExecutor = async (id, params, signal, onUpdate, ctx) => {
    return createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
  };

  write: WriteExecutor = async (id, params, signal, onUpdate, ctx) => {
    return createWriteToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
  };

  edit: EditExecutor = async (id, params, signal, onUpdate, ctx) => {
    return createEditToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
  };
}
