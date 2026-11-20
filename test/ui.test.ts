import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, stripTerminalSequences, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { DirectSandbox, GuardianSandbox } from "../src/backends.ts";
import type { GuardianConfig } from "../src/config.ts";
import type { GuardianClient, GuardianContainer } from "../src/guardian.ts";
import { chooseSandbox } from "../src/ui.ts";

const FIRST_ID = "guardian-dac386fd7d534af70545f0e8a3cc2f65";
const SECOND_ID = "project-worker";
const config: GuardianConfig = {
  binary: "guardian",
  image: "universal",
  globalArgs: [],
  createArgs: ["--gvisor-overlay2=none"],
  startArgs: [],
  logFile: "/unused",
  cleanup: "keep",
  allowNoSandbox: true,
};

function uiContext(ui: Partial<ExtensionContext["ui"]>): ExtensionContext {
  return { mode: "tui", hasUI: true, isIdle: () => true, ui } as unknown as ExtensionContext;
}

type Picker = Component & Focusable & { handleInput(data: string): void };

function customDialog(interact: (picker: Picker, closed: () => boolean) => void): ExtensionContext["ui"]["custom"] {
  return async <T>(factory: (
    tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void,
  ) => Component | Promise<Component>) => {
    let result!: T;
    let closed = false;
    const picker = await factory(
      { requestRender() {} } as TUI,
      { fg: (_color: string, text: string) => text } as Theme,
      getKeybindings() as KeybindingsManager,
      (value) => { result = value; closed = true; },
    ) as Picker;
    picker.focused = true;
    interact(picker, () => closed);
    assert.ok(closed, "Picker did not finish");
    return result;
  };
}

function typeQuery(picker: Picker, query: string): void {
  for (const character of query) picker.handleInput(character);
}

function createClient(): GuardianClient {
  return {
    list: async () => { throw new Error("Unexpected list call"); },
    create: async () => { throw new Error("Unexpected create call"); },
  } as unknown as GuardianClient;
}

function container(id: string): GuardianContainer {
  return { Names: [id], Image: "universal", Id: createHash("sha256").update(id).digest("hex") };
}

test("resume selects sandbox IDs from Podman names without UUID labels", async () => {
  const client = createClient();
  client.list = async () => [{ ...container(FIRST_ID), Names: [FIRST_ID, "alias"] }, container(SECOND_ID)];
  let calls = 0;
  const ctx = uiContext({
    select: async (title, options) => {
      calls++;
      assert.equal(title, "Guardian sandbox");
      assert.deepEqual(options, ["Resume", "Create new", "No sandbox"]);
      return "Resume";
    },
    custom: customDialog((picker) => {
      const rendered = picker.render(120).join("\n");
      assert.match(rendered, /Resume Guardian sandbox/);
      assert.ok(rendered.includes(`${FIRST_ID} · universal`));
      assert.ok(rendered.includes(`${SECOND_ID} · universal`));
      assert.ok(!rendered.includes("alias"));
      assert.ok(!rendered.includes(container(FIRST_ID).Id));
      assert.ok(!rendered.includes(container(SECOND_ID).Id));
      assert.ok(rendered.includes(CURSOR_MARKER));
      assert.equal(picker.capturesViewportInput, true);
      picker.focused = false;
      const unfocused = picker.render(120).join("\n");
      assert.match(stripTerminalSequences(unfocused), /Type to filter by image or ID/);
      assert.ok(!unfocused.includes(CURSOR_MARKER));
      picker.focused = true;
      picker.invalidate();
      picker.handleInput("\x1b[B");
      picker.handleInput("\r");
    }),
  });

  const next = await chooseSandbox(config, client, new DirectSandbox(), ctx);
  assert.ok(next instanceof GuardianSandbox);
  assert.equal(next.id, SECOND_ID);
  assert.equal(calls, 1);
});

test("resume filters by image and full or partial sandbox ID", async () => {
  for (const query of ["UNIVERSAL", "UNVRSL", SECOND_ID, SECOND_ID.slice(0, 12).toUpperCase()]) {
    const client = createClient();
    client.list = async () => [
      { ...container(FIRST_ID), Image: "debian" },
      container(SECOND_ID),
    ];
    const ctx = uiContext({
      select: async () => "Resume",
      custom: customDialog((picker) => {
        typeQuery(picker, query);
        const options = picker.render(160).filter((line) => line.includes(" · "));
        assert.equal(options.length, 1, query);
        assert.ok(options[0].includes(SECOND_ID), query);
        picker.handleInput("\r");
      }),
    });
    const next = await chooseSandbox(config, client, new DirectSandbox(), ctx);
    assert.equal(next?.id, SECOND_ID, query);
  }
});

