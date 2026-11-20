import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type {
  BashExecutor,
  EditExecutor,
  ReadExecutor,
  Sandbox,
  ToolBackend,
  WriteExecutor,
} from "./backends.ts";

export class Router implements ToolBackend {
  private current?: Sandbox;

  get selected(): Sandbox | undefined {
    return this.current;
  }

  get selectedId(): string | null | undefined {
    return this.current?.id;
  }

  select(next: Sandbox | undefined, pi: ExtensionAPI): void {
    this.current?.deactivateHook?.(pi);
    this.current = next;
    this.current?.activateHook?.(pi);
  }

  bash: BashExecutor = (...args) => this.requireSelected().bash(...args);
  read: ReadExecutor = (...args) => this.requireSelected().read(...args);
  write: WriteExecutor = (...args) => this.requireSelected().write(...args);
  edit: EditExecutor = (...args) => this.requireSelected().edit(...args);

  private requireSelected(): Sandbox {
    if (!this.current) throw new Error("Guardian: no sandbox is selected");
    return this.current;
  }
}

export function registerTools(pi: ExtensionAPI, backend: ToolBackend): void {
  const bash = createBashToolDefinition("/");
  const read = createReadToolDefinition("/");
  const write = createWriteToolDefinition("/");
  const edit = createEditToolDefinition("/");

  pi.registerTool(defineTool({
    ...bash,
    label: "bash (Guardian)",
    execute: (...args) => backend.bash(...args),
  }));
  pi.registerTool(defineTool({
    ...read,
    label: "read (Guardian)",
    execute: (...args) => backend.read(...args),
  }));
  pi.registerTool(defineTool({
    ...write,
    label: "write (Guardian)",
    execute: (...args) => backend.write(...args),
  }));
  pi.registerTool(defineTool({
    ...edit,
    label: "edit (Guardian)",
    execute: (...args) => backend.edit(...args),
  }));
}
