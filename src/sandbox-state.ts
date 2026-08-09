import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
