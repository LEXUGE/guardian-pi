import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import type { Sandbox } from "./backend.ts";
import type { GuardianConfig } from "./config.ts";
import { GuardianClient, type GuardianContainer } from "./guardian.ts";
import { DirectSandbox, GuardianSandbox } from "./sandbox.ts";

const SANDBOX_ID_LABEL = "io.guardian.sandbox.id";

export async function chooseSandbox(
  config: GuardianConfig,
  client: GuardianClient,
  direct: DirectSandbox,
  ctx: ExtensionContext,
): Promise<Sandbox | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/sandbox requires interactive UI", "error");
    return;
  }
  if (!ctx.isIdle()) throw new Error("Cannot change Guardian sandbox while Pi is running");

  const choices = config.allowNoSandbox
    ? ["Resume", "Create new", "No sandbox"]
    : ["Resume", "Create new"];
  const choice = await ctx.ui.select("Guardian sandbox", choices);
  if (!choice) return;

  let next: Sandbox;
  if (choice === "No sandbox") {
    next = direct;
  } else if (choice === "Resume") {
    const selected = await selectExistingSandbox(client, ctx);
    if (selected === undefined) return;
    next = new GuardianSandbox(client, selected);
  } else {
    const image = await ctx.ui.editor("Guardian image", config.image);
    if (image === undefined) return;
    const argumentsInput = await ctx.ui.editor("Guardian create arguments", "");
    if (argumentsInput === undefined) return;
    const id = await client.create(image.trim(), [
      ...config.createArgs,
      ...parseCreateArguments(argumentsInput),
    ]);
    next = new GuardianSandbox(client, id);
  }

  return next;
}

async function selectExistingSandbox(
  client: GuardianClient,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const containers = await client.list();
  if (containers.length === 0) {
    ctx.ui.notify("No Guardian sandboxes found", "warning");
    return undefined;
  }

  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const container = new Container();
    const search = new Input();
    const listContainer = new Container();
    let selectList: SelectList;

    container.addChild(new Text(theme.fg("accent", theme.bold("Resume Guardian sandbox"))));
    container.addChild(new Text(theme.fg("muted", "Search by name, image, sandbox UUID, or container ID")));
    container.addChild(search);
    container.addChild(listContainer);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));

    const rebuildList = (): void => {
      const query = search.getValue().trim().toLowerCase();
      const matches = containers.filter((item) => sandboxSearchText(item).includes(query));
      const items: SelectItem[] = matches.map((item) => ({
        value: item.Labels[SANDBOX_ID_LABEL] ?? "",
        label: item.Names.join(", ") || item.Labels[SANDBOX_ID_LABEL] || item.Id,
        description: `${item.Image} · ${item.Labels[SANDBOX_ID_LABEL] ?? "unknown UUID"}`,
      })).filter((item) => item.value);

      selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(undefined);
      listContainer.clear();
      listContainer.addChild(selectList);
    };
    rebuildList();

    return {
      get focused() {
        return search.focused;
      },
      set focused(value: boolean) {
        search.focused = value;
      },
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        } else if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm")
        ) {
          selectList.handleInput(data);
        } else {
          search.handleInput(data);
          rebuildList();
        }
        tui.requestRender();
      },
    };
  });
}

function sandboxSearchText(container: GuardianContainer): string {
  return [
    ...container.Names,
    container.Image,
    container.Id,
    ...Object.entries(container.Labels).flat(),
  ].join(" ").toLowerCase();
}

function parseCreateArguments(input: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of input.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        result.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }

  if (escaped || quote) throw new Error("Unclosed quote or escape in Guardian create arguments");
  if (token) result.push(token);
  return result;
}
