import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  readConfigLayout, rootConfigLayout, openConfigStore, commitConfigChange, readConfigFile, recoverConfigCommit, inspectConfigurationLease,
  previewConfigurationAliases, repairConfigurationAliases,
  planConfigurationMigration, migrationPreview, applyConfigurationMigration,
  configurationMigrationStatus, recoverConfigurationMigration, prepareConfigurationBootstrap, rollbackConfigurationBootstrap, observeConfigApplication, type ConfigLayout,
} from "@grokbox/box-runtime/runtime";
import {
  ConfigError, CONFIG_SCHEMA_VERSION, CONFIG_SCHEMA, applyConfigChange, configPathTokens, configSchemaAt, configurationRevisions,
  effectiveOps, effectiveStorage, effectiveContextIntent, getConfigValue, parseConfigJson, portableConfig, redactConfig, validateConfig,
  type ConfigChange, type UnifiedConfig,
} from "@grokbox/runtime-kernel/config";
import type { CliDeps } from "../deps.ts";
import { CliError, usage } from "../errors.ts";
import { writeSuccess } from "../output.ts";
import { writeDaemonConfig, validateDaemonConfig } from "../daemon/config.ts";

export type ConfigCommandOptions = {
  json?: boolean; effective?: boolean; scope?: string; string?: string; valueFile?: string;
  expectRevision?: string; confirm?: boolean; replace?: boolean; file?: string; portable?: boolean;
  physical?: boolean; document?: string; preview?: boolean; apply?: boolean; recover?: boolean;
  status?: boolean; planDigest?: string; role?: string; durableRoot?: string; prefer?: string;
  operationId?: string; resetOverrides?: boolean; waitApplied?: boolean; timeoutMs?: string; from?: string; prepare?: boolean;
};
function intentProjection(document: UnifiedConfig): UnifiedConfig {
  return { ...document, desktop: { idleReclaim: { enabled: false, minIdleMs: 600000, ...document.desktop?.idleReclaim }, keepAgentIds: document.desktop?.keepAgentIds ?? [] },
    runtime: { desiredMode: document.runtime?.desiredMode ?? "disabled", context: effectiveContextIntent(document.runtime?.context) }, ops: effectiveOps(document.ops), storage: effectiveStorage(document.storage) };
}
function selectedRemote(document: UnifiedConfig, selected?: string): boolean {
  const profile = document.client.profiles[selected ?? document.client.currentProfile];
  return Boolean(profile?.serverUrl || profile?.sshHost || profile?.gatewayUrl);
}
function configScope(layout: ConfigLayout, document: UnifiedConfig, path: string | undefined, options: ConfigCommandOptions, write: boolean, selected?: string): ConfigChange["scope"] {
  if (options.scope && !["local", "target"].includes(options.scope)) throw usage("config --scope must be local or target.");
  if (options.scope === "target") throw new ConfigError("config_scope_unavailable", "The selected target does not advertise a qualified configuration capability; no local file was changed.");
  const tokens = configPathTokens(path ?? "");
  if (tokens[0] === "client") return "client";
  if (write && selectedRemote(document, selected) && options.scope === undefined) throw new ConfigError("config_scope_required", "A remote Profile is selected. Specify --scope local or target before changing Box configuration.");
  return layout.role === "box" ? "box" : "client";
}
function operation(options: ConfigCommandOptions): string { return options.operationId ?? randomUUID(); }
async function migrate(deps: CliDeps, raw: ConfigCommandOptions) {
  if ([raw.preview, raw.apply, raw.recover, raw.status].filter(Boolean).length > 1) throw usage("Choose one migration operation: preview, apply, status or recover.");
  if (raw.role && raw.role !== "client" && raw.role !== "box") throw usage("Migration role must be client or box.");
  if (raw.prefer && !["canonical", "legacy"].includes(raw.prefer)) throw usage("Migration preference must be canonical or legacy.");
  const layout = await readConfigLayout(deps.configDir).catch((error) => {
    if (raw.role && (raw.status || raw.recover)) return raw.role === "box" ? rootConfigLayout(raw.durableRoot ?? deps.boxRuntimeRoot) : { role: "client" as const, configDir: deps.configDir, root: deps.configDir, configPath: resolve(deps.configDir, "config.json") };
    throw error;
  });
  const role = (raw.role ?? layout.role) as "client" | "box";
  const root = role === "box" ? resolve(raw.durableRoot ?? (layout.role === "box" ? layout.root : deps.boxRuntimeRoot)) : resolve(deps.configDir);
  if (raw.status) { writeSuccess(deps.stdout, await configurationMigrationStatus(root)); return; }
  if (raw.recover) {
    if (!raw.confirm) throw usage("Migration recovery requires --confirm.");
    writeSuccess(deps.stdout, await recoverConfigurationMigration(root)); return;
  }
  const options = { configDir: deps.configDir, root, role, ...(raw.prefer ? { prefer: raw.prefer as "canonical" | "legacy" } : {}) };
  if (raw.apply) {
    if (!raw.confirm || !raw.planDigest) throw usage("Migration apply requires --plan-digest and --confirm.");
    writeSuccess(deps.stdout, await applyConfigurationMigration(options, raw.planDigest));
  } else writeSuccess(deps.stdout, migrationPreview(await planConfigurationMigration(options)));
}

