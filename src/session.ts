import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DirectSandbox, GuardianSandbox, type Sandbox } from "./backends.ts";
import type { GuardianConfig } from "./config.ts";
import { GuardianClient } from "./guardian.ts";
import type { Router } from "./tools.ts";

export class SandboxSession {
  readonly config: GuardianConfig;
  readonly client: GuardianClient;
  readonly direct = new DirectSandbox();
  private readonly pi: ExtensionAPI;
  private readonly router: Router;

  constructor(pi: ExtensionAPI, router: Router, config: GuardianConfig) {
    this.pi = pi;
    this.router = router;
    this.config = config;
    this.client = new GuardianClient({
      binary: config.binary,
      logFile: config.logFile,
      globalArgs: config.globalArgs,
      startArgs: config.startArgs,
    });
  }

  async restore(ctx: ExtensionContext): Promise<void> {
    const entry = findSandboxEntry(ctx);
    const initial = this.pi.getFlag("guardian-sandbox") as string | undefined;
    const sandboxId = entry ? entry.sandboxId : initial === "none" ? null : initial;
    if (!entry && initial === "none" && !this.config.allowNoSandbox) {
      throw new Error("Guardian passthrough is disabled");
    }
    const next = typeof sandboxId === "string"
      ? new GuardianSandbox(this.client, sandboxId)
      : this.config.allowNoSandbox ? this.direct : undefined;
    await this.transitionTo(next, ctx);
    this.updateStatus(ctx);
  }

  async change(next: Sandbox, ctx: ExtensionContext): Promise<void> {
    if (!ctx.isIdle()) throw new Error("Cannot change Guardian sandbox while Pi is running");
    const previous = this.router.selected;
    let removePrevious = false;
    if (previous?.id && previous.id !== next.id) {
      removePrevious = this.config.cleanup === "remove";
      if (this.config.cleanup === "ask") {
        removePrevious = await ctx.ui.confirm("Remove Guardian sandbox?", previous.id);
      }
    }

    if (!ctx.isIdle()) throw new Error("Cannot change Guardian sandbox while Pi is running");
    await this.transitionTo(next, ctx, async () => {
      if (!removePrevious || !previous?.id) return;
      if ((await this.client.status(previous.id)) === "running") {
        ctx.ui.notify(
          `Guardian sandbox ${previous.id} is still owned by another process and will not be removed`,
          "warning",
        );
      } else {
        await this.client.remove(previous.id);
      }
    });
    this.pi.appendEntry<SandboxEntry>(SANDBOX_ENTRY, {
      piSessionId: ctx.sessionManager.getSessionId(),
      sandboxId: next.id,
    });
  }

  async stop(ctx: ExtensionContext): Promise<void> {
    await this.transitionTo(undefined, ctx);
  }

  updateStatus(ctx: ExtensionContext): void {
    const id = this.router.selectedId;
    const text = typeof id === "string" ? `Guardian: ${id}` : "Guardian: no sandbox";
    ctx.ui.setStatus("guardian", ctx.ui.theme.fg(typeof id === "string" ? "success" : "error", text));
  }

  private async transitionTo(
    next: Sandbox | undefined,
    ctx: ExtensionContext,
    cleanup?: () => Promise<void>,
  ): Promise<void> {
    const previous = this.router.selected;
    this.router.select(undefined, this.pi);
    const stopWarning = await previous?.stop();
    if (stopWarning) ctx.ui.notify(stopWarning.message, "warning");
    await cleanup?.();
    const startWarning = await next?.start();
    if (startWarning) ctx.ui.notify(startWarning.message, "warning");
    this.router.select(next, this.pi);
  }
}

export interface SandboxEntry {
  piSessionId: string;
  sandboxId: string | null;
}

export const SANDBOX_ENTRY = "guardian-sandbox";

function isSandboxEntry(value: unknown, piSessionId: string): value is SandboxEntry {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.piSessionId === piSessionId &&
    (data.sandboxId === null || typeof data.sandboxId === "string");
}

export function findSandboxEntry(ctx: ExtensionContext): SandboxEntry | undefined {
  const branch = ctx.sessionManager.getBranch();
  const piSessionId = ctx.sessionManager.getSessionId();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== SANDBOX_ENTRY) continue;
    if (isSandboxEntry(entry.data, piSessionId)) return entry.data;
  }
  return undefined;
}
