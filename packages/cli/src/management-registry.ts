import type { LeafCommand, OptionSpec } from "./registry.ts";

const common: readonly OptionSpec[] = [
  { flags: "--connection <name>", description: "Select an explicit pinned connection (default: this Box)" },
  { flags: "--timeout-ms <n>", description: "Bound this client request, not the remote operation lifetime" },
];
const mutation: readonly OptionSpec[] = [
  { flags: "--request-id <uuid>", description: "Caller-persisted request UUID; reuse it only for identical input", required: true },
  { flags: "--expect-revision <revision>", description: "Observed domain configuration revision read before this change", required: true },
];
function command(path: string, summary: string, target?: { name: string; description: string }, options: readonly OptionSpec[] = [], write = false): LeafCommand {
  return { path: path.split(" "), usage: `grokbox ${path}${target ? ` <${target.name}>` : ""}${write ? " --request-id <uuid> --expect-revision <revision>" : ""}`,
    summary, arguments: target ? [{ syntax: `<${target.name}>`, description: target.description }] : [],
    options: [...common, ...(write ? mutation : []), ...options], stdin: "none", table: false, timeout: true,
    destructive: write, gateway: false, streaming: false, profile: false, protocol: "management" };
}
const bot = { name: "bot-ref", description: "Stable native UUID or scoped Bot reference" };
const model = { name: "model-id", description: "Exact configured model identity" };
export const MANAGEMENT_COMMANDS: readonly LeafCommand[] = [
  command("bot context get", "Read the single current native context revision without body, capture or repair.", bot),
  { ...command("bot context compact", "Preview or explicitly compact the current default Box context; can incur summary-model cost, never sends a user task.", bot, [
    { flags: "--preview", description: "Read current Host/model/policy approval and budget without reading body or writing any operation" },
    { flags: "--request-id <uuid>", description: "Caller-persisted UUID for the same immutable request" },
    { flags: "--scope-id <sha256>", description: "Account scope from the preview" },
    { flags: "--expect-revision <sha256>", description: "Preview revision binding scope, loaded Host, model selection and cost policy; not a root snapshot" },
    { flags: "--confirm", description: "Confirm paid compaction of the current root when its native runner admits the request" },
  ]), destructive: true },
  ...(["initialize", "reset", "restore"] as const).map(action => command(`bot context ${action}`, "Change one exact current context through CONT; reset/restore back up first, and all changes remain prepared until explicit activation.", bot, [
    { flags: "--scope-id <sha256>", description: "Exact account scope from context get", required: true },
    ...(action !== "reset" ? [{ flags: "--snapshot-ref <ref>", description: "Exact installation/scope-bound retained source snapshot", required: true }] : []),
    { flags: "--confirm", description: "Confirm this source effect without starting a task", required: true },
  ], true)),
  command("bot snapshot create", "Capture one exact current checkpoint into the original private recovery owner; never repairs or changes the source.", undefined, [
    { flags: "--bot <ref>", description: "Exact native Bot UUID or scoped reference", required: true },
    { flags: "--scope-id <sha256>", description: "Exact account scope from context get", required: true },
    { flags: "--confirm", description: "Confirm private recovery-material capture", required: true },
  ], true),
  command("bot activate", "Release only the prepared context belonging to this original CONT operation; never starts a task or releases a different hold.", bot, [
    { flags: "--scope-id <sha256>", description: "Original context operation account scope", required: true },
    { flags: "--confirm", description: "Confirm enabling subsequent ordinary input", required: true },
  ], true),
  ...(["clone", "replace", "spawn"] as const).map(kind => ({ ...command(`bot ${kind}`, "Preview or submit one immutable native lifecycle through the management Server; unknown creation is never retried.", kind === "spawn" ? undefined : bot, [
    { flags: "--input <source>", description: "Strict JSON declaration from @file or -; contains the persisted request UUID, optional profile/model/instructions and effect choices", required: true },
    { flags: "--request-id <uuid>", description: "Caller-persisted request UUID, alternatively in the input; duplicate fields refuse" },
    { flags: "--preview", description: "Read the native plan without creating a workflow, Bot or private recovery store" },
    { flags: "--scope-id <sha256>", description: "Exact account scope returned by preview" },
    { flags: "--expect-plan <sha256>", description: "Exact plan digest returned by preview" },
    { flags: "--confirm", description: "Authorize the reviewed native effects, optional startup costs and explicit handover messages" },
  ]), stdin: "json" as const, destructive: true })),
  { ...command("operation cancel", "Cancel only an original undispatched preparation or live staging upload; never forget an unknown published effect.", { name: "operation-ref", description: "Original context operation; file domain uses the original upload request UUID" }, [
    { flags: "--domain <domain>", description: "Implemented cancellation domains: context, compaction, handover or file", required: true },
    { flags: "--bot <ref>", description: "Required for context/compaction: exact original Bot UUID or reference" },
    { flags: "--generation <uuid>", description: "File domain: original serviceGeneration from its retained operation" },
    { flags: "--confirm", description: "Confirm retaining the original guard and releasing only uncommitted resources", required: true },
  ]), destructive: true },
  command("operation list", "Read bounded retained lifecycle operations owned by the current principal; not all installation work.", undefined, [
    { flags: "--domain <domain>", description: "Implemented listing: lifecycle", required: true },
    { flags: "--limit <n>", description: "Page size 1 to 100" }, { flags: "--cursor <cursor>", description: "Original principal/scope-bound continuation" },
  ]),
  { ...command("operation resume", "Resume only the original saved lifecycle and its safe stages; never submit a replacement create.", { name: "operation-ref", description: "Original installation/scope/request-bound lifecycle reference" }, [
    { flags: "--domain <domain>", description: "Implemented domains: lifecycle, context, compaction or handover", required: true },
    { flags: "--expect-plan <sha256>", description: "Required for lifecycle: immutable original plan digest" },
    { flags: "--bot <ref>", description: "Required for context/compaction: exact original Bot UUID/ref" },
    { flags: "--confirm", description: "Authorize continuing the original effects within current permissions", required: true },
  ]), destructive: true },
  command("system host health", "Read installation Host source/patch analysis and sensing gaps; not runtime execution authority or a repair."),
  command("system identity get", "Read the authenticated management identity and installation."),
  command("system protection get", "Read default protection, current worker and retained subjects; no native request or repair."),
  {...command("system protection set", "Explicitly enable or disable the protection policy; stopping does not erase materials or undo native effects.", undefined, [
    {flags:"--enabled <boolean>",description:"Exactly true or false",required:true},{flags:"--confirm",description:"Confirm the background protection policy change",required:true}],true),
    options:[...common,...mutation.map(o=>({...o,description:o.flags.includes("expect-revision")?"Observed configuration revision":o.description})),{flags:"--enabled <boolean>",description:"Exactly true or false",required:true},{flags:"--confirm",description:"Confirm the background protection policy change",required:true}]},
  command("bot protection get", "Read one original Bot's effective policy and retained protection history without following its successor.", bot),
  {...command("bot protection set", "Patch this Bot's protection policy; does not directly capture, pause, create or delete a Bot.",bot,[
    {flags:"--input <source>",description:"Strict JSON protection patch from @file or -",required:true},{flags:"--confirm",description:"Confirm effects allowed by this policy",required:true}],true),stdin:"json"},
  command("bot protection reset", "Remove only this Bot's policy override and restore default protection; retain its safety history.",bot,[{flags:"--confirm",description:"Confirm returning to default protection",required:true}],true),
  command("bot snapshot list", "List bounded retained recovery metadata, without reading private snapshot content.",undefined,[{flags:"--bot <bot-ref>",description:"Original native Bot UUID or scoped reference",required:true},{flags:"--limit <n>",description:"1 to 100, default20; reports more retained metadata"}]),
  command("bot snapshot get", "Read exact recovery metadata; stored hashes do not prove native import.",{name:"snapshot-ref",description:"Installation/scope-bound snapshot reference"}),
  command("bot handover get", "Read staged successor and duty metadata; current usability and retirement remain separate facts.",{name:"handover-ref",description:"Installation/scope-bound handover reference"}),
  ...(["advance","observe","attest","retire"] as const).map(action=>command(`bot handover ${action}`,
    action==="observe"?"Read bounded native relationship evidence and retain convergence; does not send messages or mutate native relationships.":action==="attest"?"Reobserve an exact duty against evidence from a retained observation; arbitrary hashes cannot clear dependencies.":action==="retire"?"Recheck an original observed retirement candidate; missing native fencing or resource independence retains the source.":"Advance bounded duties in the original replacement; may send explicitly authorized user notices, never re-create a Bot.",
    {name:"handover-ref",description:"Exact installation/scope-bound replacement handover"},[
      ...(action==="attest"?[{flags:"--item-id <uuid>",description:"Exact observed duty identity",required:true}]:[]),
      ...(["attest","retire"].includes(action)?[{flags:"--evidence-ref <ref>",description:action==="attest"?"Exact duty evidence from an original observation":"Original completed handover observation operation",required:true}]:[]),
      {flags:"--confirm",description:"Confirm this bounded action and its original operation identity",required:true},
    ],true)),
  command("system materials get", "Read configured source coverage and index freshness; never initialize or mutate a source."),
  command("file root list", "Read named-root bindings and indexed file sources without exposing private root paths."),
  command("file root get", "Resolve one configured named root to its exact file reference.",{name:"name",description:"Exact configured root name"}),
  command("file stat", "Read the complete current revision of an exact named-root object.",{name:"file-ref",description:"Installation/root-bound file reference"}),
  ...(["mkdir","delete","restore"] as const).map(action=>({...command(`file ${action}`,action==="restore"?"Restore this principal's original retained deletion without overwriting another destination.":action==="delete"?"Move the exact reviewed object into recoverable trash, never irreversible recursive deletion.":"Create one directory at an explicitly absent destination.",{name:"file-ref",description:"Exact non-root file reference"},[
    {flags:"--request-id <uuid>",description:"Persist before this original effect",required:true},
    ...(action==="delete"?[{flags:"--expect-revision <sha256>",description:"Revision from file stat",required:true},{flags:"--recursive",description:"Authorize the complete bounded directory subtree"}]:[]),
    ...(action==="restore"?[{flags:"--deletion-request-id <uuid>",description:"Original successful deletion by this principal",required:true}]:[]),
    {flags:"--confirm",description:"Confirm this exact filesystem change",required:true}]),destructive:true})),
  {...command("file upload","Upload a bounded local binary through the shared manager; verify exact bytes before publication.",{name:"file-ref",description:"Exact destination reference"},[
    {flags:"--from <path>",description:"Explicit local regular source",required:true},{flags:"--request-id <uuid>",description:"Original caller-persisted request",required:true},
    {flags:"--expect-revision <revision>",description:"Current SHA-256, or absent for no existing destination",required:true},{flags:"--confirm",description:"Confirm this destination publication",required:true}]),destructive:true},
  command("file download","Download one pinned binary to a new caller-local destination with verified size and hash.",{name:"file-ref",description:"Exact source reference"},[{flags:"--to <path>",description:"New local file; never overwritten",required:true}]),
  ...(["memory","file","project"] as const).flatMap(domain => [
    {...command(`${domain} list`, "List source-scoped document metadata; file accepts a named-root directory reference for a direct snapshot.", undefined, [
      {flags:"--source <id>",description:"Configured source ID"},{flags:"--scope <scope>",description:"agent, user, project or file"},
      {flags:"--limit <n>",description:"Page size, 1 to 100"},{flags:"--cursor <cursor>",description:"Original snapshot/query cursor"}]),...(domain==="file"?{arguments:[{syntax:"[file-ref]",description:"Named-root directory, or omit for the indexed file window"}],usage:"grokbox file list [<file-ref>]"}:{})},
    command(`${domain} ${domain === "project" ? "get" : "read"}`, "Explicitly read source text and disclose index lag; no TURN adoption is inferred.", {name:"material-ref",description:"Exact installation/source-bound document reference"}),
    ...(domain === "project" ? [] : [command(`${domain} search`, "Search indexed text literally without exposing body excerpts.", {name:"query",description:"Literal text, at most 256 characters"}, [
      {flags:"--source <id>",description:"Configured source ID"},{flags:"--scope <scope>",description:"agent, user, project or file"},{flags:"--limit <n>",description:"Page size, 1 to 100"},{flags:"--cursor <cursor>",description:"Original snapshot/query cursor"}])]),
  ]),
  { ...command("file write", "Replace one existing authorized text document with durable recovery; native Memory/Project replicas are read-only."),
    arguments:[{syntax:"[material-ref]",description:"Exact reference, alternatively in input"}],usage:"grokbox file write [<material-ref>] --input @file|- --confirm",
    options:[...common,{flags:"--input <source>",description:"Strict JSON: ref, content, requestId, expectedRevision",required:true},
      {flags:"--request-id <uuid>",description:"Persist before submission"},{flags:"--expect-revision <sha256>",description:"Observed source revision"},{flags:"--confirm",description:"Confirm one existing text replacement",required:true}],stdin:"json",destructive:true },

  command("notification settings get", "Read bounded notification target and budget settings; no credential or automatic grant."),
  ...["notification settings apply", "routine apply"].map(path => ({ ...command(path,
    "Apply one explicitly confirmed setup request from strict JSON; persist requestId before submission and query its domain receipt after uncertainty.", undefined,
    [{flags:"--input <source>",description:"Strict JSON SetupRequest including action, confirmed, requestId and expectedRevision; @file or -",required:true}]), destructive:true, stdin:"json" as const })),
  command("notification receiver blueprint", "Read the fixed disabled reminder Routine blueprint for one configured alias; no native reads or writes.", {name:"alias",description:"Exact configured receiver alias"}),
  { ...command("notification receiver bind", "Prepare one private receiver binding after reserving its durable key-mint guard; does not enable or invoke a Routine.", {name:"alias",description:"Exact configured receiver alias"}, [
    {flags:"--routine-ref <ref>",description:"Exact installation/Bot-scoped native Routine reference",required:true},
    {flags:"--database-id <uuid>",description:"Existing observation database identity",required:true},
    {flags:"--request-id <uuid>",description:"Persisted pairing request identity",required:true},
    {flags:"--expect-revision <sha256>",description:"Observed disabled Routine revision",required:true},
    {flags:"--expect-binding-revision <n>",description:"Current alias binding revision, or 0 for a new binding",required:true},
    {flags:"--confirm",description:"Allow the native credential request and private local storage",required:true},
  ]), destructive:true },
  command("routine list", "Read a bounded native Routine window for one exact Bot, without prompts or credentials.",undefined,[{flags:"--bot <ref>",description:"Stable native UUID or installation-scoped Bot",required:true}]),
  command("routine get", "Read one exact native Routine without prompt or credential content.",{name:"routine-ref",description:"Scoped native Routine reference"}),
  ...(["enable","disable","delete"] as const).map(action => ({ ...command(`routine ${action}`,
    "Request one native Routine state change behind a durable replay guard; readback is not native CAS, invocation or cancellation of in-flight runs.",
    {name:"routine-ref",description:"Scoped native Routine reference"},[
      {flags:"--request-id <uuid>",description:"Persist before this action",required:true},
      {flags:"--expect-revision <sha256>",description:"Observed Routine revision",required:true},
      {flags:"--confirm",description:"Confirm this native definition change; enabled schedules may run according to native policy",required:true},
    ]), destructive:true })),
  command("job policy", "Read executable aliases, named cwd roots and the current service policy revision; no process is started."),
  { ...command("job start", "Submit one service-owned OS Job with literal argv and a persistent request identity; acceptance is not execution success.", undefined, [
    { flags: "--input <source>", description: "Strict JSON @file|-: argv, environment, cwd, runTimeoutMs, output and shell", required: true },
    { flags: "--request-id <uuid>", description: "Persist before submission", required: true },
    { flags: "--expect-revision <sha256>", description: "Reviewed Job policy revision", required: true },
    { flags: "--confirm", description: "Authorize this OS execution; executable policy is not a filesystem sandbox", required: true },
  ]), destructive: true, stdin: "json" },
  command("job list", "Read this principal's retained Jobs; no native execution or admission.", undefined, [
    { flags: "--limit <n>", description: "Page size 1 to 100" }, { flags: "--cursor <cursor>", description: "Original principal-bound cursor" }]),
  command("job get", "Read the exact Job's current or retained observation.", { name: "job-ref", description: "Installation-scoped Job reference" }),
  command("job wait", "Wait for the original Job's terminal observation in a bounded window; disconnecting never cancels it.", { name: "job-ref", description: "Original Job reference" }, [
    { flags: "--wait-ms <n>", description: "Observation window 1 to 25000 milliseconds; default 25000" }]),
  command("job logs", "Read an explicit bounded binary log page; output is data, not instructions.", { name: "job-ref", description: "Original Job reference" }, [
    { flags: "--offset <n>", description: "Original verified byte boundary; default 0" }]),
  { ...command("job cancel", "Request cancellation of the service-owned process group; never claims external effects were undone.", { name: "job-ref", description: "Original Job reference" }, [
    { flags: "--request-id <uuid>", description: "Persisted cancellation identity", required: true },
    { flags: "--confirm", description: "Authorize cancellation of this Job", required: true },
  ]), destructive: true },
  command("notification status", "Read the management-owned notification worker; does not enable, send, or inspect receiver content."),
  command("notification receiver list", "Read local receiver bindings and explicit permissions; no native query or credential export."),
  ...["get", "verify"].map(action => command(`notification receiver ${action}`, action === "get" ? "Read an exact receiver binding." : "Read fresh receiver/model qualification without sending a test or granting permission.",
    { name: "receiver-ref", description: "Installation/database-scoped receiver binding reference" })),
  ...(["enable", "disable", "unbind", "test"] as const).map(action => ({ ...command(`notification receiver ${action}`,
    action === "test" ? "Send one independently requested test, not an incident or activation prerequisite; may consume model usage."
      : "Change local receiver consent with a durable receipt; enable does not require a test or send anything.",
    { name: "receiver-ref", description: "Installation/database-scoped receiver binding reference" }, [
      { flags: "--request-id <uuid>", description: "Persisted identity for this action", required: true },
      { flags: "--expect-revision <n>", description: "Observed binding revision", required: true },
      ...(["enable", "test"].includes(action) ? [{ flags: "--expect-model-revision <sha256>", description: "Model revision from receiver verify", required: true }] : []),
      { flags: "--confirm", description: action === "test" ? "Authorize this one test and possible model cost" : "Confirm the local consent change; future enabled delivery may incur model cost", required: true },
    ]), destructive: true })),
  { ...command("notification send", "Send one existing incident notification through its original outbox; may consume model usage, never grants automatic delivery.",
    { name: "notification-ref", description: "Exact installation/database-scoped incident work reference" }, [
      { flags: "--receiver <receiver-ref>", description: "Exact reviewed receiver binding in the same database", required: true },
      { flags: "--request-id <uuid>", description: "Persist this identity before submission; repeats only read the original request", required: true },
      { flags: "--expect-revision <n>", description: "Reviewed binding revision", required: true },
      { flags: "--expect-model-revision <sha256>", description: "Model revision from receiver verify", required: true },
      { flags: "--confirm", description: "Authorize this one notification and possible model cost", required: true },
    ]), destructive: true },
  command("notification list", "Read retained incident and test delivery records without sending or retrying.", undefined, [
    { flags: "--limit <n>", description: "Maximum retained records, 1 to 100" }, { flags: "--cursor <cursor>", description: "Original database-bound page cursor" }]),
  command("notification get", "Read a scoped notification attempt; native acceptance is not a Bot report or user read.", { name: "notification-ref", description: "Installation/database-scoped work reference" }),
  command("system service get", "Read this management process and its owned observation worker; not supervisor installation or modeld authority.",
    { name: "component", description: "Implemented component: server" }),
  command("system observation get", "Read the persisted observation snapshot and freshness; never start a collector or infer execution authority."),
  ...["incident list", "event list"].map(path => command(path, path === "incident list"
    ? "Read bounded persisted incidents; acknowledgement and resolution are separate."
    : "Read retained observation events, continuing a snapshot cursor without live collection.", undefined, [
      { flags: "--limit <n>", description: "Maximum page size, 1 to 100" },
      { flags: "--cursor <cursor>", description: "Database/collector-bound cursor; a gap requires a new snapshot" },
    ])),
  command("incident get", "Read one database-scoped incident without collecting or changing it.", { name: "incident-ref", description: "Stable installation/database-scoped incident reference" }),
  ...(["ack", "snooze"] as const).map(action => ({ ...command(`incident ${action}`, "Record incident management through the shared writer; never mark the underlying problem repaired.",
    { name: "incident-ref", description: "Stable installation/database-scoped incident reference" }, [
      { flags: "--request-id <uuid>", description: "Persist before submission; identical retries refer to this original action", required: true },
      { flags: "--expect-revision <n>", description: "Observed integer incident revision", required: true },
      ...(action === "snooze" ? [{ flags: "--until-ms <n>", description: "Absolute deadline, at most 24 hours in the future for a new action", required: true }] : []),
    ]), destructive: true })),
  { ...command("event watch", "Follow retained observation events from a snapshot cursor; bounded window, explicit terminal frame, no write replay.", undefined, [
      { flags: "--cursor <cursor>", description: "Verified snapshot or event cursor to continue", required: true },
      { flags: "--limit <n>", description: "Maximum events per frame, 1 to 100" },
      { flags: "--duration-ms <n>", description: "Watch window, 1 to 60000 ms (default 30000)" },
    ]), streaming: true },
  { ...command("system console grant create", "Write a transient, one-use console login credential to a private file.", undefined, [
      { flags: "--origin <origin>", description: "Exact configured HTTPS or loopback console origin", required: true },
      { flags: "--credential-file <path>", description: "New owner-private file; never print the code in the normal envelope", required: true },
    ]), destructive: true, usage: "grokbox system console grant create --origin <origin> --credential-file <path>" },
  command("bot list", "Read a bounded native Bot page with stable scoped references.", undefined, [
    { flags: "--limit <n>", description: "Maximum page size, 1 to 100; byte bounds may return fewer" },
    { flags: "--cursor <cursor>", description: "Continue the same native membership snapshot" },
  ]),
  command("bot resolve", "Resolve an exact name/title to a stable ref; never choose among ambiguous matches.", { name: "query", description: "Native UUID, scoped ref, or exact case-insensitive name/title (1024 UTF-8 bytes)" }),
  command("bot get", "Read a native Bot through the management service.", bot),
  command("bot model get", "Read the configured next-turn model relationship.", bot),
  command("bot model set", "Select an explicit model or follow the default for future turns.", bot, [
    { flags: "--model <model-id>", description: "Select one configured model" },
    { flags: "--follow-default", description: "Follow the installation default as a relationship" },
    { flags: "--effort <effort>", description: "Explicit model reasoning effort, or default to clear the override" },
  ], true),
  command("bot model reset", "Remove this Bot's override; in-flight turns remain unchanged.", bot, [], true),
  command("model list", "List a bounded page of configured models without credential values.", undefined, [
    { flags: "--limit <n>", description: "Page size, 1 to 100" },
    { flags: "--cursor <cursor>", description: "Continue the same installation/configuration page" },
  ]),
  command("model get", "Read one configured model without resolving its credential.", model),
  { ...command("model apply", "Apply an explicit patch or full local model declaration.", undefined, [], true),
    usage: "grokbox model apply [<model-id>] --input @file|- [--mode patch|replace] [--request-id <uuid>] [--expect-revision <revision>]",
    arguments: [{ syntax: "[model-id]", description: "Model identity, alternatively supplied in the input document" }],
    options: [...common, ...mutation.map(option => ({ ...option, required: false })),
      { flags: "--input <source>", description: "Strict JSON with modelId, mode, model, requestId and expectedRevision; duplicate flag fields refuse", required: true },
      { flags: "--mode <mode>", description: "patch preserves omitted fields; replace declares the complete local model" }], stdin: "json" },
  command("model delete", "Remove an unreferenced local model definition; imported and builtin sources refuse.", model, [], true),
  command("model default get", "Read the default model without opting any Bot into it."),
  command("model default set", "Set the default used only by explicit followers.", model, [
    { flags: "--effort <effort>", description: "Default reasoning effort, or default to clear the override" },
  ], true),
  command("model default reset", "Clear the default only after every follower is explicitly rebound.", undefined, [], true),
  { ...command("operation reconcile", "Read authoritative evidence and settle the original Routine or context request; no new native effect is dispatched.",undefined,[
    {flags:"--domain <domain>",description:"Implemented reconciliation domains: routine or context",required:true},
    {flags:"--request-id <uuid>",description:"Original request, not a new effect identity",required:true},
    {flags:"--routine-ref <ref>",description:"Routine domain: exact observed native Routine"},
    {flags:"--expect-revision <sha256>",description:"Routine domain: current revision of that exact Routine"},
    {flags:"--scope-id <sha256>",description:"Context domain: original account scope"},
    {flags:"--bot <ref>",description:"Context domain: exact original Bot UUID/ref"},
    {flags:"--confirm",description:"Confirm original-domain evidence reconciliation",required:true},
  ]),destructive:true },
  command("operation get", "Read a domain receipt using the original request UUID and source locator.", undefined, [
    { flags: "--request-id <uuid>", description: "Original request identity", required: true },
    { flags: "--target <target>", description: "protection receipts: original Bot UUID/ref or system" },
    { flags: "--scope-id <sha256>", description: "lifecycle/context receipts: original account scope" },
    { flags: "--domain <domain>", description: "model (default), file, job, job-cancel, material, protection, lifecycle, context, incident, receiver, notification, notification-test, notification-settings, routine, or pairing" },
    { flags: "--job-ref <ref>", description: "Required for job-cancel receipts; original installation-scoped Job" },
    { flags: "--database-id <uuid>", description: "Required for incident/receiver/notification/test receipts; use the original database identity" },
    { flags: "--bot <ref>", description: "Required for routine receipts; use the original scoped Bot or native UUID" },
  ]),
  { path: ["system", "service", "run"], usage: "grokbox system service run <server|web> [--port <n>]",
    summary: "Run one installed management Server or Web service in the foreground for its supervisor.",
    arguments: [{ syntax: "<component>", description: "Implemented component: server or web" }],
    options: [{ flags: "--root <path>", description: "Explicit existing Box installation" },
      { flags: "--native-discovery <path>", description: "Native Gateway discovery file" },
      { flags: "--console-origin <origin>", description: "Explicit HTTPS or loopback browser console origin" },
      { flags: "--management-url <url>", description: "Web only: fixed loopback management URL (or GROKBOX_MANAGEMENT_URL)" },
      { flags: "--installation-id <uuid>", description: "Web only: pinned installation identity (or GROKBOX_INSTALLATION_ID)" },
      { flags: "--port <n>", description: "Explicit loopback port; server permits zero, web defaults to 3100" }],
    stdin: "none", table: false, timeout: false, destructive: false, gateway: false, streaming: true, profile: false, localOnly: true, protocol: "management" },
];
