import { CliError, usage } from "../errors.ts";
import { agentKind, type AgentKind } from "../redaction.ts";
import { asString, isRecord } from "../util.ts";

function assertKind(row: Record<string, unknown>, kinds: readonly AgentKind[] | undefined): void {
  if (!kinds || kinds.includes(agentKind(row))) return;
  throw new CliError(
    "target_kind_mismatch",
    kinds.length === 1
      ? `Target is not a ${kinds[0]}.`
      : "Target kind does not match the command.",
  );
}

export function findRosterRow(
  agents: unknown[],
  target: string,
  kinds?: readonly AgentKind[],
): Record<string, unknown> {
  const query = target.trim();
  if (query.length === 0) throw usage("Target is required.");
  const rows = agents.filter(isRecord);

  const exactId = rows.find((row) => asString(row.id) === query);
  if (exactId) {
    assertKind(exactId, kinds);
    return exactId;
  }

  const normalized = query.toLocaleLowerCase();
  const named = rows.filter((row) => {
    const name = asString(row.name).toLocaleLowerCase();
    const title = asString(row.title).toLocaleLowerCase();
    return name === normalized || (title.length > 0 && title === normalized);
  });
  const matchingKind = kinds ? named.filter((row) => kinds.includes(agentKind(row))) : named;

  if (matchingKind.length > 1) {
    throw new CliError("target_ambiguous", "Target name/title matched more than one roster row.");
  }
  const row = matchingKind[0];
  if (row) return row;
  if (named.length > 0) {
    throw new CliError("target_kind_mismatch", "Target kind does not match the command.");
  }
  throw new CliError("target_not_found", "No roster row matched that ID, name, or title.");
}
