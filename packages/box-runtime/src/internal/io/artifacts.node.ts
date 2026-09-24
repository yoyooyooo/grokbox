import { randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Publish one protected, complete JSON artifact. Failed staging is left for operator cleanup. */
export async function writeRuntimeArtifact(path: string, value: unknown, beforePublish?: () => void): Promise<void> {
  const bytes = `${JSON.stringify(value)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = join(dirname(path), `.runtime-${randomUUID()}.tmp`);
  const file = await open(staging, "wx+", 0o600);
  try {
    await file.writeFile(bytes, "utf8");
    const readBack = Buffer.alloc(Buffer.byteLength(bytes));
    const read = await file.read(readBack, 0, readBack.length, 0);
    if (read.bytesRead !== readBack.length || !readBack.equals(Buffer.from(bytes))) {
      throw new Error("runtime-artifact-readback-failed");
    }
    await file.sync();
  } finally {
    await file.close();
  }
  beforePublish?.();
  await rename(staging, path);
}
