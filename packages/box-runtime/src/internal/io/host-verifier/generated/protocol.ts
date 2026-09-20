// Generated from protocols/host-verifier/v1/schema.json. Do not edit.
export const SCHEMA_DIGEST = "8fbb644ff38372420dfb8bde1f4eb3fbebdab6c26941e8e5c61dbb4cd8a18aac";
export type Initialize = { protocol: number; schema_digest: string; build_id: string };
export type InitializeRequest = { jsonrpc: "2.0"; id: string; method: "initialize"; params: Initialize };
export type AnalyzeRequest = { jsonrpc: "2.0"; id: string; method: "analyze"; params: Job };
export type HelloResponse = { jsonrpc: "2.0"; id: string; result: Hello };
export type AnalyzeResponse = { jsonrpc: "2.0"; id: string; result: Report };
export type Artifact = { role: "source" | "candidate" | "companion"; fd: number; sha256: string; bytes: number };
export type Requirement = { id: string; revision: number };
export type Job = { job_id: string; attempt_id: string; artifacts: Array<Artifact>; checks: Array<Requirement> };
export type Finding = { id: string; revision: number; state: "passed" | "violated" | "unsupported"; code: string; start: number; end: number };
export type Syntax = { role: "source" | "candidate" | "companion"; sha256: string; bytes: number; state: "valid" | "invalid"; diagnostics: number; nodes: number };
export type Report = { job_id: string; attempt_id: string; schema_digest: string; build_id: string; syntax: Array<Syntax>; findings: Array<Finding>; elapsed_ms: number };
export type Hello = { protocol: number; schema_digest: string; build_id: string; parser: "oxc-0.75.0"; checks: Array<Requirement> };
