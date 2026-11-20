import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getConfig } from "../src/config.ts";
import { GuardianClient } from "../src/guardian.ts";
import guardianExtension from "../src/index.ts";
import { DirectSandbox, GuardianSandbox, type ToolBackend } from "../src/backends.ts";
import { findSandboxEntry, SANDBOX_ENTRY, SandboxSession } from "../src/session.ts";
import { registerTools, Router } from "../src/tools.ts";
import { chooseSandbox } from "../src/ui.ts";

const SANDBOX_ID = "guardian-dac386fd7d534af70545f0e8a3cc2f65";
const RESUMED_SANDBOX_ID = "project-worker";
const CONTAINER_ID = "b6f125e8a96c4d370f8a39d25e611b64c927fd0328a71eb4e31c0459ac9865d2";

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
      createArgs: [
        "--mount", "type=bind,source=$(pwd),destination=$(pwd)",
        "--mount", "type=bind,source=$(pwd)/.git,destination=$(pwd)/.git,ro=true",
      ],
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
  assert.deepEqual(config.createArgs, [
    "--mount", `type=bind,source=${directory},destination=${directory}`,
    "--mount", `type=bind,source=${directory}/.git,destination=${directory}/.git,ro=true`,
  ]);
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
printf '%s\\0' "$@" > "$state/$command.args"
case "$command" in
  create)
    id='${SANDBOX_ID}'
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --id) id=$2; shift ;;
        --id=*) id=\${1#--id=} ;;
      esac
      shift
    done
    if [ -f "$state/empty-create" ]; then printf ' \\n'; else printf '%s\\n' "$id"; fi
    ;;
  list) printf '%s\\n' '[{"Names":["${RESUMED_SANDBOX_ID}"],"Image":"localhost/pi-guardian:latest","Id":"${CONTAINER_ID}"}]' ;;
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
  exec)
    export HOME=/container-home
    while [ "$1" != exec ]; do shift; done
    shift 2
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --env) export "$2"; shift 2 ;;
        --workdir) cd -- "$2" || exit 125; shift 2 ;;
        *) exec "$@" ;;
      esac
    done
    ;;
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

function toolContext(cwd: string): ExtensionToolContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => "pi-session",
      getSessionFile: () => undefined,
    },
    tools: [],
    executeTool: async () => {
      throw new Error("Nested tools are not available in this test context");
    },
  } as unknown as ExtensionToolContext;
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
  const definitions = new Map<string, ToolDefinition>();
  registerTools({
    ...pi,
    registerTool: (definition: ToolDefinition) => definitions.set(definition.name, definition),
  } as ExtensionAPI, router);
  const write = definitions.get("write")!;

  assert.throws(() => router.read("read", { path: "missing" }, undefined, undefined, toolContext(directory)), /no sandbox/);
  router.select(direct, pi);
  await write.execute("write", { path: "note.txt", content: "direct" }, undefined, undefined, toolContext(directory));
  assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "direct");

  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  router.select(new GuardianSandbox(createTestClient(fake), SANDBOX_ID), pi);
  assert.deepEqual(active(), ["bash", "read", "write", "edit"]);
  await write.execute("write", { path: "note.txt", content: "sandbox" }, undefined, undefined, toolContext(directory));
  assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "sandbox");
  const execArgs = await readFile(join(fake.directory, "exec.args"), "utf8");
  router.select(direct, pi);
  assert.deepEqual(active(), ["bash", "read", "write", "edit", "ls", "find", "grep"]);
  await write.execute("write", { path: "note.txt", content: "direct again" }, undefined, undefined, toolContext(directory));
  assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "direct again");
  assert.equal(await readFile(join(fake.directory, "exec.args"), "utf8"), execArgs);
});

test("Guardian extension updates tools without rewriting the system prompt", async (context) => {
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
    registerFlag: () => {},
    getFlag: () => SANDBOX_ID,
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  } as unknown as ExtensionAPI;
  guardianExtension(pi);

  let branch: unknown[] = [];
  const statuses: string[] = [];
  const ctx = {
    cwd: fake.directory,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_key: string, text: string) => statuses.push(text),
      notify: () => {},
    },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "pi-session",
    },
  } as unknown as ExtensionContext;

  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(activeTools, ["bash", "read", "write", "edit"]);
  assert.equal(statuses.at(-1), `Guardian: ${SANDBOX_ID}`);

  assert.equal(handlers.has("before_agent_start"), false);

  branch = [...branch, {
    type: "custom",
    customType: SANDBOX_ENTRY,
    data: { piSessionId: "pi-session", sandboxId: null },
  }];
  await handlers.get("session_tree")?.({ type: "session_tree" }, ctx);
  assert.deepEqual(activeTools, ["bash", "read", "write", "edit", "ls", "find", "grep"]);
  assert.equal(statuses.at(-1), "Guardian: no sandbox");
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
    registerFlag: () => {},
    getFlag: () => undefined,
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
    isIdle: () => true,
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

  await new SandboxSession(pi, router, config).change(new DirectSandbox(), ctx);
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
    isIdle: () => true,
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

  const transition = new SandboxSession(pi, router, config).change(next, ctx);
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
    isIdle: () => true,
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
  await new SandboxSession(pi, router, config).change(next, ctx);

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
    isIdle: () => true,
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

  await new SandboxSession(pi, router, config).change(next, ctx);
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

