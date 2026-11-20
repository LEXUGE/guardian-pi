import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { DirectSandbox } from "../src/backends.ts";

function toolContext(cwd: string): ExtensionToolContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => "tool-test",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionToolContext;
}

test("Pi resolves file paths before invoking custom operations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "guardian-pi-paths-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "session");
  const ctx = toolContext(cwd);
  const factoryCwd = join(directory, "factory");
  const accesses: string[] = [];
  const reads: string[] = [];
  const directories: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const read = createReadToolDefinition(factoryCwd, {
    operations: {
      access: async (path) => { accesses.push(path); },
      readFile: async (path) => {
        reads.push(path);
        return Buffer.from("contents");
      },
    },
  });
  const write = createWriteToolDefinition(factoryCwd, {
    operations: {
      mkdir: async (path) => { directories.push(path); },
      writeFile: async (path, content) => { writes.push({ path, content }); },
    },
  });
  const cases = [
    ["note.txt", join(cwd, "note.txt")],
    ["@src/../note.txt", join(cwd, "note.txt")],
    ["../outside.txt", join(directory, "outside.txt")],
    [join(directory, "absolute.txt"), join(directory, "absolute.txt")],
    [pathToFileURL(join(directory, "with space.txt")).href, join(directory, "with space.txt")],
    ["~/note.txt", join(homedir(), "note.txt")],
    ["$HOME/note.txt", join(cwd, "$HOME/note.txt")],
    ["*.txt", join(cwd, "*.txt")],
    ["'note.txt'", join(cwd, "'note.txt'")],
    ["~someone/note.txt", join(cwd, "~someone/note.txt")],
  ];

  for (const [input, expected] of cases) {
    const result = await read.execute("read", { path: input }, undefined, undefined, ctx);
    await write.execute("write", { path: input, content: "literal $HOME" }, undefined, undefined, ctx);
    assert.equal(result.structuredContent, "contents");
    assert.equal(accesses.at(-1), expected);
    assert.equal(reads.at(-1), expected);
    assert.equal(directories.at(-1), dirname(expected));
    assert.deepEqual(writes.at(-1), { path: expected, content: "literal $HOME" });
  }
});

test("Pi passes shell commands unexpanded to custom operations", async () => {
  const ctx = toolContext("/session");
  const command = "printf '%s' \"$HOME\" ~/file *.txt";
  const calls: { command: string; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  const bash = createBashToolDefinition("/factory", {
    operations: {
      exec: async (command, cwd, { env, onData }) => {
        calls.push({ command, cwd, env });
        onData(Buffer.from("output"));
        return { exitCode: 0 };
      },
    },
  });

  const result = await bash.execute("bash", { command }, undefined, undefined, ctx);
  assert.equal(calls[0]?.command, command);
  assert.equal(calls[0]?.cwd, ctx.cwd);
  assert.equal(calls[0]?.env?.HOME, process.env.HOME);
  assert.equal(calls[0]?.env?.PI_SESSION_ID, "tool-test");
  assert.partialDeepStrictEqual(result.structuredContent, {
    output: "output",
    truncated: false,
    exit_code: 0,
  });
});

test("direct write creates parents and replaces the whole file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "guardian-pi-write-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const direct = new DirectSandbox();
  const ctx = toolContext(directory);
  const path = "nested/note.txt";

  await direct.write("write", { path, content: "long original contents" }, undefined, undefined, ctx);
  await direct.write("write", { path, content: "short" }, undefined, undefined, ctx);
  assert.equal(await readFile(join(directory, path), "utf8"), "short");
});

test("local shell calls do not preserve cd or exported variables", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "guardian-pi-shell-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "child"));
  const direct = new DirectSandbox();
  const ctx = toolContext(directory);

  await direct.bash("bash", {
    command: "cd child && export GUARDIAN_PI_CALL_TEST=changed",
  }, undefined, undefined, ctx);
  const result = await direct.bash("bash", {
    command: "printf '%s\\n' \"$PWD\" \"${GUARDIAN_PI_CALL_TEST-unset}\"",
  }, undefined, undefined, ctx);
  assert.partialDeepStrictEqual(result.structuredContent, {
    output: `${directory}\n${process.env.GUARDIAN_PI_CALL_TEST ?? "unset"}\n`,
    exit_code: 0,
  });
});
