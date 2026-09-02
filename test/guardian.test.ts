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
      startArgs: ["--start-option", "project-value", "--project-dir", "$(pwd)"],
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
  assert.deepEqual(config.startArgs, ["--start-option", "project-value", "--project-dir", directory]);
});

async function createFakeGuardian(): Promise<{ directory: string; binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), "guardian-pi-test-"));
  const binary = join(directory, "guardian");
  await writeFile(
    binary,
    `#!/bin/sh
state=$(dirname "$0")
for argument in "$@"; do
  last=$argument
  case "$argument" in
    create) command=create ;;
    list) command=list ;;
    status) command=status ;;
    start) command=start ;;
    stop) command=stop ;;
    exec) command=exec ;;
    remove) command=remove ;;
  esac
done
case "$command" in
  create) printf '${SANDBOX_ID}\\n' ;;
  list) printf '%s\\n' '[{"Names":["devbox-guardian"],"Image":"localhost/pi-guardian:latest","Id":"dac386fd7d534af70545f0e8a3cc2f65fba60dc38c49773ae739c65a9db7f083","Labels":{"io.guardian.sandbox.id":"${RESUMED_SANDBOX_ID}","io.guardian.sandbox.host-uds":"open"}}]' ;;
  status)
    if [ -f "$state/start.pid" ] && kill -0 "$(cat "$state/start.pid")" 2>/dev/null; then
      printf 'running\\n'
    else
      rm -f "$state/start.pid"
      printf 'stopped\\n'
    fi
    ;;
  start)
    if [ -f "$state/fail-start" ]; then
      printf 'start failed\\n' >&2
      exit 1
    fi
    if [ -f "$state/start.pid" ] && kill -0 "$(cat "$state/start.pid")" 2>/dev/null; then
      printf 'already running\\n' >&2
      exit 1
    fi
    printf 'start:%s\\n' "$last" >> "$state/events"
    printf '%s\\n' "$$" > "$state/start.pid"
    stop_owner() {
      printf 'stop-begin:%s\\n' "$last" >> "$state/events"
      touch "$state/stop-entered"
      while [ -f "$state/block-stop" ]; do sleep 0.01; done
      rm -f "$state/start.pid"
      printf 'stop-end:%s\\n' "$last" >> "$state/events"
      if [ -f "$state/fail-stop" ]; then
        printf 'stop failed\\n' >&2
        exit 1
      fi
      exit 0
    }
    trap stop_owner TERM INT
    while :; do sleep 0.01; done
    ;;
  exec) exec /bin/sh ;;
  remove)
    if [ -f "$state/start.pid" ] && kill -0 "$(cat "$state/start.pid")" 2>/dev/null; then
      printf 'sandbox is running\\n' >&2
      exit 1
    fi
    if [ -f "$state/fail-remove" ]; then
      printf 'remove failed\n' >&2
      exit 1
    fi
    printf 'remove:%s\\n' "$last" >> "$state/events"
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
    startArgs: [],
  });
}

async function cleanupFakeGuardian(fake: { directory: string }): Promise<void> {
  try {
    const pid = Number.parseInt(await readFile(join(fake.directory, "start.pid"), "utf8"), 10);
    process.kill(pid, "SIGTERM");
  } catch {}
  await rm(fake.directory, { force: true, recursive: true });
}

async function readEvents(directory: string): Promise<string[]> {
  try {
    return (await readFile(join(directory, "events"), "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

async function waitForEvent(directory: string, event: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readEvents(directory)).includes(event)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for event: ${event}`);
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
      appendEntry: () => {},
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
  assert.ok(definitions.every((definition) => definition.executionMode === undefined));
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
  context.after(() => cleanupFakeGuardian(fake));
  await mkdir(join(fake.directory, ".pi"));
  await writeFile(join(fake.directory, ".pi", "guardian.json"), JSON.stringify({
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    startArgs: [],
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

test("session shutdown awaits the selected sandbox stop", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  await mkdir(join(fake.directory, ".pi"));
  await writeFile(join(fake.directory, ".pi", "guardian.json"), JSON.stringify({
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    startArgs: [],
    cleanup: "keep",
    allow_no_sandbox: false,
  }));

  type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, EventHandler>();
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    getActiveTools: () => ["bash", "read", "write", "edit"],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  guardianExtension(pi);

  const ctx = {
    cwd: fake.directory,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => {},
      notify: () => {},
    },
    sessionManager: {
      getBranch: () => [{
        type: "custom",
        customType: SANDBOX_ENTRY,
        data: { piSessionId: "pi-session", sandboxId: SANDBOX_ID },
      }],
      getSessionId: () => "pi-session",
    },
  } as unknown as ExtensionContext;

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  await waitForEvent(fake.directory, `start:${SANDBOX_ID}`);
  await writeFile(join(fake.directory, "block-stop"), "");

  let settled = false;
  const shutdown = Promise.resolve(
    handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx),
  ).then(() => {
    settled = true;
  });
  await waitForEvent(fake.directory, `stop-begin:${SANDBOX_ID}`);
  assert.equal(settled, false);

  await rm(join(fake.directory, "block-stop"));
  await shutdown;
  assert.equal(settled, true);
  await waitForEvent(fake.directory, `stop-end:${SANDBOX_ID}`);
});

