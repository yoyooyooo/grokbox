import { RESPONSE_MAX_BYTES, type PageBound } from "@grokbox/client/contract";
import { HttpFailure } from "./access.ts";

export type PageInput = { limit: number; cursor: string | null };
export function pageInput(url: URL): PageInput {
  for (const key of url.searchParams.keys()) {
    if (!["limit", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpFailure(400, "invalid_input", "Invalid page parameters.");
  }
  const raw = url.searchParams.get("limit"), limit = raw === null ? 50 : Number(raw);
  if (raw !== null && !/^[1-9][0-9]{0,2}$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpFailure(400, "invalid_input", "Page size must be between 1 and 100.");
  }
  return { limit, cursor: url.searchParams.get("cursor") };
}

/** The reserved bytes cover the fixed envelope, source metadata and next cursor.
 * A byte-limited page keeps a continuation; it never truncates an object. */
export function boundedPage<A, B>(records: readonly A[], page: PageInput, installationId: string, revision: string, project: (record: A) => B) {
  let offset = 0;
  if (page.cursor !== null) {
    const match = /^([a-f0-9-]{36})\.([a-f0-9]{64})\.([0-9]{1,6})$/.exec(page.cursor);
    if (!match) throw new HttpFailure(400, "invalid_input", "Invalid page cursor.");
    if (match[1] !== installationId || match[2] !== revision) throw new HttpFailure(409, "cursor_gap", "The query scope changed; obtain a new first page.");
    offset = Number(match[3]);
  }
  if (offset > records.length) throw new HttpFailure(400, "invalid_input", "Invalid page offset.");
  const items: B[] = [];
  let bytes = 0, end = offset, pageBound: PageBound = null;
  while (end < records.length && items.length < page.limit) {
    const item = project(records[end]!);
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > RESPONSE_MAX_BYTES - 2048) {
      if (!items.length) throw new HttpFailure(503, "source_invalid", "A source object exceeds the bounded projection.");
      pageBound = "bytes"; break;
    }
    items.push(item); bytes += size; end++;
  }
  if (end < records.length && pageBound === null) pageBound = "count";
  return { items, total: records.length, nextCursor: end < records.length ? `${installationId}.${revision}.${end}` : null, pageBound };
}
