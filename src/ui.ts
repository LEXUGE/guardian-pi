import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, SelectList, Text } from "@earendil-works/pi-tui";
import { GuardianSandbox, type DirectSandbox, type Sandbox } from "./backends.ts";
import type { GuardianConfig } from "./config.ts";
import type { GuardianClient } from "./guardian.ts";

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
  const containers = (await client.list()).filter((item) => item.Names[0]);
  if (containers.length === 0) {
    ctx.ui.notify("No Guardian sandboxes found", "warning");
    return undefined;
  }

  const items = containers.map((item) => ({
    value: item.Names[0],
    label: `${item.Names[0]} · ${item.Image}`,
  }));
  const title = "Resume Guardian sandbox";
  if (ctx.mode !== "tui") {
    const selected = await ctx.ui.select(title, items.map((item) => item.label));
    return items.find((item) => item.label === selected)?.value;
  }

  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const heading = new Text(title, 0, 0);
    const search = new Input({ placeholder: "Type to filter by image or ID" });
    const buildList = () => {
      const list = new SelectList(fuzzyFilter(items, search.getValue(), (item) => item.label), 10, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: () => theme.fg("warning", "No matching sandboxes"),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      return list;
    };
    let list = buildList();

    return {
      capturesViewportInput: true,
      get focused() { return search.focused; },
      set focused(value: boolean) { search.focused = value; },
      render: (width) => [...heading.render(width), ...search.render(width), "", ...list.render(width)],
      invalidate: () => { heading.invalidate(); search.invalidate(); list.invalidate(); },
      handleInput(data) {
        const navigation = [
          "tui.select.up", "tui.select.down", "tui.select.pageUp",
          "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel",
        ] as const;
        if (navigation.some((action) => keybindings.matches(data, action))) {
          list.handleInput(data);
        } else {
          const previous = search.getValue();
          search.handleInput(data);
          if (search.getValue() !== previous) list = buildList();
        }
        tui.requestRender();
      },
    };
  }, { blocked: { kind: "question", message: title } });
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
