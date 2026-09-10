import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  asHostPromptSession,
  createStreamingPromptSession,
  type StreamPart,
} from "./packed-host-session.ts";
import {
  LOOKUP_TOOL,
  readHostRoot,
  sha256Json,
  UI_DECOY,
  withFakeHttpSession,
} from "./context-continuity-fixture.ts";

const scenario = process.argv[2];
const storePath = process.argv[3];
const resultPath = process.argv[4];

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!scenario || !storePath || !resultPath) fail("usage: worker <scenario> <store> <result>");

const FINISH: StreamPart = { type: "finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };

async function reopenState() {
  const root = await readHostRoot(storePath);
  const session = asHostPromptSession(createStreamingPromptSession({
    modelId: "stub/echo",
    vision: false,
    parallel: "allow",
    produce: async function* () {
      yield { type: "text-delta", textDelta: "ok" };
      yield FINISH;
    },
  }), "stub/echo");
  const state = session.getExecutor(root.state).getState();
  const blob = JSON.stringify(state);
  await writeFile(resultPath, `${JSON.stringify({
    ok: true,
    pid: process.pid,
    sha256: sha256Json(state),
    diskSha: root.refs.sha256,
    state,
    decoyPresent: blob.includes(UI_DECOY),
  })}\n`);
}

async function compactNextTurn() {
  const root = await readHostRoot(storePath);
  await withFakeHttpSession({
    turnId: "HOST_TURN_E04_RELOAD",
    fn: async ({ session, requests }) => {
      const executor = session.getExecutor(root.state);
      const state = executor.getState();
      await executor.stream({}, "step-e04-reload", [LOOKUP_TOOL]).response;
      const blob = JSON.stringify(state);
      await writeFile(resultPath, `${JSON.stringify({
        ok: true,
        pid: process.pid,
        sha256: sha256Json(state),
        diskSha: root.refs.sha256,
        state,
        httpCount: requests.length,
        httpText: requests[0]?.text ?? "",
        decoyPresent: blob.includes(UI_DECOY) || (requests[0]?.text ?? "").includes(UI_DECOY),
        cwdStore: join(dirname(storePath), "ui.jsonl"),
      })}\n`);
    },
  });
}

if (scenario === "reopen-state") await reopenState();
else if (scenario === "compact-next-turn") await compactNextTurn();
else fail(`unknown scenario ${scenario}`);