test("GuardianClient uses sandbox IDs for sandbox commands", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const client = createTestClient(fake);

  assert.equal(await client.create("demo-image", []), SANDBOX_ID);
  assert.equal(await client.status(SANDBOX_ID), "stopped");
  assert.deepEqual(await client.list(), [{
    Names: [RESUMED_SANDBOX_ID],
    Image: "localhost/pi-guardian:latest",
    Id: CONTAINER_ID,
  }]);
  const statusArgs = (await readFile(join(fake.directory, "status.args"), "utf8")).split("\0").slice(0, -1);
  assert.deepEqual(statusArgs.slice(statusArgs.indexOf("status")), ["status", SANDBOX_ID]);

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const result = await client.exec(SANDBOX_ID, ["/bin/sh", "-s"], {
    input: Buffer.from("printf stdout\nprintf stderr >&2\nexit 7\n"),
    cwd: fake.directory,
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
  });
  assert.equal(result.exitCode, 7);
  assert.equal(Buffer.concat(stdout).toString(), "stdout");
  assert.equal(Buffer.concat(stderr).toString(), "stderr");
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
  const args = (await readFile(join(fake.directory, "exec.args"), "utf8")).split("\0").slice(0, -1);
  assert.deepEqual(args.slice(args.indexOf("exec")), [
    "exec", SANDBOX_ID,
    "--env", `HOME=${homedir()}`,
    "--workdir", fake.directory,
    "/bin/sh", "-s",
  ]);

  await client.remove(SANDBOX_ID);
  assert.deepEqual(await readEvents(fake.directory), [`remove:${SANDBOX_ID}`]);
});

test("GuardianClient forwards optional --id arguments", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const client = createTestClient(fake);

  for (const createArgs of [["--id", RESUMED_SANDBOX_ID], [`--id=${RESUMED_SANDBOX_ID}`]]) {
    assert.equal(await client.create("demo-image", createArgs), RESUMED_SANDBOX_ID);
    const args = (await readFile(join(fake.directory, "create.args"), "utf8")).split("\0").slice(0, -1);
    assert.deepEqual(args.slice(args.indexOf("create")), ["create", ...createArgs, "demo-image"]);
  }
});

test("sandbox IDs survive selection, restore, and removal", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  const router = new Router();
  const branch: unknown[] = [];
  const { pi: activePi } = activeToolApi();
  const pi = {
    ...activePi,
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    getFlag: () => undefined,
  } as unknown as ExtensionAPI;
  const session = new SandboxSession(pi, router, {
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    startArgs: [],
    logFile: join(fake.directory, "guardian.jsonl"),
    cleanup: "remove",
    allowNoSandbox: true,
  });
  const ctx = {
    cwd: fake.directory,
    mode: "rpc",
    hasUI: true,
    isIdle: () => true,
    ui: {
      select: async (title: string, options: string[]) => title === "Guardian sandbox" ? "Resume" : options[0],
      notify: (message: string) => assert.fail(message),
      theme: { fg: (_color: string, text: string) => text },
      setStatus: () => {},
    },
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "pi-session",
    },
  } as unknown as ExtensionContext;

  const selected = await chooseSandbox(session.config, session.client, session.direct, ctx);
  assert.ok(selected);
  assert.equal(selected.id, RESUMED_SANDBOX_ID);
  await session.change(selected, ctx);
  assert.deepEqual(findSandboxEntry(ctx), { piSessionId: "pi-session", sandboxId: RESUMED_SANDBOX_ID });

  await session.stop(ctx);
  await session.restore(ctx);
  assert.equal(router.selectedId, RESUMED_SANDBOX_ID);
  await session.change(session.direct, ctx);
  assert.deepEqual(findSandboxEntry(ctx), { piSessionId: "pi-session", sandboxId: null });
  assert.deepEqual(await readEvents(fake.directory), [
    `start:${RESUMED_SANDBOX_ID}`, `stop-begin:${RESUMED_SANDBOX_ID}`, `stop-end:${RESUMED_SANDBOX_ID}`,
    `start:${RESUMED_SANDBOX_ID}`, `stop-begin:${RESUMED_SANDBOX_ID}`, `stop-end:${RESUMED_SANDBOX_ID}`,
    `remove:${RESUMED_SANDBOX_ID}`,
  ]);
});

