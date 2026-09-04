export const MINIMUM_NODE_MAJOR = 20;
export const RUNTIME_UNSUPPORTED_EXIT_CODE = 59;

export function nodeMajor(version) {
  const major = Number.parseInt(String(version).split(".", 1)[0] ?? "", 10);
  return Number.isSafeInteger(major) ? major : null;
}

export function supportsNodeRuntime(version) {
  const major = nodeMajor(version);
  return major !== null && major >= MINIMUM_NODE_MAJOR;
}

export function runtimeUnsupportedEnvelope(version) {
  return {
    ok: false,
    error: {
      code: "runtime_unsupported",
      message: `grokbox requires Node.js ${MINIMUM_NODE_MAJOR} or newer.`,
      retryable: false,
      runtime: {
        nodeMajor: nodeMajor(version),
        minimumNodeMajor: MINIMUM_NODE_MAJOR,
      },
    },
  };
}
