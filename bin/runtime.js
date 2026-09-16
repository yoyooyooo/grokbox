export const MINIMUM_NODE_MAJOR = 20;
export const RUNTIME_UNSUPPORTED_EXIT_CODE = 59;

export function nodeMajor(version) {
  const major = Number.parseInt(String(version).split(".", 1)[0] ?? "", 10);
  return Number.isSafeInteger(major) ? major : null;
}

export function supportsNodeRuntime(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major > MINIMUM_NODE_MAJOR || (major === MINIMUM_NODE_MAJOR && minor >= 17);
}

export function runtimeUnsupportedEnvelope(version) {
  return {
    ok: false,
    error: {
      code: "runtime_unsupported",
      message: "grokbox requires Node.js 20.17.0 or newer.",
      retryable: false,
      runtime: {
        nodeMajor: nodeMajor(version),
        minimumNodeMajor: MINIMUM_NODE_MAJOR,
      },
    },
  };
}
