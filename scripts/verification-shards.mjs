import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Expand declared directories once; use exact paths rather than Bun substring
 * selectors. Missing, duplicate or non-regular inputs are never an empty pass. */
export function expandTests(root, inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw Error("empty-test-inventory");
  const base = resolve(root), files = [], seen = new Set();
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() || /\.test\.[cm]?[jt]s$/.test(entry.name)) visit(join(path, entry.name));
      }
    } else {
      const file = relative(base, path).replaceAll("\\", "/");
      if (!stat.isFile() || !/\.test\.[cm]?[jt]s$/.test(file)) throw Error("invalid-test-file");
      if (seen.has(file)) throw Error("duplicate-test-file:" + file);
      seen.add(file); files.push(file);
      if (files.length > 2000) throw Error("test-inventory-limit");
    }
  }
  for (const input of inputs) {
    if (typeof input !== "string" || isAbsolute(input) || input.split(/[\\/]/).includes("..")) throw Error("invalid-test-path");
    const path = resolve(base, input), before = files.length;
    if (!path.startsWith(base + sep)) throw Error("invalid-test-path");
    visit(path);
    if (files.length === before) throw Error("empty-test-directory");
  }
  return files;
}

export function assertPartition(files, shards) {
  if (!files.length || new Set(files).size !== files.length || !shards.length) throw Error("invalid-test-partition");
  const ids = new Set(), seen = new Set(), required = new Set(files);
  for (const shard of shards) {
    if (!shard.id || ids.has(shard.id) || !shard.files?.length) throw Error("invalid-test-shard");
    ids.add(shard.id);
    for (const file of shard.files) {
      if (!required.has(file) || seen.has(file)) throw Error("test-partition-overlap-or-extra");
      seen.add(file);
    }
  }
  if (seen.size !== required.size) throw Error("test-partition-omission");
  return shards;
}

export function partitionTests(files, classify, maxFiles = 20) {
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 64) throw Error("invalid-shard-bound");
  const buckets = new Map(), shards = [];
  for (const file of files) {
    const owner = classify(file);
    if (typeof owner !== "string" || !/^[a-z][a-z0-9-]*$/.test(owner)) throw Error("invalid-test-owner");
    const bucket = buckets.get(owner) ?? []; bucket.push(file); buckets.set(owner, bucket);
  }
  for (const [owner, paths] of buckets) for (let n = 0; n < paths.length; n += maxFiles)
    shards.push({ id: `${owner}-${n / maxFiles + 1}`, files: paths.slice(n, n + maxFiles) });
  return assertPartition(files, shards);
}
