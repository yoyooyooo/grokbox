import { test,expect } from "bun:test";
import { mkdtemp,writeFile,readFile,rm,unlink,symlink,stat,utimes,chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readHostArtifacts } from "../src/internal/io/host-artifact-source.node.ts";
import { profileFromSource,applyPatchProfile } from "../src/internal/host/profile.ts";
import { SYNTHETIC_HOST,SYNTHETIC_SLICES } from "./synthetic-host.ts";
async function fixture(){const root=await mkdtemp(join(tmpdir(),"health-source-")),paths={source:join(root,"host.cjs"),worker:join(root,"worker.cjs"),profile:join(root,"profile.json")};
 const profile=profileFromSource(SYNTHETIC_HOST,SYNTHETIC_SLICES);await writeFile(paths.source,SYNTHETIC_HOST,{mode:0o600});await writeFile(paths.worker,"module.exports = {};\n",{mode:0o600});await writeFile(paths.profile,JSON.stringify(profile),{mode:0o600});return {root,paths,profile,close:()=>rm(root,{recursive:true,force:true})};}
test("source adapter passes only the real TS transform, with distinct source/candidate/companion identity",async()=>{const f=await fixture();try{
 const result=await readHostArtifacts(f.paths),expected=applyPatchProfile(SYNTHETIC_HOST,f.profile);expect(expected.ok).toBe(true);expect(result.applicability).toBe("exact");expect(Buffer.from(result.candidate!).toString()).toBe(expected.ok?expected.source:"");expect(result.sourceSha).toBe(f.profile.sourceSha256);expect(await result.current()).toBe(true);
 }finally{await f.close();}});
test("worker-only changes and same-size source changes invalidate old sets even after restoring mtime",async()=>{const f=await fixture();try{
 const first=await readHostArtifacts(f.paths);await writeFile(f.paths.worker,"module.exports = 42;\n",{mode:0o600});expect(await first.current()).toBe(false);const second=await readHostArtifacts(f.paths);expect(second.sourceSet).not.toBe(first.sourceSet);expect(second.sourceSha).toBe(first.sourceSha);
 const prior=await stat(f.paths.source),source=await readFile(f.paths.source,"utf8");const changed=source.replace("function","functioN");expect(changed.length).toBe(source.length);await writeFile(f.paths.source,changed);await utimes(f.paths.source,prior.atime,prior.mtime);
 expect(await second.current()).toBe(false);const third=await readHostArtifacts(f.paths);expect(third.sourceSha).not.toBe(second.sourceSha);expect(third.applicability).toBe("mismatch");expect(third.candidate).toBeNull();
 }finally{await f.close();}});
test("missing or invalid profile never invents a usable candidate, and profile appearance invalidates a missing-profile snapshot",async()=>{const f=await fixture();try{
 await unlink(f.paths.profile);const absent=await readHostArtifacts(f.paths);expect(absent.applicability).toBe("profile-unavailable");expect(absent.candidate).toBeNull();await writeFile(f.paths.profile,"{invalid}",{mode:0o600});expect(await absent.current()).toBe(false);const invalid=await readHostArtifacts(f.paths);expect(invalid.failureCode).toBe("invalid-profile");expect(invalid.candidate).toBeNull();
 }finally{await f.close();}});
test("symlinked source, unsafe file permissions and pre-aborted reads are rejected without source execution",async()=>{const f=await fixture();try{
 const target=join(f.root,"other.cjs");await writeFile(target,SYNTHETIC_HOST,{mode:0o600});await unlink(f.paths.source);await symlink(target,f.paths.source);await expect(readHostArtifacts(f.paths)).rejects.toBeDefined();await unlink(f.paths.source);await writeFile(f.paths.source,SYNTHETIC_HOST,{mode:0o600});await chmod(f.paths.source,0o666);await expect(readHostArtifacts(f.paths)).rejects.toBeDefined();
 const c=new AbortController();c.abort();await expect(readHostArtifacts(f.paths,c.signal)).rejects.toBeDefined();
 }finally{await f.close();}});
