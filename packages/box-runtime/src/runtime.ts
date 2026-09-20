export { BoxRuntimeError, runtimeNotReady, type BoxRuntimeErrorCode } from "@grokbox/runtime-kernel/contract";
export {
  applyReset,
  applyUse,
  assertRouteAssignment,
  assertStubOnlyRouteAssignments,
  disclosure,
  parseModelId,
  type DesiredMode,
  type ModelsFile,
} from "@grokbox/runtime-kernel/selection";

export { assertBoxLocal, type LocalRuntimeContext } from "./internal/io/local.ts";
export {
  reviewedProfilePath,
  hostBundlesDir,
  retainedGenerationDir,
  retainedGenerationSourcePath,
} from "./internal/io/paths.ts";
export { openRuntimeStore, type RuntimeStore } from "./internal/io/configuration.node.ts";
export { readStorageConfiguration } from "./internal/io/storage-configuration.node.ts";
export { runRuntimeServiceCommand, RuntimeServiceError, type RuntimeServiceRequest } from "./internal/roots/runtime-services.runtime.ts";
export { acquireDaemonSocket, type DaemonSocketLease } from "./internal/io/daemon-socket.node.ts";
export { configureMonitorService, readMonitorServiceConfiguration, type MonitorServiceConfiguration } from "./internal/io/monitor-installation.node.ts";
export { startMonitorService, type MonitorServiceStatus } from "./internal/roots/monitor-service.runtime.ts";
export { runAgentRoutineCommand, type AgentRoutineAdapter } from "./internal/roots/agent-routines.runtime.ts";
export { runOpsNotificationDelivery, observeOpsNotification, type PairedNotificationDriver } from "./internal/roots/ops-notification.runtime.ts";
export { activateOpsNotifications } from "./internal/roots/ops-activation.runtime.ts";
export { openOpsBindings } from "./internal/io/ops-bindings.node.ts";
export { createPreparedNoticeDriver } from "./internal/roots/ops-explicit-delivery.runtime.ts";
export { openMaterialStore } from "./internal/io/material-store.node.ts";
export { bindMaterialSource, readMaterialSource, replaceMaterialSource, scanMaterialSource, type MaterialWriteHooks } from "./internal/io/material-source.node.ts";
export { currentMaterialSources, materialViews, startMaterialIndexer, type MaterialDomain } from "./internal/roots/materials.runtime.ts";
export { startOpsNotificationWorker, type AutomaticNoticeWorkerStatus } from "./internal/roots/ops-automatic-notification.runtime.ts";
export { openRoutineProvisionStore } from "./internal/io/routine-provision.node.ts";
export { changeManagedRoutine } from "./internal/roots/routine-management.runtime.ts";
export { createRoutineGateway, type RoutineAccess } from "./internal/io/routine-gateway.node.ts";
export { createNotificationReceiver, type ReceiverReadPorts } from "./internal/io/notification-receiver.node.ts";
export { runExplicitOpsNotification, type ExplicitReceiverRead, type ExplicitReceiverReader } from "./internal/roots/ops-explicit-delivery.runtime.ts";
export { verifyOpsReceiver, prepareOpsReceiverBlueprint, type ReceiverNativeRead, type ReceiverNativeReader } from "./internal/roots/ops-receiver.runtime.ts";
export { runOpsPairing, observeOpsTargets, revokeOpsTarget, type NativePairingSource } from "./internal/roots/ops-pairing.runtime.ts";
export { runRoutineProvisionCommand, type RoutineProvisionNative } from "./internal/roots/routine-provision.runtime.ts";
export { observeRuntimeStorage } from "./internal/roots/storage-maintenance.runtime.ts";
export { openContinuityObservationBridge, runContinuityReferenceChange, type ContinuityObservationBatch } from "./internal/roots/continuity-integration.runtime.ts";
export { openContinuityRecoveryStore } from "./internal/roots/continuity.runtime.ts";
export { openBotLifecycle, type BotLifecyclePort } from "./internal/roots/bot-lifecycle.runtime.ts";
export { openBotHandover, type BotHandoverPort, type HandoverEffect } from "./internal/roots/bot-handover.runtime.ts";
export { openContinuityControls } from "./internal/roots/continuity-control.runtime.ts";
export { openBotConvergence, type BotConvergencePort } from "./internal/roots/bot-convergence.runtime.ts";
export { openBotProtection, startBotProtectionWorker, startPolicyBoundBotProtection, type BotProtectionPort } from "./internal/roots/bot-protection.runtime.ts";
export { startHostHealth, type HostHealthStatus, type HostHealthTestPorts } from "./internal/roots/host-health.runtime.ts";
export { readHostHealthJournal } from "./internal/io/provenance.node.ts";
export { createContinuityGateway, createManagementGateway } from "./internal/roots/management-gateway.runtime.ts";
export type { ContinuityGateway, NativeContinuityContext } from "./internal/io/continuity-gateway.node.ts";
export { nativeMaterialReader, botProfileRevision } from "./internal/io/continuity-material.node.ts";
export { createNativeBotLifecycle } from "./internal/roots/continuity-native-lifecycle.runtime.ts";
export { createNativeBotHandover } from "./internal/roots/continuity-native-handover.runtime.ts";
export { createNativeBotConvergence } from "./internal/roots/continuity-native-convergence.runtime.ts";
export { createNativeBotProtection, protectiveOwnership } from "./internal/roots/continuity-native-protection.runtime.ts";
export { startProtectionService, type ProtectionServiceStatus, type ProtectionServiceInput, type ProtectionServiceTestPorts } from "./internal/roots/protection-service.runtime.ts";
export { readContinuityIdentity } from "./internal/io/continuity-database.node.ts";
export { contextManagementPrograms, contextControlId, managedContextRecord, contextStorePresent, type ManagedContextDeclaration, type ManagedContextRecord, type ManagedContextRow } from "./internal/io/context-management.node.ts";
export { createNativeContextControl, managedContextPrograms, withManagedContextGate, type ContextNative } from "./internal/roots/managed-context.runtime.ts";
export { readManagedLifecycle, listManagedLifecycles, withManagedLifecycleGate } from "./internal/roots/managed-lifecycle.runtime.ts";
export { readProtectionSubjects, readProtectionSnapshots, readProtectionHandover } from "./internal/io/protection-views.node.ts";
export { openAgentDuplication } from "./internal/roots/agent-duplicate.runtime.ts";
export { createNativeCheckpointCapturePort } from "./internal/host/native-checkpoint.ts";
export type { NativeCheckpointBoundary, NativeCheckpointSchema } from "./internal/host/native-checkpoint.ts";
export { createCurrentStateClient, type CurrentStateTransport } from "./internal/io/current-state-client.node.ts";
export { openContinuityCurrentState, type CurrentStateInput, type InitializationResult } from "./internal/roots/continuity-state.runtime.ts";
export type { NativeCurrentStatePort, NativeCurrentHead, CaptureCurrentRequest, InitializeCurrentRequest, InitializationPermission } from "@grokbox/runtime-kernel/continuity";
export type { ContinuityStoreInput, PublicationReceipt } from "./internal/io/continuity-store.node.ts";
export { measureContinuityStorage } from "./internal/io/continuity-storage.node.ts";
export { maintainObservationStorage, type StorageMaintenanceInput } from "./internal/io/storage-maintenance.node.ts";
export type { ContinuitySource, ContinuityEvent, ProtectedStorageRef, ContinuityStorageOwner, ContinuityStorageOwners, OwnerMeasurement, ReferenceChange, ReferenceReceipt, OwnedMaintenanceReceipt } from "@grokbox/runtime-kernel/observation";
export { openConfigStore, commitConfigChange, recoverConfigCommit, unifiedConfigurationLayer, type ConfigStore, type ConfigSnapshot } from "./internal/io/config-store.node.ts";
export { readConfigLayout, rootConfigLayout, readConfigFile, publishConfigFile, publishLayoutAliases, readInstallation, type ConfigLayout, type InstallationState } from "./internal/io/config-layout.node.ts";
export { planConfigurationMigration, applyConfigurationMigration, recoverConfigurationMigration, configurationMigrationStatus, migrationPreview, type MigrationOptions } from "./internal/io/config-migrate.node.ts";
export { inspectConfigurationLease } from "./internal/io/config-lock.node.ts";
export { previewConfigurationAliases, repairConfigurationAliases } from "./internal/io/config-aliases.node.ts";
export { configApplicationRevisions, createConfigConsumerOwner, publishConfigApplication, releaseConfigApplication, observeConfigApplication, type ConfigConsumerOwner } from "./internal/io/config-application.node.ts";
export { prepareConfigurationBootstrap, installConfigurationResources, rollbackConfigurationBootstrap, type BootstrapInstallation, type BootstrapIntent } from "./internal/io/config-bootstrap.node.ts";
export { saveRuntimeModels, saveRuntimeDesired, configurationWriteLayer } from "./internal/io/configuration-write.node.ts";
export { persistModelCredential } from "./internal/io/persist-model-credential.node.ts";
export { readManagedOwnership, type OwnershipReader } from "./internal/io/ownership-admission.node.ts";
export { changeRuntimeModel, migrateRuntimeModels } from "./internal/io/model-selection.node.ts";
export { modelConfigurationLayer } from "./internal/io/model-management.node.ts";
export { ManagementSourceError, type NativeBotSummary, type NativeBotSnapshot } from "./internal/io/management-gateway.node.ts";
export { managedModelAdmission } from "./internal/roots/model-management.runtime.ts";
export {
  projectLiveStatus,
  readContracts,
  type RuntimeStatus,
} from "./internal/io/observe.ts";
export {
  observeEvents,
  observeRuntimeEvents,
  maintainObservationJournals,
  projectJournalEvent,
  projectControlEvent,
  type EventsObservation,
  type JournalLookup,
  type RuntimeEventSelector,
  HOST_STREAM_REJECT_REASONS,
  TURN_SEAM_ERROR_CODES,
  projectHostSeamStage,
  projectHostStreamRejected,
  type HostStreamRejectedEvent,
} from "./internal/io/journal.node.ts";
export { replaceModeld } from "./internal/roots/modeld-replace.node.ts";
export { observeModeldService, probeModeldExecution } from "./internal/wire/modeld-probe.node.ts";
export { observeJournalHealth, readJournalHealth, type JournalHealthObservation } from "./internal/host/journal-health.node.ts";
export {
  HOST_FAILURE_CATALOG,
  INVALID_STREAM_AGENT_MESSAGE,
  LOCAL_TRANSPORT_AGENT_MESSAGE,
  catalogAgentMessage,
  catalogByFailureCode,
  catalogByReason,
  mapAdmitCatch,
  mapTerminalReject,
  type HostFailureCatalogRow,
} from "./internal/host/failure-catalog.ts";
export {
  writeReviewedProfileFromCopy,
  ProfileWriteRefused,
  profileObserveThenWriteNext,
  profileWriteUnretainedNext,
  profileWriteMissingGoldenNext,
  profileWriteDriftNext,
  profileWriteExecutableNext,
  inspectRetainedWriteEnvelope,
  type ProfileWriteLineage,
  type ProfileWriteRefusal,
  type ProfileWriteInspect,
  type WriteReviewedProfileReceipt,
} from "./internal/process/profile.node.ts";
export { observeHostProvenance, type HostSeamObserveReceipt } from "./internal/ops/host-seam/observe.ts";
export {
  applyRetentionPlan,
  buildRetentionPlan,
  readRetentionPlanFile,
  unavailableTrash,
  type RetentionPlan,
} from "./internal/ops/host-seam/prune.ts";
export { watchHostSeamOnce, type HostSeamWatchOnceReceipt } from "./internal/ops/host-seam/watch.ts";
export { readOnlyHostStatus, HOST_UPGRADE_RPC_FORBIDDEN } from "./internal/ops/host-seam/gateway-readonly.ts";
export {
  replayHostSeam,
  assertReplayCoverage,
  bindReviewedProfile,
  writeGoldenLabels,
  writeReplayReport,
  readLastReplayReport,
  type ReplayReport,
} from "./internal/ops/host-seam/replay.ts";
export { projectHostSeamStatus, type HostSeamStatusFacets } from "./internal/ops/host-seam/seam-status.ts";
export {
  ENVELOPE_SLICE_COUNT,
  ENVELOPE_SLICE_IDS,
  ENVELOPE_WINDOWS_FILE,
  admitWriteEnvelope,
  classifyWriteEnvelopeDrift,
  diffEnvelopeWindows,
  encodeEnvelopeWindows,
  generationEnvelopePath,
  measureEnvelopeWindows,
  parseEnvelopeWindows,
  observeRetainedEnvelopeDrift,
  type EnvelopeDrift,
  type EnvelopeDriftObservation,
  type EnvelopeWindows,
  type WriteEnvelopeAdmission,
} from "./internal/ops/host-seam/envelope-windows.ts";
export {
  proposeFromSource,
  readProposeSource,
  writeCandidateArtifact,
  proposeSummary,
  autoPublishTopCandidate,
  type CandidateArtifact,
} from "./internal/ops/host-seam/propose.ts";
export {
  createAnalysisSession,
  createFakeAnalysisPort,
  writeAnalysisArtifact,
  attachWriteEnvelopeInspect,
  type AnalysisResult,
  type AnalysisEnvelopeEvidence,
} from "./internal/ops/host-seam/analyze.ts";

export { startModeldProcess, ensureModeld, modeldRootLayer, type StartedModeld, type ModeldEnsure } from "./internal/roots/modeld.runtime.ts";
export { openMonitorStore } from "./internal/io/monitor-store.node.ts";
export { runMonitor } from "./internal/roots/monitor.runtime.ts";
export { runIncidentEvidenceCommand } from "./internal/roots/incident-evidence.runtime.ts";
export { startRuntimeCommand, type RuntimeStartResult } from "./internal/roots/command.runtime.ts";
export { startControlOperation, controllerOperationId, observeControllerHostGeneration, diskPreloadSha256, reviewedProfileSha256,
  recoverControllerOperationState, type OperationRecoveryReport } from "./internal/roots/controller-program.node.ts";
export { stopPatchedHostCoverage, stopLivePatchedHost } from "./internal/process/host-stop.ts";
export type { IdentityOpResult } from "./internal/process/identity-op.ts";
