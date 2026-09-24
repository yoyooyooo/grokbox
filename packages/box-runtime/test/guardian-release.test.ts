import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/internal/process/helpers/guardian-child.cjs", import.meta.url), "utf8");
const expected = { pid: 7, ppid: 1, uid: 1000, start: 123, exe: "/owned/node", cmdline: ["node", "owned-victim"] };

type Identity = typeof expected;
function replay(changes: Partial<Identity> = {}) {
  const observed = { ...expected, ...changes };
  const stdin = new Map<string, () => void>();
  let deadline: (() => void) | undefined;
  const signals: Array<[number, string]> = [];
  const writes: string[] = [];
  let exits = 0;
  const fs = {
    readFileSync(path: string) {
      if (path === "/owned/identity.json") return JSON.stringify({ frozen: [expected], deadlineMs: 8000 });
      if (path === `/proc/${expected.pid}/stat`) {
        if (observed.pid !== expected.pid) throw new Error("owned-gone");
        const rest = ["T", String(observed.ppid), ...Array(17).fill("0"), String(observed.start)];
        return `${observed.pid} (owned-victim) ${rest.join(" ")}`;
      }
      if (path === `/proc/${expected.pid}/status`) return `Uid:\t${observed.uid}\t${observed.uid}\t${observed.uid}\t${observed.uid}\n`;
      if (path === `/proc/${expected.pid}/cmdline`) return Buffer.from(observed.cmdline.join("\0") + "\0");
      throw new Error("unqualified-owned-path");
    },
    readlinkSync(path: string) {
      if (path !== `/proc/${expected.pid}/exe`) throw new Error("unqualified-owned-link");
      return observed.exe;
    },
  };
  runInNewContext(source, {
    require(name: string) { if (name !== "node:fs") throw new Error("unqualified-import"); return fs; },
    process: { argv: ["node", "owned-guardian", "/owned/identity.json"],
      exit(code: number) { expect(code).toBe(0); exits++; }, kill(pid: number, signal: string) { signals.push([pid, signal]); },
      stdout: { write(value: string) { writes.push(value); }, on() {}, end(value: string, done: () => void) { writes.push(value); done(); } },
      stdin: { on(event: string, callback: () => void) { stdin.set(event, callback); }, resume() {} },
    },
    setTimeout(callback: () => void, timeout: number) { expect(timeout).toBe(8000); deadline = callback; },
  }, { timeout: 1000 });
  expect(writes).toEqual(["armed\n"]);
  return { signals, release: (kind: "end" | "error" | "deadline") => {
    const callback = kind === "deadline" ? deadline : stdin.get(kind);
    if (!callback) throw new Error("missing-release-handler");
    callback();
    expect(exits).toBe(1);
  } };
}

for (const first of ["end", "error", "deadline"] as const) {
  test(`guardian ${first} releases a matching identity once; later triggers cannot repeat the effect`, () => {
    const result = replay();
    expect(result.signals).toEqual([]);
    result.release(first);
    result.release("end"); result.release("error"); result.release("deadline");
    expect(result.signals).toEqual([[expected.pid, "SIGCONT"]]);
  });
}

for (const [name, changes] of [
  ["gone", { pid: 8 }], ["reused-start", { start: 124 }], ["different-owner", { uid: 1001 }],
  ["different-parent", { ppid: 2 }], ["different-executable", { exe: "/owned/other" }],
  ["different-arguments", { cmdline: ["node", "not-our-victim"] }],
] as Array<[string, Partial<Identity>]>) {
  test(`guardian never relaxes identity validation for ${name}`, () => {
    const result = replay(changes);
    result.release("end"); result.release("deadline");
    expect(result.signals).toEqual([]);
  });
}
