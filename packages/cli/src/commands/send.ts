import type { CliDeps } from "../deps.ts";
import { usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts, readPrompt } from "../opts.ts";
import { assertUuidV4 } from "../util.ts";
import { managementClient } from "../management-client.ts";

export async function runSend(
  deps: CliDeps,
  target: string,
  raw: { json?: boolean; timeoutMs?: string; text?: string; nonce?: string; expectKind?: string },
): Promise<void> {
  if (raw.expectKind === "group") throw usage("The unified message entry accepts a Bot target only.");
  if (raw.expectKind !== undefined && raw.expectKind !== "agent") throw usage("--expect-kind must be agent.");
  const io = ioFromOpts(raw);
  const prompt = await readPrompt(raw.text, deps);
  const clientNonce = raw.nonce === undefined ? deps.randomUUID() : assertUuidV4(raw.nonce, "--nonce");
  const { client } = await managementClient(deps, { timeoutMs: String(io.timeoutMs) });
  const targetView = await client.resolveBot(target);
  const botRef = targetView.data.bot.botRef;
  const reply = await client.sendMessage({
    requestId: deps.randomUUID(),
    botRef,
    text: prompt,
    clientNonce,
  });
  writeSuccess(deps.stdout, reply.data);
}
