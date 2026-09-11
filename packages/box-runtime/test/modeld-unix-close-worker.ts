import { existsSync, linkSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { acquireUnixListener, emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";

const dir = process.argv[2];
const outPath = process.argv[3];
if (!dir || !outPath) process.exit(2);

const path = join(dir, "modeld.sock");
const moved = join(dir, "moved.sock");
const keep = join(dir, "keep.sock");
const counts = emptyResourceCounts();
const ready = await Effect.runPromise(Deferred.make<void>());
const fiber = Effect.runFork(Effect.scoped(
  Effect.gen(function* () {
    yield* acquireUnixListener(path, counts);
    yield* Deferred.succeed(ready, undefined);
    yield* Effect.never;
  }),
));

await Effect.runPromise(Deferred.await(ready));
linkSync(path, keep);
renameSync(path, moved);
const competitor = createServer();
await new Promise<void>((resolve, reject) => {
  competitor.once("error", reject);
  competitor.listen({ path, exclusive: true }, resolve);
});
const inode = lstatSync(path).ino;
await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
writeFileSync(outPath, `${JSON.stringify({
  node: process.version,
  competitorInode: inode,
  pathExists: existsSync(path),
  backupExists: existsSync(keep),
  competitorListening: competitor.listening,
  sameInode: existsSync(path) && lstatSync(path).ino === inode,
  counts,
})}\n`);
await new Promise<void>((resolve) => competitor.close(() => resolve()));
