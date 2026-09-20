// Generated from protocols/host-verifier/v1/schema.json. Do not edit.
pub const SCHEMA_DIGEST: &str = "8fbb644ff38372420dfb8bde1f4eb3fbebdab6c26941e8e5c61dbb4cd8a18aac";
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Initialize {
    pub protocol: u64,
    pub schema_digest: String,
    pub build_id: String,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct InitializeRequest {
    pub jsonrpc: String,
    pub id: String,
    pub method: String,
    pub params: Initialize,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct AnalyzeRequest {
    pub jsonrpc: String,
    pub id: String,
    pub method: String,
    pub params: Job,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct HelloResponse {
    pub jsonrpc: String,
    pub id: String,
    pub result: Hello,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct AnalyzeResponse {
    pub jsonrpc: String,
    pub id: String,
    pub result: Report,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub role: String,
    pub fd: u64,
    pub sha256: String,
    pub bytes: u64,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub id: String,
    pub revision: u64,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Job {
    pub job_id: String,
    pub attempt_id: String,
    pub artifacts: Vec<Artifact>,
    pub checks: Vec<Requirement>,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Finding {
    pub id: String,
    pub revision: u64,
    pub state: String,
    pub code: String,
    pub start: u64,
    pub end: u64,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Syntax {
    pub role: String,
    pub sha256: String,
    pub bytes: u64,
    pub state: String,
    pub diagnostics: u64,
    pub nodes: u64,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub job_id: String,
    pub attempt_id: String,
    pub schema_digest: String,
    pub build_id: String,
    pub syntax: Vec<Syntax>,
    pub findings: Vec<Finding>,
    pub elapsed_ms: u64,
}
#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub protocol: u64,
    pub schema_digest: String,
    pub build_id: String,
    pub parser: String,
    pub checks: Vec<Requirement>,
}
