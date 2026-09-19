/** Management metadata only; native Bot state stays in its original stores. */
export const CONTINUITY_WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS continuity_workflows(
 operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL,request_json TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT,target_id TEXT,
 phase TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS continuity_workflow_materials(
 operation_id TEXT NOT NULL REFERENCES continuity_workflows(operation_id),snapshot_id TEXT NOT NULL,
 PRIMARY KEY(operation_id,snapshot_id));
CREATE TABLE IF NOT EXISTS continuity_subject_materials(
 logical_id TEXT NOT NULL REFERENCES continuity_subjects(logical_id),snapshot_id TEXT NOT NULL,
 PRIMARY KEY(logical_id,snapshot_id));
CREATE TABLE IF NOT EXISTS continuity_steps(
 operation_id TEXT NOT NULL REFERENCES continuity_workflows(operation_id),step TEXT NOT NULL,input_digest TEXT NOT NULL,
 state TEXT NOT NULL,result_json TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(operation_id,step));
CREATE TABLE IF NOT EXISTS continuity_subjects(
 logical_id TEXT PRIMARY KEY,current_id TEXT NOT NULL,generation INTEGER NOT NULL,revision INTEGER NOT NULL,
 state_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS continuity_handover_items(
 operation_id TEXT NOT NULL REFERENCES continuity_workflows(operation_id),item_id TEXT NOT NULL,kind TEXT NOT NULL,
 state TEXT NOT NULL,input_json TEXT NOT NULL,result_json TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(operation_id,item_id));
CREATE TABLE IF NOT EXISTS continuity_queued_controls(
 operation_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,kind TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL,
 result_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS continuity_active_workflows ON continuity_workflows(phase,updated_at);
CREATE INDEX IF NOT EXISTS continuity_source_workflows ON continuity_workflows(source_id,kind,created_at);
CREATE INDEX IF NOT EXISTS continuity_pending_controls ON continuity_queued_controls(state,created_at);
`;
