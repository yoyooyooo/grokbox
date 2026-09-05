import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { GatewayClient, gatewayMeta } from "../gateway.ts";
import { writeSuccess } from "../output.ts";
import { ioFromOpts, readPrompt } from "../opts.ts";
import { agentKind, type AgentKind } from "../redaction.ts";
import { assertUuidV4, isRecord } from "../util.ts";
import { findRosterRow } from "./roster.ts";

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
  const io = ioFromOpts(raw);
  let expectedKinds: readonly AgentKind[] | undefined;
  if (raw.expectKind !== undefined) {
    if (raw.expectKind !== "agent" && raw.expectKind !== "group") {
      throw usage("--expect-kind must be agent or group.");
    }
    expectedKinds = [raw.expectKind];
  }
  const prompt = await readPrompt(raw.text, deps);
  const clientNonce = raw.nonce === undefined ? deps.randomUUID() : assertUuidV4(raw.nonce, "--nonce");
  const client = new GatewayClient(deps);
  const { agents } = await client.listAgents(io.timeoutMs);
  const row = findRosterRow(agents, target, expectedKinds);
  const actualKind = agentKind(row);
  try {
    const { result, discovery } = await client.sendPrompt(
      { agentId: String(row.id), prompt, clientNonce },
      io.timeoutMs,
    );
    const accepted = !isRecord(result) || result.accepted !== false;
    if (!accepted) throw new CliError("gateway_internal", "Gateway did not accept the send.");
    writeSuccess(
      deps.stdout,
      {
        status: "accepted",
        accepted: true,
        target: { id: String(row.id), kind: actualKind },
        clientNonce,
      },
      gatewayMeta(discovery),
    );
  } catch (error) {
    if (error instanceof CliError && error.code === "send_delivery_unknown") {
      throw new CliError("send_delivery_unknown", error.message, {
        context: { clientNonce, target: { id: String(row.id), kind: actualKind } },
      });
    }
    throw error;
  }
}