test("backspace updates the sandbox filter", async () => {
  const client = createClient();
  client.list = async () => [container(FIRST_ID), container(SECOND_ID)];
  const ctx = uiContext({
    select: async () => "Resume",
    custom: customDialog((picker) => {
      typeQuery(picker, `${SECOND_ID.slice(0, 12)}x`);
      assert.match(picker.render(120).join("\n"), /No matching sandboxes/);
      picker.handleInput("\x7f");
      assert.ok(picker.render(120).join("\n").includes(SECOND_ID));
      picker.handleInput("\r");
    }),
  });
  assert.equal((await chooseSandbox(config, client, new DirectSandbox(), ctx))?.id, SECOND_ID);
});

test("empty results cannot be selected and clearing the query restores the list", async () => {
  const client = createClient();
  client.list = async () => [container(FIRST_ID), container(SECOND_ID)];
  const ctx = uiContext({
    select: async () => "Resume",
    custom: customDialog((picker, closed) => {
      typeQuery(picker, "zzzz");
      assert.match(picker.render(120).join("\n"), /No matching sandboxes/);
      for (const key of ["\x1b[B", "\x1b[A", "\x1b[6~", "\x1b[5~", "\r"]) picker.handleInput(key);
      assert.equal(closed(), false);
      picker.handleInput("\x15");
      const rendered = picker.render(120).join("\n");
      assert.ok(rendered.includes(FIRST_ID));
      assert.ok(rendered.includes(SECOND_ID));
      picker.handleInput("\r");
    }),
  });
  assert.equal((await chooseSandbox(config, client, new DirectSandbox(), ctx))?.id, FIRST_ID);
});

test("filtering resets an out-of-range selection", async () => {
  const client = createClient();
  client.list = async () => [container(FIRST_ID), container(SECOND_ID)];
  const ctx = uiContext({
    select: async () => "Resume",
    custom: customDialog((picker) => {
      picker.handleInput("\x1b[B");
      typeQuery(picker, FIRST_ID.slice(0, 12));
      picker.handleInput("\r");
    }),
  });
  assert.equal((await chooseSandbox(config, client, new DirectSandbox(), ctx))?.id, FIRST_ID);
});

test("filtered sandbox lists retain arrow and page navigation", async () => {
  const client = createClient();
  const containers = Array.from({ length: 25 }, (_, index) => ({
    ...container(`guardian-${index.toString(16).padStart(32, "0")}`),
    Image: "worker",
  }));
  client.list = async () => [...containers, { ...container("other"), Image: "other" }];
  const ctx = uiContext({
    select: async () => "Resume",
    custom: customDialog((picker) => {
      typeQuery(picker, "worker");
      assert.equal(picker.render(120).filter((line) => line.includes(" · ")).length, 10);
      for (const key of ["\x1b[6~", "\x1b[6~", "\x1b[5~", "\x1b[B", "\x1b[A", "\r"]) picker.handleInput(key);
    }),
  });
  assert.equal((await chooseSandbox(config, client, new DirectSandbox(), ctx))?.id, containers[10].Names[0]);
});

test("RPC mode retains the built-in sandbox selection dialog", async () => {
  const client = createClient();
  client.list = async () => [container(FIRST_ID), container(SECOND_ID)];
  for (const cancel of [false, true]) {
    const ctx = uiContext({
      select: async (title, options) => {
        if (title === "Guardian sandbox") return "Resume";
        assert.equal(title, "Resume Guardian sandbox");
        assert.deepEqual(options, [
          `${FIRST_ID} · universal`,
          `${SECOND_ID} · universal`,
        ]);
        return cancel ? undefined : options[1];
      },
    });
    ctx.mode = "rpc";
    assert.equal((await chooseSandbox(config, client, new DirectSandbox(), ctx))?.id, cancel ? undefined : SECOND_ID);
  }
});

