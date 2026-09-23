export const HOST_WINDOW_LIMITS: Readonly<{ slots: number; sourceBytes: number; profileBytes: number; manifestBytes: number }>;
export type HostWindowPaths = { source: string; worker: string; profile: string | null };
export type HostWindowFile = { name: string; sha256: string; bytes: number };
export type HostWindowManifest = { version: 1; windowId: string; origin: HostWindowPaths;
  files: { source: HostWindowFile; worker: HostWindowFile; profile: HostWindowFile | null };
  sourceSet: string; bindings: Record<string, string>; key: string };
export type HostWindowFreshness = { state: "changed" | "unchanged"; observed: { source: string; worker: string; profile: string | null };
  changedComponents: string[]; sampledAt: string; qualified: false } | { state: "unavailable"; code: string; qualified: false };
export type HostWindowReceipt = { key: string; sourceSet: string; sourceSha: string; workerSha: string; profileDigest: string | null;
  bindings: Record<string, string>; origin: { source: string; worker: string }; scope: "private-fixed-source-not-installed-or-loaded"; qualified: false };
export function publicHostSourceWindow(manifest: HostWindowManifest): HostWindowReceipt;
export function captureHostSourceWindow(paths: HostWindowPaths, bindings: Record<string, string>, options?: { signal?: AbortSignal; parent?: string }): Promise<{
  directory: string; paths: HostWindowPaths; env: Record<string, string>; manifest: HostWindowManifest; receipt: HostWindowReceipt;
  current: () => Promise<boolean>; freshness: () => Promise<HostWindowFreshness>; dispose: () => Promise<void> }>;
export function readHostSourceWindow(env: NodeJS.ProcessEnv, role?: "source" | "worker" | "profile"): { manifest: HostWindowManifest; bytes: Buffer | null; paths: HostWindowPaths };
export function probeHostSourceWindow(manifest: HostWindowManifest, signal?: AbortSignal): Promise<HostWindowFreshness>;
