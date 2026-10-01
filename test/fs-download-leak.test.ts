import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Scenario = {
  bytes?: string;
  rmEioNext?: number;
  rmEioAll?: boolean;
  rmEaccesAll?: boolean;
  linkEacces?: boolean;
  remoteName?: string;
};

type Outcome = {
  code: number;
  verified: boolean | null;
  rmTempCalls: number;
  temps: string[];
  listing: string[];
  lastMethod: string | null;
  destContent: string | null;
};

const repoRoot = join(import.meta.dir, "..");
const childArg = "./test/fs-download-leak.fault.isolated.ts";
let runCounter = 0;

function runFault(scenario: Scenario): Outcome {
  runCounter += 1;
  const resultFile = join(tmpdir(), `grokbox-leak-result-${process.pid}-${Date.now()}-${runCounter}.json`);
  const res = spawnSync(process.execPath, ["test", childArg], {
    cwd: repoRoot,
    env: { ...process.env, FS_FAULT: JSON.stringify(scenario), FS_RESULT_FILE: resultFile },
    encoding: "utf8",
  });
  if (res.status !== 0) {
    let outcome: Outcome | null = null;
    try {
      outcome = JSON.parse(readFileSync(resultFile, "utf8")) as Outcome;
    } catch {
      outcome = null;
    }
    try { unlinkSync(resultFile); } catch { /* ignore */ }
    throw new Error(
      `isolated fault runner exited with status ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}` +
      (outcome ? `\noutcome: ${JSON.stringify(outcome)}` : ""),
    );
  }
  let outcome: Outcome;
  try {
    outcome = JSON.parse(readFileSync(resultFile, "utf8")) as Outcome;
  } catch (error) {
    try { unlinkSync(resultFile); } catch { /* ignore */ }
    throw new Error(`isolated fault runner wrote no result file: ${String(error)}`);
  }
  try { unlinkSync(resultFile); } catch { /* ignore */ }
  return outcome;
}

describe("runFsDownload temp-file cleanup", () => {
  test("a normal download leaves no temp file in the destination directory", () => {
    const o = runFault({});
    expect(o.code).toBe(0);
    expect(o.verified).toBe(true);
    expect(o.rmTempCalls).toBe(2);
    expect(o.temps).toEqual([]);
    expect(o.listing).toEqual(["out.bin"]);
    expect(o.destContent).toBe("hello");
    expect(o.lastMethod).toBe("fsDownloadCancel");
  });

  test("a transient EIO on the success-path rm is retried by the finally block and leaves no temp", () => {
    const o = runFault({ rmEioNext: 1 });
    expect(o.code).toBe(0);
    expect(o.verified).toBe(true);
    expect(o.rmTempCalls).toBe(2);
    expect(o.temps).toEqual([]);
    expect(o.listing).toEqual(["out.bin"]);
    expect(o.destContent).toBe("hello");
    expect(o.lastMethod).toBe("fsDownloadCancel");
  });
});
