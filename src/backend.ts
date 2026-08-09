import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";

export type BashExecutor = ReturnType<typeof createBashToolDefinition>["execute"];
export type ReadExecutor = ReturnType<typeof createReadToolDefinition>["execute"];
export type WriteExecutor = ReturnType<typeof createWriteToolDefinition>["execute"];
export type EditExecutor = ReturnType<typeof createEditToolDefinition>["execute"];

export interface ToolBackend {
  bash: BashExecutor;
  read: ReadExecutor;
  write: WriteExecutor;
  edit: EditExecutor;
}

export interface Sandbox extends ToolBackend {
  readonly id: string | null;
  activateHook?(pi: ExtensionAPI): void;
  deactivateHook?(pi: ExtensionAPI): void;
}

export function registerTools(pi: ExtensionAPI, backend: ToolBackend): void {
  const bash = createBashToolDefinition("/");
  const read = createReadToolDefinition("/");
  const write = createWriteToolDefinition("/");
  const edit = createEditToolDefinition("/");

  pi.registerTool(defineTool({
    ...bash,
    label: "bash (Guardian)",
    executionMode: "sequential",
    execute: (...args) => backend.bash(...args),
  }));
  pi.registerTool(defineTool({
    ...read,
    label: "read (Guardian)",
    executionMode: "sequential",
    execute: (...args) => backend.read(...args),
  }));
  pi.registerTool(defineTool({
    ...write,
    label: "write (Guardian)",
    executionMode: "sequential",
    execute: (...args) => backend.write(...args),
  }));
  pi.registerTool(defineTool({
    ...edit,
    label: "edit (Guardian)",
    executionMode: "sequential",
    execute: (...args) => backend.edit(...args),
  }));
}
