import type { MonitorSqlite } from "./monitor-sqlite.node.ts";

/** Sequence holes are intervals, not a permanent counter of out-of-order arrival.
 * A late event closes/splits its hole. Retained conflicting sequence identities
 * remain an integrity fault, distinct from a temporary observation gap. */
export async function recordSourceSequence(db: MonitorSqlite, source: string, sequence: number, at: number): Promise<void> {
  const previous = await db.first("SELECT last_sequence FROM source_health WHERE source_key=?", [source]);
  const last = previous?.last_sequence === null || previous?.last_sequence === undefined ? -1 : Number(previous.last_sequence);
  if (sequence > last + 1) {
    await db.run("INSERT OR IGNORE INTO source_gaps(source_key,start_seq,end_seq) VALUES(?,?,?)", [source, last + 1, sequence - 1]);
  }
  const hole = await db.first("SELECT start_seq,end_seq FROM source_gaps WHERE source_key=? AND start_seq<=? AND end_seq>=?", [source, sequence, sequence]);
  if (hole) {
    const start = Number(hole.start_seq), end = Number(hole.end_seq);
    await db.run("DELETE FROM source_gaps WHERE source_key=? AND start_seq=?", [source, start]);
    if (start < sequence) await db.run("INSERT INTO source_gaps(source_key,start_seq,end_seq) VALUES(?,?,?)", [source, start, sequence - 1]);
    if (end > sequence) await db.run("INSERT INTO source_gaps(source_key,start_seq,end_seq) VALUES(?,?,?)", [source, sequence + 1, end]);
  }
  const gaps = Number((await db.first("SELECT COALESCE(SUM(end_seq-start_seq+1),0) AS n FROM source_gaps WHERE source_key=?", [source]))?.n ?? 0);
  await db.run("INSERT INTO source_health(source_key,last_sequence,last_event_at,gaps,conflicts) VALUES(?,?,?,?,0) ON CONFLICT(source_key) DO UPDATE SET last_sequence=MAX(COALESCE(source_health.last_sequence,-1),excluded.last_sequence),last_event_at=MAX(source_health.last_event_at,excluded.last_event_at),gaps=excluded.gaps", [source, sequence, at, gaps]);
}
