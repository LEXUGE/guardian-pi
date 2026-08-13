import { spawn, type ChildProcess } from "node:child_process";

export interface GuardianContainer {
  Names: string[];
  Image: string;
  Id: string;
  Labels: Record<string, string>;
}

export interface ExecutionOptions {
  input?: Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

export interface ExecutionResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
}

export interface GuardianClientConfig {
  binary: string;
  logFile: string;
  globalArgs: string[];
}

function validateCreateArgs(args: string[]): void {
  if (args.some((item) => item === "--" || item === "--tty" || item.startsWith("--tty="))) {
    throw new Error("Guardian create arguments cannot contain -- or --tty");
  }
}

export class GuardianClient {
  private readonly config: GuardianClientConfig;

  constructor(config: GuardianClientConfig) {
    this.config = config;
  }

  async create(image: string, createArgs: string[], signal?: AbortSignal): Promise<string> {
    validateCreateArgs(createArgs);
    const args = ["create", ...createArgs, image];
    const result = await this.runChecked(args, "create sandbox", signal);

    const id = result.stdout.toString("utf8").trim();
    if (!id) throw new Error("Guardian create returned no sandbox UUID");
    return id;
  }

  async status(id: string, signal?: AbortSignal): Promise<"created" | "running" | "stopped"> {
    const result = await this.runChecked(["status", id], `get status for sandbox ${id}`, signal);

    const status = result.stdout.toString("utf8").trim();
    if (status === "created" || status === "running" || status === "stopped") return status;
    throw new Error(`Guardian returned unsupported sandbox status: ${status || "(empty)"}`);
  }

  async list(signal?: AbortSignal): Promise<GuardianContainer[]> {
    const result = await this.runChecked(["list"], "list sandboxes", signal);

    const containers: unknown = JSON.parse(result.stdout.toString("utf8"));
    if (!Array.isArray(containers)) throw new Error("Guardian list returned invalid JSON");
    return containers as GuardianContainer[];
  }

  start(sandboxId: string): ChildProcess {
    return spawn(this.config.binary, [
      "--log-file",
      this.config.logFile,
      ...this.config.globalArgs,
      "start",
      sandboxId,
    ], { stdio: "ignore" });
  }

  async stop(sandboxId: string): Promise<ExecutionResult> {
    return this.run(["stop", sandboxId], {});
  }

  async exec(sandboxId: string, options: ExecutionOptions): Promise<ExecutionResult> {
    return this.run(["exec", sandboxId, "/bin/sh", "-s"], options);
  }

  async remove(sandboxId: string, signal?: AbortSignal): Promise<void> {
    await this.runChecked(["remove", sandboxId], `remove sandbox ${sandboxId}`, signal);
  }

  private async runChecked(args: string[], action: string, signal?: AbortSignal): Promise<ExecutionResult> {
    const result = await this.run(args, { signal });
    if (result.exitCode === 0) return result;
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(`Guardian failed to ${action} (exit ${result.exitCode ?? "signal"})${detail ? `: ${detail}` : ""}`);
  }

  private run(args: string[], options: ExecutionOptions): Promise<ExecutionResult> {
    if (options.signal?.aborted) return Promise.reject(new Error("aborted"));

    const child = spawn(this.config.binary, ["--log-file", this.config.logFile, ...this.config.globalArgs, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});

    return new Promise<ExecutionResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        child.kill("SIGTERM");
      };

      child.stdout.on("data", (data: Buffer) => {
        stdout.push(data);
        options.onStdout?.(data);
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr.push(data);
        options.onStderr?.(data);
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (exitCode) => {
        if (options.signal?.aborted) {
          finish(() => reject(new Error("aborted")));
        } else if (timedOut) {
          finish(() => reject(new Error(`timeout:${options.timeoutMs}`)));
        } else {
          finish(() => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode }));
        }
      });

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      child.stdin.end(options.input);
    });
  }
}