test("cancelling either selection dialog leaves the selection unchanged", async () => {
  for (const resume of [false, true]) {
    const client = createClient();
    client.list = async () => [container(FIRST_ID)];
    let dialogs = 0;
    const ctx = uiContext({
      select: async () => resume ? "Resume" : undefined,
      custom: customDialog((picker) => {
        dialogs++;
        typeQuery(picker, "no-match");
        picker.handleInput("\x1b");
      }),
    });
    assert.equal(await chooseSandbox(config, client, new DirectSandbox(), ctx), undefined);
    assert.equal(dialogs, resume ? 1 : 0);
  }
});

test("resume warns when there are no selectable Guardian sandboxes", async () => {
  for (const containers of [[], [{ ...container(FIRST_ID), Names: [] }]]) {
    const client = createClient();
    client.list = async () => containers;
    const warnings: string[] = [];
    let calls = 0;
    const ctx = uiContext({
      select: async () => { calls++; return "Resume"; },
      notify: (message, level) => {
        assert.equal(level, "warning");
        warnings.push(message);
      },
    });
    assert.equal(await chooseSandbox(config, client, new DirectSandbox(), ctx), undefined);
    assert.deepEqual(warnings, ["No Guardian sandboxes found"]);
    assert.equal(calls, 1);
  }
});

test("the menu offers passthrough only when permitted", async () => {
  const direct = new DirectSandbox();
  const client = createClient();
  const ctx = uiContext({ select: async () => "No sandbox" });
  assert.equal(await chooseSandbox(config, client, direct, ctx), direct);

  ctx.ui.select = async (_title, options) => {
    assert.deepEqual(options, ["Resume", "Create new"]);
    return undefined;
  };
  assert.equal(await chooseSandbox({ ...config, allowNoSandbox: false }, client, direct, ctx), undefined);
});

test("creation keeps the built-in editors and parses additional arguments", async () => {
  const client = createClient();
  client.create = async (image, args) => {
    assert.equal(image, "universal");
    assert.deepEqual(args, [
      "--gvisor-overlay2=none", "--id", SECOND_ID,
      "--volume", "/tmp/agent sandbox:/workspace",
      "--mount", "type=bind,source=/tmp/a b,destination=/tmp/a b",
    ]);
    return SECOND_ID;
  };
  let edits = 0;
  const ctx = uiContext({
    select: async () => "Create new",
    editor: async (title, initial) => {
      if (++edits === 1) {
        assert.equal(title, "Guardian image");
        assert.equal(initial, config.image);
        return "  universal  ";
      }
      assert.equal(title, "Guardian create arguments");
      assert.equal(initial, "");
      return `--id ${SECOND_ID} --volume '/tmp/agent sandbox:/workspace' --mount "type=bind,source=/tmp/a b,destination=/tmp/a b"`;
    },
  });
  const next = await chooseSandbox(config, client, new DirectSandbox(), ctx);
  assert.ok(next instanceof GuardianSandbox);
  assert.equal(next.id, SECOND_ID);
});

test("cancelling either creation editor does not create a sandbox", async () => {
  for (const cancelAt of [1, 2]) {
    let edits = 0;
    const ctx = uiContext({
      select: async () => "Create new",
      editor: async () => ++edits === cancelAt ? undefined : "universal",
    });
    assert.equal(await chooseSandbox(config, createClient(), new DirectSandbox(), ctx), undefined);
    assert.equal(edits, cancelAt);
  }
});

test("unclosed create arguments are rejected before invoking Guardian", async () => {
  const ctx = uiContext({
    select: async () => "Create new",
    editor: async (title) => title === "Guardian image" ? "universal" : "--volume 'unfinished",
  });
  await assert.rejects(chooseSandbox(config, createClient(), new DirectSandbox(), ctx), /Unclosed quote or escape/);
});

test("sandbox dialogs require a UI and an idle session", async () => {
  const errors: string[] = [];
  const ctx = uiContext({ notify: (message) => errors.push(message) });
  ctx.hasUI = false;
  assert.equal(await chooseSandbox(config, createClient(), new DirectSandbox(), ctx), undefined);
  assert.deepEqual(errors, ["/sandbox requires interactive UI"]);

  ctx.hasUI = true;
  ctx.isIdle = () => false;
  await assert.rejects(chooseSandbox(config, createClient(), new DirectSandbox(), ctx), /while Pi is running/);
});
