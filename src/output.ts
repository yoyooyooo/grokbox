import type { CliError, ErrorBody } from "./errors.ts";

export type Writable = {
  write(chunk: string): void;
};

export type SuccessEnvelope = {
  ok: true;
  data: unknown;
  meta?: { gateway: { pid: number; startedAt: number } };
};

export function writeJsonLine(out: Writable, value: unknown): void {
  out.write(`${JSON.stringify(value)}\n`);
}

export function writeSuccess(
  out: Writable,
  data: unknown,
  gateway?: { pid: number; startedAt: number },
): void {
  const envelope: SuccessEnvelope = { ok: true, data };
  if (gateway) envelope.meta = { gateway };
  writeJsonLine(out, envelope);
}

export function writeFailure(out: Writable, error: CliError | ErrorBody): void {
  const body = "toErrorBody" in error ? error.toErrorBody() : error;
  writeJsonLine(out, { ok: false, error: body });
}

export function formatTable(rows: Array<Record<string, string>>): string {
  if (rows.length === 0) return "";
  const first = rows[0];
  if (!first) return "";
  const cols = Object.keys(first);
  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((row) => (row[col] ?? "").length)),
  );
  const pad = (value: string, i: number): string => value.padEnd(widths[i] ?? value.length);
  const header = cols.map(pad).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((row) => cols.map((col, i) => pad(row[col] ?? "", i)).join("  ")).join("\n");
  return `${header}\n${sep}\n${body}\n`;
}

export function flattenRows(record: Record<string, unknown>, prefix = ""): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      rows.push(...flattenRows(value as Record<string, unknown>, path));
    } else {
      rows.push({ field: path, value: value === null || value === undefined ? "" : String(value) });
    }
  }
  return rows;
}
