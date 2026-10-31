/**
 * The store's crash-safety: a writer killed mid-write never leaves a torn file.
 *
 * The writer is a child process looping atomicWriteFileSync over two 3 MB
 * blobs, SIGKILLed at a random moment; the live file must always parse as
 * the seed or one of the blobs. It runs this module's own code, transpiled to
 * plain JS, since a forked Node cannot import TypeScript on every version CI
 * may run. One torn file fails.
 */
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROUNDS = 20;
const WRITER = `const [, , file, moduleUrl] = process.argv;
const { atomicWriteFileSync } = await import(moduleUrl);
const blob = (tag) => JSON.stringify({ tag, pad: tag.repeat(3_000_000) });
const A = blob("a");
const B = blob("b");
process.send?.("ready");
let i = 0;
for (;;) atomicWriteFileSync(file, i++ % 2 === 0 ? A : B);
`;

let dir = "";
let writer = "";
let moduleUrl = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jsonstore-"));
  const source = readFileSync(fileURLToPath(new URL("./jsonStore.ts", import.meta.url)), "utf-8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const module = join(dir, "jsonStore.mjs");
  writeFileSync(module, outputText);
  moduleUrl = pathToFileURL(module).href;
  writer = join(dir, "writer.mjs");
  writeFileSync(writer, WRITER);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kill a writer mid-write and say whether the live file is still whole. */
async function killMidWrite(): Promise<boolean> {
  const live = join(mkdtempSync(join(dir, "store-")), "store.json");
  writeFileSync(live, JSON.stringify({ tag: "seed" }));
  const child = fork(writer, [live, moduleUrl], { stdio: "ignore", execArgv: [] });
  await new Promise((r) => child.once("message", r));
  await sleep(15 + Math.random() * 60);
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await exited;
  try {
    const parsed = JSON.parse(readFileSync(live, "utf-8")) as { tag?: unknown };
    return ["seed", "a", "b"].includes(parsed.tag as string);
  } catch {
    return false;
  }
}

describe("atomicWriteFileSync", () => {
  it(`leaves the live file whole through ${ROUNDS} mid-write SIGKILLs`, async () => {
    let torn = 0;
    for (let i = 0; i < ROUNDS; i++) if (!(await killMidWrite())) torn++;
    expect(torn).toBe(0);
  }, 60_000);
});
