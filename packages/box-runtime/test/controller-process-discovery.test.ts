import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strictLinuxObservationPort } from "../src/internal/process/linux.node.ts";
async function fixture(argv = "node\0/fixture/unrelated.mjs\0") {
  const root = await mkdtemp(join(tmpdir(), "controller-proc-discovery-"));
  const pid = 101; await mkdir(join(root, String(pid)));
  await writeFile(join(root, String(pid), "stat"), `${pid} (fixture) S 1 ${Array(17).fill("0").join(" ")} 900`);
  await writeFile(join(root, String(pid), "cmdline"), argv);
  let fullReads = 0;
  const port = strictLinuxObservationPort(root, () => { fullReads++; throw Object.assign(Error("fixture executable denied"), { code: "EACCES" }); });
  return { root, pid, port, fullReads: () => fullReads };
}
test("stable role exclusion does not require exe permission and never excludes an exact recorded owner", async () => {
  const f = await fixture();
  expect(f.port.list()).toEqual([]); expect(f.fullReads()).toBe(0);
  expect(f.port.inspectLifetime!(f.pid)).toEqual({ pid: f.pid, start: 900 });
  expect(() => f.port.inspect(f.pid)).toThrow(); expect(f.fullReads()).toBe(1);
  await writeFile(join(f.root, String(f.pid), "cmdline"), "node\0/fixture/host-main.cjs\0");
  expect(() => f.port.recheckDiscovery!()).toThrow("restoration-discovery-changed");
});
for (const name of ["supervise-sand-supervisor", "sand-supervisor.mjs", "host-main.cjs", "grokbox-temp-supervisor.cjs", "guardian-child.cjs", "injector-hold.cjs"]) test(`unreadable candidate ${name} blocks instead of being excluded`, async () => {
  const f = await fixture(`node\0/fixture/${name}\0`);
  expect(() => f.port.list()).toThrow(); expect(f.fullReads()).toBe(1);
});
for (const argv of ["", "node\0/fixture/unrelated.mjs", "\0"]) test(`incomplete role snapshot ${JSON.stringify(argv)} blocks`, async () => {
  const f = await fixture(argv); expect(() => f.port.list()).toThrow("restoration-discovery-unavailable");
});
