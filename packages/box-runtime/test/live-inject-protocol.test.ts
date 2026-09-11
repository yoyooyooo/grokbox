import { describe, expect, test } from "bun:test";
import { runIdentityChainInject } from "../src/internal/process/live-inject.ts";
import { FakeProcessTree, hangUntilAbort } from "./fake-tree.ts";

describe("retired identity inject protocol", () => {
  test("does not STOP/TERM a fake tree", async () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor");
    const host = tree.spawn("host");
    const result = await runIdentityChainInject({
      processes: tree,
      wrapper,
      supervisor,
      host,
      diskSha: () => "sha-live",
      roles: () => tree.roles(),
      spawnHost: () => tree.spawn("host"),
      readMarker: () => ({ transformed: true, mode: "identity", modeld: false }),
      wait: hangUntilAbort(),
      now: () => 0,
    });
    expect(result).toMatchObject({ ok: false, code: "legacy-inject-removed", coverage: "none" });
    expect(tree.signals).toEqual([]);
    expect(tree.alive(wrapper.pid)).toBe(true);
    expect(tree.alive(supervisor.pid)).toBe(true);
    expect(tree.alive(host.pid)).toBe(true);
  });
});
