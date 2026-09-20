mod generated { pub mod protocol; }
use generated::protocol::*;
use grokbox_host_verifier::{analyze,CHECKS};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use std::{io::{self,BufRead,Read,Write},fs::File,os::{fd::{FromRawFd,AsRawFd},unix::fs::MetadataExt},time::Instant};
const BUILD:&str=env!("GROKBOX_VERIFIER_BUILD_ID");
const SCHEMA:&str=include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/../../protocols/host-verifier/v1/schema.json"));
type Result<T>=std::result::Result<T,&'static str>;
fn digest(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}
fn hash(s:&str)->bool{s.len()==64 && s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn token(s:&str)->bool{!s.is_empty()&&s.len()<=64&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_".contains(&b))}
fn frame(input:&mut impl BufRead)->Result<Vec<u8>> {
    let mut header=Vec::new();
    loop {let mut b=[0u8;1];input.read_exact(&mut b).map_err(|_|"truncated-frame")?;header.push(b[0]);
        if header.len()>128{return Err("header-limit");}if header.ends_with(b"\r\n\r\n"){break;}}
    let h=std::str::from_utf8(&header).map_err(|_|"invalid-header")?;
    let length=h.strip_prefix("Content-Length: ").and_then(|v|v.strip_suffix("\r\n\r\n")).ok_or("invalid-header")?;
    if length.is_empty()||!length.bytes().all(|b|b.is_ascii_digit())||length.starts_with('0'){return Err("invalid-length");}
    let n:usize=length.parse().map_err(|_|"invalid-length")?;if n>65536{return Err("body-limit");}
    let mut body=vec![0;n];input.read_exact(&mut body).map_err(|_|"truncated-frame")?;Ok(body)
}
fn send(shape:&str,id:&str,result:impl serde::Serialize)->Result<()> {
    let value=json!({"jsonrpc":"2.0","id":id,"result":result});
    if !schema(shape,&value) { return Err("invalid-response"); }
    let bytes=serde_json::to_vec(&value).map_err(|_|"encode-failed")?;
    if bytes.len()>65536{return Err("output-limit");}
    let mut out=io::stdout().lock();write!(out,"Content-Length: {}\r\n\r\n",bytes.len()).map_err(|_|"output-closed")?;
    out.write_all(&bytes).map_err(|_|"output-closed")?;out.flush().map_err(|_|"output-closed")
}
fn hello()->Hello {Hello{protocol:1,schema_digest:SCHEMA_DIGEST.into(),build_id:BUILD.into(),parser:"oxc-0.75.0".into(),checks:CHECKS.iter().map(|(id,v)|Requirement{id:(*id).into(),revision:*v}).collect()}}
// This finite JSON Schema subset is shared with Node; unknown schema features
// fail the build check rather than silently ignoring constraints.
fn conforms(value:&Value,s:&Value,defs:&Value)->bool {
    if let Some(r)=s.get("$ref").and_then(Value::as_str){return conforms(value,&defs[r.rsplit('/').next().unwrap()],defs);}
    if let Some(values)=s.get("enum").and_then(Value::as_array){if !values.contains(value){return false;}}
    match s["type"].as_str(){
        Some("object")=>{let Some(o)=value.as_object() else{return false;};let Some(p)=s["properties"].as_object() else{return false;};
            o.len()==p.len()&&p.iter().all(|(k,s)|o.get(k).is_some_and(|v|conforms(v,s,defs)))},
        Some("string")=>value.as_str().is_some_and(|v|{let n=v.chars().count() as u64;n>=s["minLength"].as_u64().unwrap_or(0)&&n<=s["maxLength"].as_u64().unwrap_or(u64::MAX)}),
        Some("integer")=>value.as_u64().is_some_and(|n|n>=s["minimum"].as_u64().unwrap_or(0)&&n<=s["maximum"].as_u64().unwrap_or(9007199254740991)),
        Some("array")=>value.as_array().is_some_and(|a|a.len() as u64>=s["minItems"].as_u64().unwrap_or(0)&&a.len() as u64<=s["maxItems"].as_u64().unwrap_or(u64::MAX)&&a.iter().all(|v|conforms(v,&s["items"],defs))),_=>false
    }
}
fn schema(name:&str,value:&Value)->bool{let s:Value=serde_json::from_str(SCHEMA).unwrap();conforms(value,&s["$defs"][name],&s["$defs"])}
fn input(a:&Artifact)->Result<String>{
    // Only inherited regular read-only descriptors 3..5. No user path, seek to
    // an OS path, socket, writable handle, mmap, environment or source execution.
    if !(3..=5).contains(&a.fd)||a.bytes==0||a.bytes>67108864||!hash(&a.sha256){return Err("invalid-input");}
    let mut file=unsafe{File::from_raw_fd(a.fd as i32)};
    let flags=unsafe{libc::fcntl(file.as_raw_fd(),libc::F_GETFL)};
    if flags<0||flags&libc::O_ACCMODE!=libc::O_RDONLY{return Err("fd-not-read-only");}
    let before=file.metadata().map_err(|_|"fd-unavailable")?;
    if !before.is_file()||before.len()!=a.bytes{return Err("fd-shape-mismatch");}
    let mut data=Vec::with_capacity(a.bytes as usize);(&mut file).take(a.bytes+1).read_to_end(&mut data).map_err(|_|"fd-read-failed")?;
    let after=file.metadata().map_err(|_|"fd-unavailable")?;
    if before.len()!=after.len()||before.ino()!=after.ino()||before.dev()!=after.dev()||before.mtime()!=after.mtime()||before.mtime_nsec()!=after.mtime_nsec()||before.ctime()!=after.ctime()||before.ctime_nsec()!=after.ctime_nsec()||data.len() as u64!=a.bytes||digest(&data)!=a.sha256{return Err("fd-digest-mismatch");}
    String::from_utf8(data).map_err(|_|"invalid-utf8")
}
fn limits()->Result<()> {
    #[cfg(target_os="linux")]
    unsafe {
        let parent=libc::getppid();if parent<=1{return Err("parent-gone");}
        if libc::prctl(libc::PR_SET_PDEATHSIG,libc::SIGKILL)!=0||libc::getppid()!=parent{return Err("parent-gone");}
        for (resource,value) in [(libc::RLIMIT_AS,1536u64*1024*1024),(libc::RLIMIT_CPU,30),(libc::RLIMIT_CORE,0)]{
            let limit=libc::rlimit{rlim_cur:value,rlim_max:value};if libc::setrlimit(resource,&limit)!=0{return Err("resource-limit-unavailable");}
        }Ok(())
    }
    #[cfg(not(target_os="linux"))] {Err("unsupported-platform")}
}
fn run()->Result<()> {
    limits()?;
    let mut stdin=io::stdin().lock();
    let first:InitializeRequest=serde_json::from_slice(&frame(&mut stdin)?).map_err(|_|"invalid-initialize")?;
    if !schema("InitializeRequest",&serde_json::to_value(&first).unwrap()){return Err("invalid-initialize");}
    if first.jsonrpc!="2.0"||first.method!="initialize"||!token(&first.id)||first.params.protocol!=1||first.params.schema_digest!=SCHEMA_DIGEST||first.params.build_id!=BUILD{return Err("incompatible-build");}
    send("HelloResponse",&first.id,hello())?;
    let request:AnalyzeRequest=serde_json::from_slice(&frame(&mut stdin)?).map_err(|_|"invalid-job")?;
    if !schema("AnalyzeRequest",&serde_json::to_value(&request).unwrap()){return Err("invalid-job");}
    let j=request.params;
    if request.jsonrpc!="2.0"||request.method!="analyze"||!token(&request.id)||request.id==first.id||!token(&j.job_id)||!token(&j.attempt_id)||!schema("Job",&serde_json::to_value(&j).unwrap()){return Err("invalid-job");}
    let mut roles=std::collections::HashSet::new();let mut fds=std::collections::HashSet::new();let mut checks=std::collections::HashSet::new();
    if j.artifacts.iter().any(|a|!roles.insert(a.role.as_str())||!fds.insert(a.fd))||!roles.contains("source")||j.checks.iter().any(|c|!checks.insert(c.id.as_str())){return Err("duplicate-identity");}
    let started=Instant::now();let requirements=j.checks.iter().map(|c|(c.id.clone(),c.revision)).collect::<Vec<_>>();
    let mut syntax=Vec::new();let mut findings=Vec::new();
    // Release each AST/arena before parsing the next artifact. Oxc types never
    // cross this boundary, and diagnostics never include private source snippets.
    for a in &j.artifacts{
        let text=input(a)?;let analysis=analyze(&text,a.role=="candidate",&requirements);
        syntax.push(Syntax{role:a.role.clone(),sha256:a.sha256.clone(),bytes:a.bytes,state:if analysis.valid{"valid"}else{"invalid"}.into(),diagnostics:analysis.diagnostics as u64,nodes:analysis.nodes as u64});
        for f in analysis.findings{findings.push(Finding{id:f.id,revision:f.revision,state:f.state.into(),code:f.code.into(),start:f.start as u64,end:f.end as u64});}
    }
    // Findings describe only candidate predicates. Source/companion syntax is
    // independent evidence; Node's health composition must retain any invalid
    // artifact as a failure, not erase it or mistake it for malformed protocol.
    if !roles.contains("candidate"){findings=j.checks.iter().map(|c|Finding{id:c.id.clone(),revision:c.revision,state:"unsupported".into(),code:"no-exact-candidate".into(),start:0,end:0}).collect();}
    let report=Report{job_id:j.job_id,attempt_id:j.attempt_id,schema_digest:SCHEMA_DIGEST.into(),build_id:BUILD.into(),syntax,findings,elapsed_ms:started.elapsed().as_millis() as u64};
    if !schema("Report",&serde_json::to_value(&report).unwrap()){return Err("invalid-report");}
    send("AnalyzeResponse",&request.id,report)
}
fn main(){
    std::panic::set_hook(Box::new(|_|eprintln!("verifier-panic")));
    if std::env::args().nth(1).as_deref()==Some("--identity"){println!("{}",serde_json::to_string(&hello()).unwrap());return;}
    if std::env::args().len()!=1{eprintln!("unsupported-argument");std::process::exit(2);}
    if let Err(code)=run(){eprintln!("{code}");std::process::exit(2);}
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn framing(){assert_eq!(frame(&mut io::Cursor::new(b"Content-Length: 2\r\n\r\n{}")),Ok(b"{}".to_vec()));for b in [b"Content-Length: 02\r\n\r\n{}".as_slice(),b"Content-Length: 2\r\n\r\n{",b"Content-Length: 2\r\nX: a\r\n\r\n{}"]{assert!(frame(&mut io::Cursor::new(b)).is_err());}}
    #[test] fn shared_wire_cases(){
        let cases:Value=serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/../../protocols/host-verifier/v1/cases/shapes.json"))).unwrap();
        for c in cases.as_array().unwrap(){assert_eq!(schema(c["definition"].as_str().unwrap(),&c["value"]),c["valid"].as_bool().unwrap(),"{}",c["name"]);}
    }
    #[test] fn wire_schema(){assert!(schema("Hello",&serde_json::to_value(hello()).unwrap()));let mut v=serde_json::to_value(hello()).unwrap();v["secret"]=json!("bad");assert!(!schema("Hello",&v));}
}