test("GuardianClient rejects an empty sandbox ID from create", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  await writeFile(join(fake.directory, "empty-create"), "");

  await assert.rejects(createTestClient(fake).create("demo-image", []), /returned no sandbox ID/);
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
  const file = "nested/note.txt";

  await sandbox.write("write", { path: file, content: "hello Guardian" }, undefined, undefined, ctx);
  const readResult = await sandbox.read("read", { path: file }, undefined, undefined, ctx);
  assert.match(readResult.content[0]?.type === "text" ? readResult.content[0].text : "", /hello Guardian/);
  assert.equal(readResult.structuredContent, "hello Guardian");

  await sandbox.edit("edit", {
    path: file,
    edits: [{ oldText: "hello Guardian", newText: "edited Guardian" }],
  }, undefined, undefined, ctx);
  assert.equal(await readFile(join(fake.directory, file), "utf8"), "edited Guardian");

  const hostileFile = join(
    fake.directory,
    "space ' ; $(printf injected)\nline",
    "note '$HOME; $(printf injected).txt",
  );
  const literalContent = "literal shell characters: '$HOME' $(exit 7) `exit 8`\n\0🦀";
  await sandbox.write("write", {
    path: hostileFile,
    content: literalContent,
  }, undefined, undefined, ctx);
  const writeArgs = (await readFile(join(fake.directory, "exec.args"), "utf8")).split("\0").slice(0, -1);
  assert.deepEqual(writeArgs.slice(writeArgs.indexOf("exec")), [
    "exec", SANDBOX_ID, "--env", `HOME=${homedir()}`,
    "/bin/sh", "-c", 'cat > "$1"', "--", hostileFile,
  ]);
  const hostileResult = await sandbox.read(
    "read",
    { path: hostileFile },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(await readFile(hostileFile, "utf8"), literalContent);
  assert.match(
    hostileResult.content[0]?.type === "text" ? hostileResult.content[0].text : "",
    /literal shell characters/,
  );

  const bashResult = await sandbox.bash("bash", {
    command: "pwd",
  }, undefined, undefined, ctx);
  assert.partialDeepStrictEqual(bashResult.structuredContent, {
    output: `${fake.directory}\n`,
    truncated: false,
    exit_code: 0,
  });

  const cwd = join(fake.directory, "work ' $HOME; =\nline");
  await mkdir(cwd);
  const homeResult = await sandbox.bash("bash", {
    command: "printf '%s\\n' \"$PWD\" \"$HOME\" ~",
  }, undefined, undefined, toolContext(cwd));
  assert.partialDeepStrictEqual(homeResult.structuredContent, {
    output: `${cwd}\n${homedir()}\n${homedir()}\n`,
    exit_code: 0,
  });
  const args = (await readFile(join(fake.directory, "exec.args"), "utf8")).split("\0").slice(0, -1);
  assert.deepEqual(args.slice(args.indexOf("exec")), [
    "exec", SANDBOX_ID,
    "--env", `HOME=${homedir()}`,
    "--workdir", cwd,
    "/bin/sh", "-s",
  ]);

  const failure = await sandbox.bash("bash", {
    command: "printf failure; exit 7",
  }, undefined, undefined, ctx);
  assert.equal(failure.isError, true);
  assert.partialDeepStrictEqual(failure.structuredContent, {
    output: "failure",
    truncated: false,
    exit_code: 7,
  });
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
  const cancelled = client.exec(SANDBOX_ID, ["/bin/sh", "-s"], {
    input: Buffer.from("trap 'exit 0' TERM\nwhile :; do :; done\n"),
    signal: controller.signal,
  });
  const sibling = client.exec(SANDBOX_ID, ["/bin/sh", "-s"], {
    input: Buffer.from("sleep 0.1\nprintf sibling\n"),
  });

  setTimeout(() => controller.abort(), 20);
  await assert.rejects(cancelled, /aborted/);
  const result = await sibling;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString(), "sibling");
});

test("GuardianClient captures raw bytes and only buffers streams without callbacks", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const client = createTestClient(fake);
  const input = Buffer.alloc(256 * 1024);
  for (let index = 0; index < input.length; index++) input[index] = index % 256;

  const captured = await client.exec(SANDBOX_ID, ["cat"], { input });
  assert.equal(captured.exitCode, 0);
  assert.deepEqual(captured.stdout, input);

  const chunks: Buffer[] = [];
  const streamed = await client.exec(SANDBOX_ID, [
    "/bin/sh", "-c", "printf streamed; printf diagnostic >&2; exit 7",
  ], { onStdout: (data) => chunks.push(data) });
  assert.equal(streamed.exitCode, 7);
  assert.equal(Buffer.concat(chunks).toString(), "streamed");
  assert.equal(streamed.stdout.length, 0);
  assert.equal(streamed.stderr.toString(), "diagnostic");
});

