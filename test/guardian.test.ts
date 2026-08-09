import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerTools, type ToolBackend } from "../src/backend.ts";
import { getConfig } from "../src/config.ts";
import { GuardianClient } from "../src/guardian.ts";
import guardianExtension, { changeSandbox } from "../src/index.ts";
import { Router } from "../src/router.ts";
import { DirectSandbox, GuardianSandbox } from "../src/sandbox.ts";
import { chooseSandbox } from "../src/sandbox-command.ts";
import { findSandboxEntry, SANDBOX_ENTRY } from "../src/sandbox-state.ts";

const SANDBOX_ID = "11111111-1111-4111-8111-111111111111";
const RESUMED_SANDBOX_ID = "22222222-2222-4222-8222-222222222222";

test("Guardian configuration is loaded from the project JSON file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "guardian-pi-config-test-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  await mkdir(join(directory, ".pi"));
  await writeFile(
    join(directory, ".pi", "guardian.json"),
    JSON.stringify({
      binary: "project-guardian",
      image: "project-image",
      globalArgs: ["--podman", "project-podman", "--runtime", "project-runsc", "--state-root", "/project-state"],
      cleanup: "remove",
      allow_no_sandbox: false,
      createArgs: ["--mount", "type=bind,source=$(pwd),destination=/workspace"],
    }),
  );
  const config = getConfig(directory);

  assert.equal(config.binary, "project-guardian");
  assert.equal(config.image, "project-image");
  assert.deepEqual(config.globalArgs, [
    "--podman",
    "project-podman",
    "--runtime",
    "project-runsc",
    "--state-root",
    "/project-state",
  ]);
  assert.equal(config.cleanup, "remove");
  assert.equal(config.allowNoSandbox, false);
  assert.deepEqual(config.createArgs, ["--mount", `type=bind,source=${directory},destination=/workspace`]);
});

async function createFakeGuardian(): Promise<{ directory: string; binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), "guardian-pi-test-"));
  const binary = join(directory, "guardian");
  await writeFile(
    binary,
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    create) command=create ;;
    list) command=list ;;
    status) command=status ;;
    start) command=start ;;
    remove) command=remove ;;
  esac
done
case "$command" in
  create) printf '${SANDBOX_ID}\\n' ;;
  list) printf '%s\\n' '[{"Names":["devbox-guardian"],"Image":"localhost/pi-guardian:latest","Id":"dac386fd7d534af70545f0e8a3cc2f65fba60dc38c49773ae739c65a9db7f083","Labels":{"io.guardian.sandbox.id":"${RESUMED_SANDBOX_ID}","io.guardian.sandbox.host-uds":"open"}}]' ;;
  status) printf 'stopped\\n' ;;
  start) exec /bin/sh ;;
  remove)
    if [ -f "$(dirname "$0")/fail-remove" ]; then
      printf 'remove failed\n' >&2
      exit 1
    fi
    ;;
  *) printf 'unknown command\\n' >&2; exit 125 ;;
