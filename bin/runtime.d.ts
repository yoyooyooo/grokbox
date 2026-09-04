export const MINIMUM_NODE_MAJOR: number;
export const RUNTIME_UNSUPPORTED_EXIT_CODE: number;
export function nodeMajor(version: unknown): number | null;
export function supportsNodeRuntime(version: unknown): boolean;
export function runtimeUnsupportedEnvelope(version: unknown): {
  ok: false;
  error: {
    code: "runtime_unsupported";
    message: string;
    retryable: false;
    runtime: { nodeMajor: number | null; minimumNodeMajor: number };
  };
};