/** Config commands deliberately bypass ordinary Profile initialization. In
 * particular path/validate/migrate must remain usable with broken/old config. */
export async function runConfigCommand(deps: CliDeps, command: string, args: Array<string | undefined>, raw: ConfigCommandOptions): Promise<void> {
  const waitBudget = raw.timeoutMs === undefined ? 65_000 : Number(raw.timeoutMs);
  if (!Number.isSafeInteger(waitBudget) || waitBudget < 1 || waitBudget > 120_000) throw usage("Configuration application timeout must be 1–120000 milliseconds.");
  if (command === "migrate") { await migrate(deps, raw); return; }
  if (command === "aliases") {
    if (raw.scope && raw.scope !== "local") throw new ConfigError("config_scope_unavailable", "Alias repair is installation-local.");
    if (raw.preview && raw.apply) throw usage("Choose alias preview or apply, not both.");
    if (raw.apply) {
      if (!raw.confirm || !raw.planDigest || raw.scope !== "local") throw usage("Alias repair requires --scope local --apply --plan-digest and --confirm.");
      writeSuccess(deps.stdout, await repairConfigurationAliases(deps.configDir, raw.planDigest, deps.env.GROKBOX_BOX_RUNTIME_ROOT));
    } else writeSuccess(deps.stdout, await previewConfigurationAliases(deps.configDir, deps.env.GROKBOX_BOX_RUNTIME_ROOT));
    return;
  }
  if (command === "bootstrap") {
    if (!raw.confirm || !raw.operationId) throw usage("Explicit bootstrap requires --operation-id and --confirm.");
    if ([raw.prepare, raw.recover, Boolean(raw.from)].filter(Boolean).length !== 1) throw usage("Choose exactly one bootstrap operation: --prepare, --from or --recover.");
    const layout = await readConfigLayout(deps.configDir);
    const root = raw.durableRoot ?? (layout.role === "box" ? layout.root : deps.boxRuntimeRoot);
    const installation = { configDir: deps.configDir, root, operationId: raw.operationId };
    if (raw.prepare) { writeSuccess(deps.stdout, await prepareConfigurationBootstrap(installation)); return; }
    if (raw.recover) { writeSuccess(deps.stdout, await rollbackConfigurationBootstrap(installation)); return; }
    const resources = validateDaemonConfig(await readConfigFile(resolve(raw.from!)));
    await writeDaemonConfig(deps.configDir, resources, root, raw.operationId);
    writeSuccess(deps.stdout, { operationId: raw.operationId, installed: true, servicesStarted: false, application: "restart-required" }); return;
  }
  if (command === "schema") {
    const tokens = configPathTokens(args[0] ?? "");
    writeSuccess(deps.stdout, { schemaVersion: CONFIG_SCHEMA_VERSION, path: args[0] ?? "", schema: configSchemaAt(tokens) }); return;
  }
  if (command === "validate" && raw.file) {
    validateConfig(await readConfigFile(resolve(raw.file)));
    writeSuccess(deps.stdout, { valid: true, schemaVersion: CONFIG_SCHEMA_VERSION, written: false }); return;
  }
  const layout = await readConfigLayout(deps.configDir, deps.env.GROKBOX_BOX_RUNTIME_ROOT);
  if (command === "path") {
    if (raw.document && !["config", "models"].includes(raw.document)) throw usage("Document must be config or models.");
    if (raw.document === "models" && layout.role !== "box") throw new ConfigError("config_scope_unavailable", "Model configuration is Box-local; no client model file is created.");
    writeSuccess(deps.stdout, { role: layout.role, document: raw.document ?? "config", path: raw.physical
      ? raw.document === "models" ? layout.modelsPath : layout.configPath
      : resolve(layout.configDir, raw.document === "models" ? "models.json" : "config.json"), physical: Boolean(raw.physical) });
    return;
  }
  const store = openConfigStore(layout);
  if (command === "recover") {
    if (!raw.confirm) { writeSuccess(deps.stdout, { writer: await inspectConfigurationLease(layout.root), mutated: false }); return; }
    if (raw.scope !== "local") throw new ConfigError("config_scope_required", "Writer recovery requires explicit --scope local and --confirm.");
    writeSuccess(deps.stdout, await recoverConfigCommit(store, raw.operationId)); return;
  }
  const snapshot = await store.read();
  if (command === "validate") { writeSuccess(deps.stdout, { valid: true, schemaVersion: CONFIG_SCHEMA_VERSION, configRevision: snapshot.revision, written: false }); return; }
  if (command === "get") {
    configScope(layout, snapshot.document, args[0], raw, false, deps.env.GROKBOX_PROFILE);
    const tokens = configPathTokens(args[0] ?? ""); const schema = configSchemaAt(tokens);
    const value = getConfigValue(raw.effective ? intentProjection(snapshot.document) : snapshot.document, tokens);
    const stored = getConfigValue(snapshot.document, tokens);
    writeSuccess(deps.stdout, { scope: "local", role: layout.role, document: "config", path: args[0] ?? "", found: value !== undefined,
      ...(value !== undefined ? { value: redactConfig(value, schema) } : {}), configRevision: snapshot.revision,
      valueSource: stored !== undefined ? "explicit" : raw.effective && value !== undefined ? "preset-or-default" : "absent",
      ...(raw.effective ? { application: "not-observed", projection: "effective-intent", executionAuthorized: false } : {}) });
    return;
  }
  if (command === "export") {
    if (!raw.portable) throw usage("config export requires --portable; private installation data is not exported.");
    writeSuccess(deps.stdout, { document: portableConfig(snapshot.document), portable: true, bindingsIncluded: false, grantsIncluded: false }); return;
  }
  let change: ConfigChange;
  const common = { operationId: operation(raw), scope: configScope(layout, snapshot.document, command === "preset" ? "ops" : args[0], raw, true, deps.env.GROKBOX_PROFILE),
    ...(raw.expectRevision ? { expectedRevision: raw.expectRevision } : raw.preview ? { expectedRevision: snapshot.revision } : {}), confirm: Boolean(raw.confirm || raw.preview), replaceArrays: Boolean(raw.replace) };
  if (command === "set") {
    if (!args[0]) throw usage("config set requires a path.");
    if ([args[1] !== undefined, raw.string !== undefined, raw.valueFile !== undefined].filter(Boolean).length !== 1) throw usage("Use exactly one JSON value, --string, or --value-file.");
    const value = raw.string !== undefined ? raw.string : raw.valueFile ? await readConfigFile(resolve(raw.valueFile)) : parseConfigJson(args[1]!);
    change = { ...common, kind: "set", path: args[0], value };
  } else if (command === "unset") {
    if (!args[0]) throw usage("config unset requires a path.");
    change = { ...common, kind: "unset", path: args[0] };
  } else if (command === "apply") {
    if (!raw.file) throw usage("config apply requires --file.");
    change = { ...common, kind: "replace", value: await readConfigFile(resolve(raw.file)), replaceArrays: true };
  } else if (command === "preset") {
    if (args[0] !== "ops" || !["user", "maintainer"].includes(args[1] ?? "")) throw usage("Use config preset ops user|maintainer.");
    change = { ...common, kind: "preset", preset: args[1] as "user" | "maintainer", resetOverrides: raw.resetOverrides, replaceArrays: Boolean(raw.resetOverrides || raw.replace) };
  } else throw usage("Unknown configuration command.");
  if (raw.preview) {
    const proposed = applyConfigChange(snapshot.document, change);
    writeSuccess(deps.stdout, { preview: true, written: false, configRevision: snapshot.revision,
      changedPaths: proposed.changedPaths, value: redactConfig(proposed.document), proposedRevisions: configurationRevisions(proposed.document) }); return;
  }
  const receipt = await commitConfigChange(store, change);
  // Use this commit's dependency revisions, not the latest unrelated config.
  // Waiting neither starts a consumer nor asks it to restart or mutate Host.
  let application = await observeConfigApplication(layout.root, receipt);
  if (raw.waitApplied) {
    const deadline = performance.now() + waitBudget;
    while (application.state === "pending" && performance.now() < deadline && !deps.signal?.aborted) {
      try { await deps.wait(Math.max(1, Math.min(50, deadline - performance.now())), deps.signal); }
      catch { break; }
      application = await observeConfigApplication(layout.root, receipt);
    }
    if (application.state !== "not-required" && application.state !== "applied") {
      throw new CliError("config_apply_pending", "Configuration is committed; the affected consumer has not acknowledged application.", {
        context: { operationId: receipt.operationId, phase: "config-application", commit: receipt.commit, configRevision: receipt.configRevision, application: application.state },
      });
    }
  }
  writeSuccess(deps.stdout, { ...receipt, application });
}