test("an already-running sandbox is borrowed and not stopped", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  const client = createTestClient(fake);
  const owner = client.start(SANDBOX_ID);
  context.after(async () => {
    owner.child.kill("SIGTERM");
    await owner.completed;
  });
  await waitForEvent(fake.directory, `start:${SANDBOX_ID}`);

  const sandbox = new GuardianSandbox(client, SANDBOX_ID);
  const warning = await sandbox.start();
  assert.match(warning?.message ?? "", /already running.*existing owner/s);

  assert.equal(await sandbox.stop(), undefined);
  assert.equal(await client.status(SANDBOX_ID), "running");
  assert.equal((await readEvents(fake.directory)).includes(`stop-begin:${SANDBOX_ID}`), false);

  owner.child.kill("SIGTERM");
  assert.equal((await owner.completed).exitCode, 0);
});

test("changing away from a borrowed sandbox does not remove its running owner", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  const client = createTestClient(fake);
  const owner = client.start(SANDBOX_ID);
  context.after(async () => {
    owner.child.kill("SIGTERM");
    await owner.completed;
  });
  await waitForEvent(fake.directory, `start:${SANDBOX_ID}`);

  const previous = new GuardianSandbox(client, SANDBOX_ID);
  await previous.start();
  const router = new Router();
  const { pi } = activeToolApi();
  router.select(previous, pi);
  const warnings: string[] = [];
  const ctx = {
    ui: { notify: (message: string) => warnings.push(message) },
    sessionManager: { getSessionId: () => "pi-session" },
  } as unknown as ExtensionContext;
  const config = {
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    startArgs: [],
    logFile: join(fake.directory, "guardian.jsonl"),
    cleanup: "remove" as const,
    allowNoSandbox: true,
  };

  await changeSandbox(pi, config, client, router, new DirectSandbox(), ctx);
  assert.equal(await client.status(SANDBOX_ID), "running");
  assert.equal((await readEvents(fake.directory)).some((event) => event.startsWith("remove:")), false);
  assert.match(warnings[0] ?? "", /still owned by another process.*not be removed/);

  owner.child.kill("SIGTERM");
  assert.equal((await owner.completed).exitCode, 0);
});

test("stopping an owned sandbox is idempotent", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  const sandbox = new GuardianSandbox(createTestClient(fake), SANDBOX_ID);
  await sandbox.start();

  assert.deepEqual(await Promise.all([sandbox.stop(), sandbox.stop()]), [undefined, undefined]);
  const events = await readEvents(fake.directory);
  assert.equal(events.filter((event) => event === `stop-begin:${SANDBOX_ID}`).length, 1);
});

test("a Guardian owner that exits during startup prevents sandbox selection", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  await writeFile(join(fake.directory, "fail-start"), "");
  const sandbox = new GuardianSandbox(createTestClient(fake), SANDBOX_ID);

  await assert.rejects(sandbox.start(), /Start Guardian sandbox.*start failed/);
  assert.equal(await createTestClient(fake).status(SANDBOX_ID), "stopped");
});

test("selection awaits the previous stop before starting the next sandbox", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  const client = createTestClient(fake);
  const router = new Router();
  const previous = new GuardianSandbox(client, SANDBOX_ID);
  const next = new GuardianSandbox(client, RESUMED_SANDBOX_ID);
  const { pi } = activeToolApi();
  const ctx = {
    ui: { confirm: async () => false },
    sessionManager: { getSessionId: () => "pi-session" },
  } as unknown as ExtensionContext;
  const config = {
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    startArgs: [],
    logFile: join(fake.directory, "guardian.jsonl"),
    cleanup: "keep" as const,
    allowNoSandbox: true,
  };

  await previous.start();
  router.select(previous, pi);
  await waitForEvent(fake.directory, `start:${SANDBOX_ID}`);
  await writeFile(join(fake.directory, "block-stop"), "");

  const transition = changeSandbox(pi, config, client, router, next, ctx);
  await waitForEvent(fake.directory, `stop-begin:${SANDBOX_ID}`);
  assert.equal((await readEvents(fake.directory)).includes(`start:${RESUMED_SANDBOX_ID}`), false);

  await rm(join(fake.directory, "block-stop"));
  await transition;
  await waitForEvent(fake.directory, `start:${RESUMED_SANDBOX_ID}`);
  const events = await readEvents(fake.directory);
  assert.ok(events.indexOf(`stop-end:${SANDBOX_ID}`) < events.indexOf(`start:${RESUMED_SANDBOX_ID}`));
  await next.stop();
});

