import { describe, expect, test } from "bun:test";
import { adoptJournalNeedsRecovery, settleStaleAdoptJournal } from "../src/transient-adopt.ts";
import { FakeProcessTree } from "./fake-tree.ts";

describe("settleStaleAdoptJournal", () => {
  test("completes deactivate-term when journal host is gone and official gateway matches", () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const live = tree.spawn("host", { parent: supervisor });
    const deadHost = {
      pid: 265104,
      uid: 1000,
      start: 1,
      exe: "/exec-daemon/node",
      cmdline: ["/exec-daemon/node", "/home/box/sand-host/host-main.cjs"],
    };
    const settled = settleStaleAdoptJournal({
      state: {
        launchMode: "transient-adopt",
        phase: "deactivate-term",
        tempSupervisor: null,
        adoptingSupervisor: supervisor,
        host: deadHost,
      },
      inspect: (pid) => tree.inspect(pid),
      uniqueHost: live,
      uniqueSupervisor: supervisor,
      gatewayPid: live.pid,
    });
    expect(settled?.phase).toBe("direct-official");
    expect(adoptJournalNeedsRecovery(settled)).toBe(false);
    expect(settled?.host?.pid).toBe(live.pid);
  });

  test("keeps recovery when the journal host is still alive", () => {
    const tree = new FakeProcessTree();
    const wrapper = tree.spawn("wrapper");
    const supervisor = tree.spawn("supervisor", { parent: wrapper });
    const host = tree.spawn("host", { parent: supervisor });
    const settled = settleStaleAdoptJournal({
      state: {
        launchMode: "transient-adopt",
        phase: "deactivate-term",
        tempSupervisor: null,
        adoptingSupervisor: supervisor,
        host,
      },
      inspect: (pid) => tree.inspect(pid),
      uniqueHost: host,
      uniqueSupervisor: supervisor,
      gatewayPid: host.pid,
    });
    expect(settled?.phase).toBe("deactivate-term");
    expect(adoptJournalNeedsRecovery(settled)).toBe(true);
  });
});
