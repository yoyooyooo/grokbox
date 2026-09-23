export class StableSourceFailure extends Error { readonly code: string; constructor(code: string); }
export function sourceDigest(bytes: string | Uint8Array): string;
export type StableSourceEntry = { path: string; maxBytes: number; optional?: boolean };
export type StableSourceSet = { files: { path: string; bytes: Buffer | null; sha256: string | null }[]; current: () => Promise<boolean> };
export function readStableSourceSet(entries: StableSourceEntry[], signal?: AbortSignal, afterRead?: (index: number) => Promise<void>): Promise<StableSourceSet>;