esac
`,
  );
  await chmod(binary, 0o755);
  return { directory, binary };
}

function createTestClient(fake: { directory: string; binary: string }): GuardianClient {
  return new GuardianClient({
    binary: fake.binary,
    logFile: join(fake.directory, "guardian.jsonl"),
    globalArgs: ["--podman", "podman", "--runtime", "runsc", "--connect-timeout", "10s", "--stop-timeout", "5s"],
  });
}

function toolContext(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => "pi-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;
}

function activeToolApi(initial: string[] = ["bash", "read", "write", "edit", "ls", "find", "grep"]): {
  pi: ExtensionAPI;
  active: () => string[];
} {
  let active = initial;
  return {
    pi: {
      getActiveTools: () => active,
      setActiveTools: (next: string[]) => {
        active = next;
      },
    } as unknown as ExtensionAPI,
    active: () => active,
  };
}

test("generic registration registers the four routed tools", () => {
  const definitions: ToolDefinition[] = [];
  const backend = new DirectSandbox();
  const pi = {
    registerTool: (definition: ToolDefinition) => definitions.push(definition),
  } as unknown as ExtensionAPI;

  registerTools(pi, backend);

  assert.deepEqual(definitions.map((definition) => definition.name), ["bash", "read", "write", "edit"]);
  assert.ok(definitions.every((definition) => definition.executionMode === "sequential"));
  assert.ok(definitions.every((definition) => definition.label.endsWith("(Guardian)")));
});

test("Router delegates to the selected sandbox and runs its hooks", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "guardian-pi-router-test-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const router: ToolBackend & Router = new Router();
  const direct = new DirectSandbox();
  const { pi, active } = activeToolApi();

  assert.throws(() => router.read("read", { path: "missing" }, undefined, undefined, toolContext(directory)), /no sandbox/);
  router.select(direct, pi);
  await router.write("write", { path: "note.txt", content: "direct" }, undefined, undefined, toolContext(directory));
  assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "direct");

  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  router.select(new GuardianSandbox(createTestClient(fake), SANDBOX_ID), pi);
  assert.deepEqual(active(), ["bash", "read", "write", "edit"]);
  router.select(direct, pi);
  assert.deepEqual(active(), ["bash", "read", "write", "edit", "ls", "find", "grep"]);
});

test("Guardian extension restores host-only tools when leaving a sandbox branch", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  await mkdir(join(fake.directory, ".pi"));
  await writeFile(join(fake.directory, ".pi", "guardian.json"), JSON.stringify({
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    cleanup: "keep",
    allow_no_sandbox: true,
  }));

  type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, EventHandler>();
  let activeTools = ["bash", "read", "write", "edit", "ls", "find", "grep"];
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  } as unknown as ExtensionAPI;
  guardianExtension(pi);

  let branch: unknown[] = [{
    type: "custom",
    customType: SANDBOX_ENTRY,
    data: { piSessionId: "pi-session", sandboxId: "sandbox-id" },
  }];
  const ctx = {
    cwd: fake.directory,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => {},
      notify: () => {},
    },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "pi-session",
    },
  } as unknown as ExtensionContext;

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(activeTools, ["bash", "read", "write", "edit"]);

  branch = [...branch, {
    type: "custom",
    customType: SANDBOX_ENTRY,
    data: { piSessionId: "pi-session", sandboxId: null },
  }];
  await handlers.get("session_tree")?.({ type: "session_tree" }, ctx);
  assert.deepEqual(activeTools, ["bash", "read", "write", "edit", "ls", "find", "grep"]);
});

test("sandbox selection cleans up only after changing the active sandbox", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const client = createTestClient(fake);
  const router = new Router();
  const direct = new DirectSandbox();
  const config = {
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    logFile: join(fake.directory, "guardian.jsonl"),
    cleanup: "ask" as const,
    allowNoSandbox: true,
  };
  const branch: unknown[] = [];
  const entries: unknown[] = [];
  let activeTools = ["bash", "read", "write", "edit", "ls", "find", "grep"];
  const pi = {
    appendEntry: (type: string, data: unknown) => {
      entries.push(data);
      branch.push({ type: "custom", customType: type, data });
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  } as unknown as ExtensionAPI;
  let choice: string | undefined = "Create new";
  const editorInputs = ["demo-image", ""];
  let cleanupPrompts = 0;
  let removePrevious = false;
  let idle = true;
  const ctx = {
    cwd: "/project",
    hasUI: true,
    ui: {
      select: async () => choice,
      editor: async () => editorInputs.shift(),
      custom: async () => RESUMED_SANDBOX_ID,
      confirm: async () => {
        cleanupPrompts++;
        assert.equal(typeof router.selectedId, "string");
        return removePrevious;
      },
      notify: () => {},
    },
    isIdle: () => idle,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "pi-session",
    },
  } as unknown as ExtensionContext;
  const chooseAndChange = async (): Promise<void> => {
    const next = await chooseSandbox(config, client, direct, ctx);
    if (next) await changeSandbox(pi, config, client, router, next, ctx);
  };

  await chooseAndChange();
  const firstSandbox = router.selectedId;
  assert.equal(firstSandbox, SANDBOX_ID);

  idle = false;
  choice = "No sandbox";
  await assert.rejects(chooseAndChange(), /while Pi is running/);
  assert.equal(router.selectedId, firstSandbox);
  assert.equal(entries.length, 1);
  idle = true;

  choice = undefined;
  await chooseAndChange();
  assert.equal(router.selectedId, firstSandbox);
  assert.equal(cleanupPrompts, 0);

  choice = "Resume";
  removePrevious = true;
  await writeFile(join(fake.directory, "fail-remove"), "");
  await assert.rejects(chooseAndChange(), /remove sandbox/);
  assert.equal(router.selectedId, firstSandbox);
  assert.equal(entries.length, 1);
  await rm(join(fake.directory, "fail-remove"));

  removePrevious = false;
  await chooseAndChange();
  assert.equal(router.selectedId, RESUMED_SANDBOX_ID);
  assert.equal(cleanupPrompts, 2);

  choice = "No sandbox";
  await chooseAndChange();
  assert.equal(router.selectedId, null);
  assert.equal(cleanupPrompts, 3);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { piSessionId: "pi-session", sandboxId: SANDBOX_ID });
  assert.deepEqual(entries[2], { piSessionId: "pi-session", sandboxId: null });
});

test("sandbox state is restored only for the current Pi session", () => {
  const branch = [{
    type: "custom",
    customType: SANDBOX_ENTRY,
    data: { piSessionId: "pi-session", sandboxId: SANDBOX_ID },
  }];
  const context = {
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "pi-session",
    },
  } as unknown as ExtensionContext;
  assert.deepEqual(findSandboxEntry(context), { piSessionId: "pi-session", sandboxId: SANDBOX_ID });

  const forked = {
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "forked-session",
    },
  } as unknown as ExtensionContext;
  assert.equal(findSandboxEntry(forked), undefined);
});

test("GuardianClient creates, checks, and attaches to a sandbox", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const client = createTestClient(fake);

  assert.equal(await client.create("demo-image", []), SANDBOX_ID);
  assert.equal(await client.status(SANDBOX_ID), "stopped");
  assert.equal((await client.list())[0]?.Labels["io.guardian.sandbox.id"], RESUMED_SANDBOX_ID);

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const result = await client.start(SANDBOX_ID, {
    input: Buffer.from("printf stdout\nprintf stderr >&2\nexit 7\n"),
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
  });
  assert.equal(result.exitCode, 7);
  assert.equal(Buffer.concat(stdout).toString(), "stdout");
  assert.equal(Buffer.concat(stderr).toString(), "stderr");
});

test("GuardianSandbox implements read, write, edit, and bash", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const sandbox = new GuardianSandbox(createTestClient(fake), SANDBOX_ID);
  const ctx = toolContext(fake.directory);
  const file = join(fake.directory, "nested", "note.txt");

  await sandbox.write("write", { path: file, content: "hello Guardian" }, undefined, undefined, ctx);
  const readResult = await sandbox.read("read", { path: file }, undefined, undefined, ctx);
  assert.match(readResult.content[0]?.type === "text" ? readResult.content[0].text : "", /hello Guardian/);

  await sandbox.edit("edit", {
    path: file,
    edits: [{ oldText: "hello Guardian", newText: "edited Guardian" }],
  }, undefined, undefined, ctx);
  assert.equal(await readFile(file, "utf8"), "edited Guardian");

  const hostileFile = join(
    fake.directory,
    "space ' ; $(printf injected)\nline",
    "note '$HOME; $(printf injected).txt",
  );
  await sandbox.write("write", {
    path: hostileFile,
    content: "literal shell characters",
  }, undefined, undefined, ctx);
  const hostileResult = await sandbox.read(
    "read",
    { path: hostileFile },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(await readFile(hostileFile, "utf8"), "literal shell characters");
  assert.match(
    hostileResult.content[0]?.type === "text" ? hostileResult.content[0].text : "",
    /literal shell characters/,
  );

  const bashResult = await sandbox.bash("bash", {
    command: `cd '${fake.directory}' && pwd`,
  }, undefined, undefined, ctx);
  assert.match(bashResult.content[0]?.type === "text" ? bashResult.content[0].text : "", new RegExp(fake.directory));
});

test("GuardianClient aborts and times out attached executions", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const client = createTestClient(fake);

  const controller = new AbortController();
  const execution = client.start(SANDBOX_ID, {
    input: Buffer.from("trap 'exit 0' TERM\nwhile :; do :; done\n"),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(execution, /aborted/);

  await assert.rejects(
    client.start(SANDBOX_ID, {
      input: Buffer.from("trap 'exit 0' TERM\nwhile :; do :; done\n"),
      timeoutMs: 20,
    }),
    /timeout:20/,
  );
});