test("reselecting the same sandbox stops and starts a fresh owner", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  const client = createTestClient(fake);
  const router = new Router();
  const previous = new GuardianSandbox(client, SANDBOX_ID);
  const next = new GuardianSandbox(client, SANDBOX_ID);
  const { pi } = activeToolApi();
  const ctx = {
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => "pi-session" },
  } as unknown as ExtensionContext;
  const config = {
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    startArgs: [],
    logFile: join(fake.directory, "guardian.jsonl"),
    cleanup: "remove" as const,
    allowNoSandbox: true,
  };

  await previous.start();
  router.select(previous, pi);
  await changeSandbox(pi, config, client, router, next, ctx);

  const events = await readEvents(fake.directory);
  assert.equal(events.filter((event) => event === `start:${SANDBOX_ID}`).length, 2);
  assert.equal(events.filter((event) => event === `stop-end:${SANDBOX_ID}`).length, 1);
  assert.equal(events.some((event) => event.startsWith("remove:")), false);
  await next.stop();
});

test("a failed stop warns and does not prevent selecting the next sandbox", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  const client = createTestClient(fake);
  const router = new Router();
  const previous = new GuardianSandbox(client, SANDBOX_ID);
  const next = new GuardianSandbox(client, RESUMED_SANDBOX_ID);
  const { pi } = activeToolApi();
  const warnings: string[] = [];
  const ctx = {
    ui: {
      confirm: async () => false,
      notify: (message: string, level: string) => {
        if (level === "warning") warnings.push(message);
      },
    },
    sessionManager: { getSessionId: () => "pi-session" },
  } as unknown as ExtensionContext;
  const config = {
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    startArgs: [],
    logFile: join(fake.directory, "guardian.jsonl"),
    cleanup: "keep" as const,
    allowNoSandbox: true,
  };

  await previous.start();
  router.select(previous, pi);
  await waitForEvent(fake.directory, `start:${SANDBOX_ID}`);
  await writeFile(join(fake.directory, "fail-stop"), "");

  await changeSandbox(pi, config, client, router, next, ctx);
  await waitForEvent(fake.directory, `start:${RESUMED_SANDBOX_ID}`);
  assert.equal(router.selectedId, RESUMED_SANDBOX_ID);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Stop Guardian sandbox.*stop failed/);

  await rm(join(fake.directory, "fail-stop"));
  await next.stop();
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
  const result = await client.exec(SANDBOX_ID, {
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
  const sandbox = new GuardianSandbox(createTestClient(fake), SANDBOX_ID);
  await sandbox.start();
  context.after(async () => {
    await sandbox.stop();
    await rm(fake.directory, { force: true, recursive: true });
  });
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

test("bash timeout is reported in seconds", async (context) => {
  const fake = await createFakeGuardian();
  const sandbox = new GuardianSandbox(createTestClient(fake), SANDBOX_ID);
  await sandbox.start();
  context.after(async () => {
    await sandbox.stop();
    await rm(fake.directory, { force: true, recursive: true });
  });

  await assert.rejects(
    sandbox.bash("bash", { command: "sleep 1", timeout: 0.02 }, undefined, undefined, toolContext(fake.directory)),
    /Command timed out after 0\.02 seconds/,
  );
});

test("cancelling one execution does not affect another", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const client = createTestClient(fake);

  const controller = new AbortController();
  const cancelled = client.exec(SANDBOX_ID, {
    input: Buffer.from("trap 'exit 0' TERM\nwhile :; do :; done\n"),
    signal: controller.signal,
  });
  const sibling = client.exec(SANDBOX_ID, {
    input: Buffer.from("sleep 0.1\nprintf sibling\n"),
  });

  setTimeout(() => controller.abort(), 20);
  await assert.rejects(cancelled, /aborted/);
  const result = await sibling;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString(), "sibling");
});
