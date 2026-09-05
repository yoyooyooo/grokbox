import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";
import { captureCli, parseJson } from "./helpers.ts";

const SAMPLE_MODELS = {
  version: 1,
  models: {
    "acme/fast": {
      provider: "acme",
      model: "fast",
      endpoint: "https://api.acme.test/v1",
      apiKeyRef: "env:ACME_KEY",
      capabilities: { vision: false, tools: true },
      dataTypes: ["text", "tools"],
    },
  },
  assignments: { main: null, agents: {} },
};

async function withRoot() {
  const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-box-runtime-"));
  await writeFile(join(boxRuntimeRoot, "models.json"), `${JSON.stringify(SAMPLE_MODELS, null, 2)}\n`);
  return boxRuntimeRoot;
}

function data(stdout: string): Record<string, unknown> {
  return (parseJson(stdout) as { data: Record<string, unknown> }).data;
}

describe("box-local runtime CLI", () => {
  test("registry has runtime leaves and no inject/heal/kill", () => {
    const keys = LEAF_COMMANDS.map((leaf) => leaf.path.join(" "));
    for (const key of [
      "runtime status",
      "runtime activate",
      "runtime deactivate",
      "runtime log",
      "runtime contracts",
      "runtime models check",
      "runtime models list",
      "runtime models use",
      "runtime models reset",
      "runtime watchdog run",
      "runtime modeld run",
    ]) {
      expect(keys).toContain(key);
    }
    expect(
      keys.some(
        (key) =>
          key.includes("inject") ||
          key.includes("heal") ||
          key === "runtime kill" ||
          key.split(" ").includes("ctl"),
      ),
    ).toBe(false);
  });

  test("--profile and remote transports return runtime_local_only", async () => {
    const profiled = await captureCli(["--profile", "default", "runtime", "status"], {
      discoveryPath: "/dev/null",
    });
    expect(profiled.code).toBe(65);
    expect(profiled.stdout).toBe("");
    expect((parseJson(profiled.stderr) as { error: { code: string } }).error.code).toBe("runtime_local_only");

    const remote = await captureCli(["runtime", "status"], {
      discoveryPath: "/dev/null",
      sshHost: "box.example",
    });
    expect(remote.code).toBe(65);
    expect((parseJson(remote.stderr) as { error: { code: string } }).error.code).toBe("runtime_local_only");
  });

  test("deactivate writes desired disabled and does not claim live coverage none", async () => {
    const boxRuntimeRoot = await withRoot();
    const deactivated = await captureCli(["runtime", "deactivate"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(deactivated.code, deactivated.stderr).toBe(0);
    const body = data(deactivated.stdout);
    expect(body.desired).toBe("disabled");
    expect(body.requested).toBe(true);
    expect(body).not.toHaveProperty("coverage");
    expect(JSON.stringify(body)).not.toContain('"coverage":"none"');
  });

  test("status/log/contracts do not repair and status has required fields", async () => {
    const boxRuntimeRoot = await withRoot();
    const status = await captureCli(["runtime", "status"], { discoveryPath: "/dev/null", boxRuntimeRoot });
    expect(status.code).toBe(0);
    const body = data(status.stdout);
    expect(body).toMatchObject({
      coverage: "none",
      circuit: "closed",
      lastHeal: null,
    });
    expect(body.census).toBeDefined();
    expect((body.window as { affectedInvocations: string }).affectedInvocations).toBe("unknown");
    expect((body.installation as { durableRoot: string }).durableRoot).toBe(boxRuntimeRoot);
    expect((body.installation as { durableRoot: string }).durableRoot).not.toContain("/.grokbox/runtime/");

    const log = await captureCli(["runtime", "log"], { discoveryPath: "/dev/null", boxRuntimeRoot });
    expect(log.code).toBe(0);
    const contracts = await captureCli(["runtime", "contracts"], { discoveryPath: "/dev/null", boxRuntimeRoot });
    expect(contracts.code).toBe(0);
  });

  test("models use discloses endpoint and --for vs default", async () => {
    const boxRuntimeRoot = await withRoot();
    const used = await captureCli(["runtime", "models", "use", "acme/fast"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(used.code, used.stderr).toBe(0);
    expect(data(used.stdout)).toMatchObject({
      endpoint: "https://api.acme.test/v1",
      dataTypes: ["text", "tools"],
      takesEffect: "next_user_turn",
      blastRadius: "box_default",
      assignment: "main",
    });

    const forBot = await captureCli(["runtime", "models", "use", "acme/fast", "--for", "agent-tom"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(forBot.code, forBot.stderr).toBe(0);
    expect(data(forBot.stdout)).toMatchObject({
      blastRadius: "single_bot",
      assignment: { agent: "agent-tom" },
    });
  });

  test("models reset is refused while route is desired", async () => {
    const boxRuntimeRoot = await withRoot();
    const use = await captureCli(["runtime", "models", "use", "acme/fast"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(use.code, use.stderr).toBe(0);
    const activate = await captureCli(["runtime", "activate", "--mode", "route"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(activate.code, activate.stderr).toBe(0);
    const reset = await captureCli(["runtime", "models", "reset"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(reset.code).toBe(2);
    expect((parseJson(reset.stderr) as { error: { code: string } }).error.code).toBe("invalid_usage");
  });

  test("activate stays desired-only and watchdog run does not expose inject/ctl", async () => {
    const boxRuntimeRoot = await withRoot();
    const activate = await captureCli(["runtime", "activate", "--mode", "identity"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(activate.code, activate.stderr).toBe(0);
    expect(data(activate.stdout)).toMatchObject({ desired: "identity", inject: false });

    const watchdog = await captureCli(["runtime", "watchdog", "run"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(watchdog.code, watchdog.stderr).toBe(0);
    const body = data(watchdog.stdout);
    expect(body.process).toBe("watchdog");
    expect(body.inject).toBe(false);
    expect(body.signaled).toBe(false);
    expect(["converged", "pending", "blocked", "recovery-required"]).toContain(String(body.reconcile));
    expect(JSON.stringify(body)).not.toContain("ctl");
  });

  test("literal secrets are rejected", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-box-runtime-"));
    await mkdir(boxRuntimeRoot, { recursive: true });
    await writeFile(
      join(boxRuntimeRoot, "models.json"),
      `${JSON.stringify({
        version: 1,
        models: {
          "acme/fast": {
            provider: "acme",
            model: "fast",
            endpoint: "https://api.acme.test/v1",
            apiKeyRef: "sk-literal",
          },
        },
        assignments: { main: null, agents: {} },
      })}\n`,
    );
    const check = await captureCli(["runtime", "models", "check"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot,
    });
    expect(check.code).toBe(31);
    expect((parseJson(check.stderr) as { error: { code: string } }).error.code).toBe("credential_invalid");
  });
});
