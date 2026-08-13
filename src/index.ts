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

  const restoreSandbox = async (ctx: ExtensionContext): Promise<void> => {
    initialize(ctx.cwd);
    const entry = findSandboxEntry(ctx);
    const next = typeof entry?.sandboxId === "string"
      ? new GuardianSandbox(client!, entry.sandboxId)
      : config!.allowNoSandbox
      ? direct!
      : undefined;
    const previous = router.selected;
    if (previous) {
      router.select(undefined, pi);
      const warning = await previous.stop();
      if (warning) ctx.ui.notify(warning.message, "warning");
    }
    const warning = await next?.start();
    if (warning) ctx.ui.notify(warning.message, "warning");
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

  pi.on("session_start", async (_event, ctx) => {
    try {
      await restoreSandbox(ctx);
    } catch (error) {
      notifyError(ctx, error);
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    try {
      await restoreSandbox(ctx);
    } catch (error) {
      notifyError(ctx, error);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const previous = router.selected;
    if (!previous) return;
    router.select(undefined, pi);
    const warning = await previous.stop();
    if (warning) ctx.ui.notify(warning.message, "warning");
  });
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
  let removePrevious = false;
  if (previous?.id && previous.id !== next.id) {
    removePrevious = config.cleanup === "remove";
    if (config.cleanup === "ask") {
      removePrevious = await ctx.ui.confirm("Remove Guardian sandbox?", previous.id);
    }
  }

  if (previous) {
    router.select(undefined, pi);
    const warning = await previous.stop();
    if (warning) ctx.ui.notify(warning.message, "warning");
  }
  if (removePrevious && previous?.id) {
    if ((await client.status(previous.id)) === "running") {
      ctx.ui.notify(
        `Guardian sandbox ${previous.id} is still owned by another process and will not be removed`,
        "warning",
      );
    } else {
      await client.remove(previous.id);
    }
  }

  const warning = await next.start();
  if (warning) ctx.ui.notify(warning.message, "warning");
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
