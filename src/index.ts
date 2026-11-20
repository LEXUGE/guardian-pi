import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "./config.ts";
import { SandboxSession } from "./session.ts";
import { registerTools, Router } from "./tools.ts";
import { chooseSandbox } from "./ui.ts";

export default function guardianExtension(pi: ExtensionAPI): void {
  const router = new Router();
  let session: SandboxSession | undefined;
  const getSession = (ctx: ExtensionContext): SandboxSession =>
    session ??= new SandboxSession(pi, router, getConfig(ctx.cwd));
  const notifyError = (ctx: ExtensionContext, error: unknown): void => {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  };
  const restore = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    try {
      await getSession(ctx).restore(ctx);
    } catch (error) {
      notifyError(ctx, error);
    }
  };

  registerTools(pi, router);
  pi.registerFlag("guardian-sandbox", {
    description: "Initial Guardian sandbox ID (Podman container name), or none for passthrough",
    type: "string",
  });
  pi.registerCommand("sandbox", {
    description: "Select, create, or disable the Guardian sandbox",
    handler: async (_args, ctx) => {
      try {
        const current = getSession(ctx);
        const next = await chooseSandbox(current.config, current.client, current.direct, ctx);
        if (!next) return;
        await current.change(next, ctx);
        current.updateStatus(ctx);
      } catch (error) {
        session?.updateStatus(ctx);
        notifyError(ctx, error);
      }
    },
  });
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", async (_event, ctx) => {
    await session?.stop(ctx);
  });
}
