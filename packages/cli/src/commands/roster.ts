import { CliError, usage } from "../errors.ts";
import { agentKind, type AgentKind } from "../redaction.ts";
import { asString, isRecord } from "../util.ts";

function kindLabel(kinds: readonly AgentKind[] | undefined): string {
  if (kinds?.length === 1 && kinds[0] === "agent") return "Bot";
  if (kinds?.length === 1 && kinds[0] === "group") return "group";
  return "roster row";
}

function listHint(kinds: readonly AgentKind[] | undefined): string {
  if (kinds?.length === 1 && kinds[0] === "group") return "grokbox groups list";
  return "grokbox agents list";
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function assertKind(row: Record<string, unknown>, kinds: readonly AgentKind[] | undefined, query: string): void {
  if (!kinds || kinds.includes(agentKind(row))) return;
  const actual = agentKind(row);
  throw new CliError(
    "target_kind_mismatch",
    `${quote(query)} is a ${actual}, not a ${kindLabel(kinds)}. Use ${actual === "group" ? "grokbox groups" : "grokbox agents"} with an exact ID.`,
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
  const queryLower = query.toLocaleLowerCase();

  const exactId = rows.find((row) => asString(row.id).toLocaleLowerCase() === queryLower);
  if (exactId) {
    assertKind(exactId, kinds, query);
    return exactId;
  }

  const named = rows.filter((row) => asString(row.name).toLocaleLowerCase() === queryLower);
  const titled = named.length > 0
    ? []
    : rows.filter((row) => {
        const title = asString(row.title).toLocaleLowerCase();
        return title.length > 0 && title === queryLower;
      });
  const pool = named.length > 0 ? named : titled;
  const matchingKind = kinds ? pool.filter((row) => kinds.includes(agentKind(row))) : pool;

  if (matchingKind.length > 1) {
    const sample = matchingKind.slice(0, 8).map((row) => `${asString(row.id)}  ${asString(row.name)}`).join("\n  ");
    throw new CliError(
      "target_ambiguous",
      `${quote(query)} matched ${matchingKind.length} ${kindLabel(kinds)}s. Use an exact ID:\n  ${sample}`,
    );
  }
  const row = matchingKind[0];
  if (row) return row;
  if (pool.length > 0) {
    assertKind(pool[0]!, kinds, query);
  }
  throw new CliError(
    "target_not_found",
    `No ${kindLabel(kinds)} matched ${quote(query)}. Use an exact ID or a name that matches exactly one ${kindLabel(kinds)}. List with ${listHint(kinds)} (add --include-hidden if it may be hidden).`,
  );
}
