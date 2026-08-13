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
  type GuardianOwner,
} from "./guardian.ts";

const GUARDIAN_CWD = "/workspace";
const HOST_ONLY_TOOLS = new Set(["ls", "find", "grep"]);
const START_POLL_INTERVAL_MS = 25;

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
  private ownership: "inactive" | "owned" | "borrowed" = "inactive";
  private owner?: GuardianOwner;
  private starting?: Promise<Error | undefined>;
  private stopping?: Promise<Error | undefined>;

  constructor(client: GuardianClient, id: string) {
    this.client = client;
    this.id = id;
  }

  async start(): Promise<Error | undefined> {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.ownership !== "inactive") return undefined;

    const operation = this.startOnce();
    this.starting = operation;
    try {
      return await operation;
    } finally {
      if (this.starting === operation) this.starting = undefined;
    }
  }

  async stop(): Promise<Error | undefined> {
    if (this.stopping) return this.stopping;
    const operation = this.stopOnce();
    this.stopping = operation;
    try {
      return await operation;
    } finally {
      if (this.stopping === operation) this.stopping = undefined;
    }
  }

  private async startOnce(): Promise<Error | undefined> {
    if ((await this.client.status(this.id)) === "running") {
      this.ownership = "borrowed";
      return new Error(
        `Guardian sandbox ${this.id} is already running; using its existing owner. ` +
        "It will not be stopped when this Pi session exits.",
      );
    }

    const owner = this.client.start(this.id);
    this.owner = owner;
    void owner.completed.then(
      () => this.ownerExited(owner),
      () => this.ownerExited(owner),
    );

    try {
      await this.waitUntilRunning(owner);
      if (this.owner !== owner) throw new Error(`Guardian sandbox ${this.id} owner exited during startup`);
      this.ownership = "owned";
      return undefined;
    } catch (error) {
      if (this.owner === owner) owner.child.kill("SIGTERM");
      try {
        await owner.completed;
      } catch {}
      if (this.owner === owner) this.owner = undefined;
      this.ownership = "inactive";
      throw error;
    }
  }

  private async stopOnce(): Promise<Error | undefined> {
    if (this.starting) {
      try {
        await this.starting;
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    }
    if (this.ownership === "borrowed") {
      this.ownership = "inactive";
      return undefined;
    }

    const owner = this.owner;
    if (!owner) {
      this.ownership = "inactive";
      return undefined;
    }

    owner.child.kill("SIGTERM");
    try {
      const result = await owner.completed;
      return result.exitCode === 0 ? undefined : failure(`Stop Guardian sandbox ${this.id}`, result);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    } finally {
      if (this.owner === owner) this.owner = undefined;
      this.ownership = "inactive";
    }
  }

  private async waitUntilRunning(owner: GuardianOwner): Promise<void> {
    const ownerExit = owner.completed.then((result) => {
      throw failure(`Start Guardian sandbox ${this.id}`, result);
    });
    while (true) {
      const status = await Promise.race([this.client.status(this.id), ownerExit]);
      if (status === "running") return;
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, START_POLL_INTERVAL_MS)),
        ownerExit,
      ]);
    }
  }

  private ownerExited(owner: GuardianOwner): void {
    if (this.owner !== owner) return;
    this.owner = undefined;
    this.ownership = "inactive";
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

  async start(): Promise<undefined> {
    return undefined;
  }

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
