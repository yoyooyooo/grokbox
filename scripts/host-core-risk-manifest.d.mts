export type HostCoreRiskFamily = Readonly<{
  id: string;
  slices: readonly string[];
  concerns: readonly string[];
  evidence: readonly string[];
}>;

export const HOST_CORE_RISK_FAMILIES: readonly HostCoreRiskFamily[];
export const HOST_CORE_RISK_COMMON_EVIDENCE: readonly string[];
export const HOST_CORE_RISK_TESTS: readonly string[];
