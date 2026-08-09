import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTools, type Sandbox } from "./backend.ts";
import { getConfig, type GuardianConfig } from "./config.ts";
import { GuardianClient } from "./guardian.ts";
import { Router } from "./router.ts";
import { DirectSandbox, GuardianSandbox } from "./sandbox.ts";
import { chooseSandbox } from "./sandbox-command.ts";
import { findSandboxEntry, SANDBOX_ENTRY, type SandboxEntry } from "./sandbox-state.ts";

export default function guardianExtension(pi: ExtensionAPI): void {
  const router = new Router();
  let config: GuardianConfig | undefined;
  let client: GuardianClient | undefined;
  let direct: DirectSandbox | undefined;

  const initialize = (cwd: string): void => {
    if (config) return;
    config = getConfig(cwd);
    client = new GuardianClient({
      binary: config.binary,
      logFile: config.logFile,
      globalArgs: config.globalArgs,
    });
    direct = new DirectSandbox();
  };

  const restoreSandbox = (ctx: ExtensionContext): void => {
    initialize(ctx.cwd);
    const entry = findSandboxEntry(ctx);
    const next = typeof entry?.sandboxId === "string"
      ? new GuardianSandbox(client!, entry.sandboxId)
      : config!.allowNoSandbox
      ? direct!
      : undefined;
    router.select(next, pi);
    setStatus(router, ctx);
  };

  const notifyError = (ctx: ExtensionContext, error: unknown): void => {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  };

  registerTools(pi, router);

  pi.registerCommand("sandbox", {
    description: "Select, create, or disable the Guardian sandbox",
    handler: async (_args, ctx) => {
      try {
        initialize(ctx.cwd);
        const next = await chooseSandbox(config!, client!, direct!, ctx);
        if (!next) return;
        await changeSandbox(pi, config!, client!, router, next, ctx);
        setStatus(router, ctx);
      } catch (error) {
        setStatus(router, ctx);
        notifyError(ctx, error);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      restoreSandbox(ctx);
    } catch (error) {
      notifyError(ctx, error);
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    try {
      restoreSandbox(ctx);
    } catch (error) {
      notifyError(ctx, error);
    }
  });
  pi.on("session_shutdown", () => router.select(undefined, pi));
}

export async function changeSandbox(
  pi: ExtensionAPI,
  config: GuardianConfig,
  client: GuardianClient,
  router: Router,
  next: Sandbox,
  ctx: ExtensionContext,
): Promise<void> {
  const previous = router.selected;
  if (previous?.id && previous.id !== next.id) {
    let remove = config.cleanup === "remove";
    if (config.cleanup === "ask") {
      remove = await ctx.ui.confirm("Remove Guardian sandbox?", previous.id);
    }
    if (remove) await client.remove(previous.id);
  }

  pi.appendEntry<SandboxEntry>(SANDBOX_ENTRY, {
    piSessionId: ctx.sessionManager.getSessionId(),
    sandboxId: next.id,
  });
  router.select(next, pi);
}

function setStatus(router: Router, ctx: ExtensionContext): void {
  const id = router.selectedId;
  const text = typeof id === "string" ? `Guardian: ${id.slice(0, 8)}` : "Guardian: no sandbox";
  ctx.ui.setStatus("guardian", ctx.ui.theme.fg(typeof id === "string" ? "success" : "error", text));
}
