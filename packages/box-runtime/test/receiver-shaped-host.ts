/** Synthetic recipe scaffold, not a native model selector. Only the two hook
 * anchors match the supported ABI; behavioral qualification is a separate test. */
export const RECEIVER_SHAPED_HOST = `
(function syntheticReceiverBoundary() {
function createHostInference(options2) {
  const { auth: auth2, experiments, settings } = options2;
  return { fixture: Boolean(auth2 && experiments && settings) };
}
// src/host/extensions/inference/transcribe-service.ts
init_scheduling();
function init_scheduling() {}
})();
`;