test("child startup selection is explicit and never stops a borrowed owner", async (context) => {
  const fake = await createFakeGuardian();
  await mkdir(join(fake.directory, ".pi"));
  const client = createTestClient(fake);
  const owner = client.start(SANDBOX_ID);
  context.after(async () => {
    owner.child.kill("SIGTERM");
    await owner.completed;
    await rm(fake.directory, { force: true, recursive: true });
  });
  await waitForEvent(fake.directory, `start:${SANDBOX_ID}`);

  for (const [initial, allowNoSandbox] of [[SANDBOX_ID, false], ["none", true], ["none", false]] as const) {
    await writeFile(join(fake.directory, ".pi", "guardian.json"), JSON.stringify({
      binary: fake.binary,
      globalArgs: [],
      createArgs: [],
      startArgs: [],
      allow_no_sandbox: allowNoSandbox,
    }));
    type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, ToolDefinition>();
    const { pi: activePi, active } = activeToolApi();
    const pi = {
      ...activePi,
      registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
      registerCommand: () => {},
      registerFlag: (name: string) => assert.equal(name, "guardian-sandbox"),
      getFlag: () => initial,
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    } as unknown as ExtensionAPI;
    const errors: string[] = [];
    const ctx = {
      ...toolContext(fake.directory),
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: () => {},
        notify: (message: string, level: string) => {
          if (level === "error") errors.push(message);
        },
      },
      sessionManager: {
        getSessionId: () => "child-session",
        getSessionFile: () => undefined,
        getBranch: () => [{
          type: "custom",
          customType: SANDBOX_ENTRY,
          data: { piSessionId: "parent-session", sandboxId: RESUMED_SANDBOX_ID },
        }],
      },
    } as unknown as ExtensionToolContext;
    guardianExtension(pi);
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);

    if (initial === "none" && !allowNoSandbox) {
      assert.match(errors[0] ?? "", /passthrough is disabled/);
      await assert.rejects(async () => tools.get("bash")!.execute(
        "child-call", { command: "pwd" }, undefined, undefined, ctx,
      ), /no sandbox is selected/);
    } else {
      assert.deepEqual(errors, []);
      const result = await tools.get("bash")!.execute(
        "child-call", { command: "pwd" }, undefined, undefined, ctx,
      );
      assert.partialDeepStrictEqual(result.structuredContent, { output: `${fake.directory}\n`, exit_code: 0 });
      assert.equal(active().includes("grep"), initial === "none");
    }

    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
    assert.equal(await client.status(SANDBOX_ID), "running");
  }
  assert.equal((await readEvents(fake.directory)).some((event) => event.startsWith("stop-begin:")), false);
});

test("switching is rejected if Pi is busy, including after confirmation", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => rm(fake.directory, { force: true, recursive: true }));
  const client = createTestClient(fake);
  const config = {
    binary: fake.binary,
    image: "demo-image",
    globalArgs: [],
    createArgs: [],
    startArgs: [],
    logFile: join(fake.directory, "guardian.jsonl"),
    cleanup: "ask" as const,
    allowNoSandbox: true,
  };

  for (const initiallyIdle of [false, true]) {
    let idle = initiallyIdle;
    let stopped = false;
    const previous = new GuardianSandbox(client, SANDBOX_ID);
    previous.stop = async () => { stopped = true; return undefined; };
    const router = new Router();
    const { pi } = activeToolApi();
    router.select(previous, pi);
    const ctx = {
      isIdle: () => idle,
      ui: { confirm: async () => { idle = false; return true; } },
    } as unknown as ExtensionContext;

    await assert.rejects(new SandboxSession(pi, router, config).change(new DirectSandbox(), ctx), /while Pi is running/);
    assert.equal(router.selected, previous);
    assert.equal(stopped, false);
  }
});

test("failed cleanup leaves no backend selected and does not start the replacement", async (context) => {
  const fake = await createFakeGuardian();
  context.after(() => cleanupFakeGuardian(fake));
  const client = createTestClient(fake);
  const previous = new GuardianSandbox(client, SANDBOX_ID);
  const next = new GuardianSandbox(client, RESUMED_SANDBOX_ID);
  const router = new Router();
  const { pi } = activeToolApi();
  const ctx = { isIdle: () => true, ui: { notify: () => {} } } as unknown as ExtensionContext;
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
  await writeFile(join(fake.directory, "fail-remove"), "");

  await assert.rejects(new SandboxSession(pi, router, config).change(next, ctx), /remove sandbox.*remove failed/s);
  assert.equal(router.selected, undefined);
  assert.equal((await readEvents(fake.directory)).includes(`start:${RESUMED_SANDBOX_ID}`), false);
});
