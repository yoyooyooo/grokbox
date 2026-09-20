import { Effect } from "effect";
import { botIdForQuery, botIdFromRef, botRef, normalizeBotQuery, type BotList, type BotResolution, type BotView } from "@grokbox/client/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import type { NativeBotSnapshot, NativeBotSummary } from "@grokbox/box-runtime/runtime";
import type { ApplicationOptions } from "./application.ts";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";
import { boundedPage, pageInput } from "./pagination.ts";

const checked = <A>(run: () => A) => Effect.try({ try: run, catch: error => error });
function project(installationId: string, snapshot: NativeBotSnapshot, row: NativeBotSummary): BotView {
  return { botRef: botRef(installationId, row.id), id: row.id, name: row.name, title: row.title, description: row.description,
    nativeHarness: row.nativeHarness, hidden: row.hidden, running: row.running, runningTurn: row.runningTurn,
    updatedAt: row.updatedAt, textTruncated: row.textTruncated, truncatedFields: [...row.truncatedFields], source: snapshot.source, coverage: snapshot.coverage };
}
function queryInput(url: URL): string {
  if ([...url.searchParams.keys()].some(key => key !== "query") || url.searchParams.getAll("query").length !== 1) {
    throw new HttpFailure(400, "invalid_input", "Resolution requires one query.");
  }
  return normalizeBotQuery(url.searchParams.get("query"));
}

export function botQuery(options: ApplicationOptions, principal: Principal, url: URL) {
  return Effect.gen(function* () {
    yield* checked(() => requireCapability(principal, "bots.read"));
    const listing = url.pathname === "/v1/bots", resolving = url.pathname === "/v1/bots/resolve";
    const page = listing ? yield* checked(() => pageInput(url)) : undefined;
    const query = resolving ? yield* checked(() => queryInput(url)) : undefined;
    if (query?.toLowerCase() === "self") return yield* Effect.fail(new HttpFailure(403, "caller_identity_unavailable", "This authenticated caller has no trusted native Bot binding."));
    const id = yield* checked(() => {
      if (listing) return undefined;
      if (query !== undefined) return botIdForQuery(query, options.installationId);
      if (url.search) throw new HttpFailure(400, "invalid_input", "Bot detail does not accept query parameters.");
      let value: string;
      try { value = decodeURIComponent(url.pathname.slice("/v1/bots/".length)); }
      catch { throw new HttpFailure(400, "invalid_input", "Invalid Bot reference."); }
      return botIdFromRef(value, options.installationId);
    });
    const snapshot = yield* Effect.tryPromise({ try: signal => options.native.listBots(signal), catch: error => error });
    const records = [...snapshot.bots].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (listing) {
      // Membership is stable across pages; volatile fields are fresh per read.
      const revision = sha256Text(canonicalJson({ generation: snapshot.source.generation, ids: records.map(row => row.id) }));
      const result = yield* checked(() => boundedPage(records, page!, options.installationId, revision, row => project(options.installationId, snapshot, row)));
      return { bots: result.items, total: result.total, nextCursor: result.nextCursor, pageBound: result.pageBound,
        membershipRevision: revision, source: snapshot.source, coverage: snapshot.coverage, consistency: "stable-membership-fresh-fields" } satisfies BotList;
    }
    if (id !== undefined) {
      const row = records.find(row => row.id === id);
      if (!row) return yield* Effect.fail(new HttpFailure(404, "not_found", "The Bot was not present in the native snapshot."));
      const bot = project(options.installationId, snapshot, row);
      return resolving ? { bot, matchedBy: "id" } satisfies BotResolution : bot;
    }
    const wanted = query!.toLowerCase();
    const matches = records.filter(row => ["name", "title"].some(field => {
      const value = row[field as "name" | "title"];
      return value !== null && !row.truncatedFields.includes(field as "name" | "title") && value.trim().toLowerCase() === wanted;
    }));
    const uncertain = records.filter(row => row.truncatedFields.some(field => field !== "description" && row[field] !== null && wanted.startsWith(row[field]!.trim().toLowerCase())));
    if (matches.length > 1 || uncertain.length) {
      const candidates = [...new Map([...matches, ...uncertain].map(row => [row.id, row])).values()];
      return yield* Effect.fail(new HttpFailure(409, uncertain.length ? "source_incomplete" : "ambiguous_target",
        uncertain.length ? "Truncated native identity text prevents exact resolution; use a stable reference." : "More than one Bot matches; select a returned stable reference.", {
          candidates: candidates.slice(0, 20).map(row => ({ botRef: botRef(options.installationId, row.id), id: row.id, name: row.name, title: row.title })),
          totalCandidates: candidates.length, candidatesTruncated: candidates.length > 20,
        }));
    }
    const row = matches[0];
    if (!row) return yield* Effect.fail(new HttpFailure(404, "not_found", "No Bot matched the exact name or title."));
    return { bot: project(options.installationId, snapshot, row), matchedBy: row.name.trim().toLowerCase() === wanted ? "name" : "title" } satisfies BotResolution;
  });
}
