import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { managementClient } from "../management-client.ts";
import { readPrompt } from "../opts.ts";
import { assertUuidV4 } from "../util.ts";

export async function runSend(
  deps: CliDeps,
  target: string,
  raw: {
    json?: boolean;
    timeoutMs?: string;
    text?: string;
    nonce?: string;
    expectKind?: string;
  },
): Promise<void> {
  if (raw.expectKind === "group") throw usage("The management message interface targets one Bot; group publication is a separate D1-I association.");
  if (raw.expectKind !== undefined && raw.expectKind !== "agent") throw usage("--expect-kind must be agent or group.");
  const prompt = await readPrompt(raw.text, deps);
  const clientNonce = raw.nonce === undefined ? deps.randomUUID() : assertUuidV4(raw.nonce, "--nonce");
  const { client } = await managementClient(deps, { timeoutMs: raw.timeoutMs });
  const resolved = await client.resolveBot(target, deps.signal);
  const requestId = deps.randomUUID();
  const result = await client.sendMessage({ requestId, botRef: resolved.data.bot.botRef, text: prompt, clientNonce }, deps.signal);
  writeSuccess(deps.stdout, {
    status: result.data.state,
    accepted: result.data.state === "accepted",
    target: { id: resolved.data.bot.id, kind: "agent" },
    requestId,
    operationRef: result.data.operationRef,
    submissionRef: result.data.submissionRef,
    clientNonce,
  });
}
