import { lstat, readdir, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { DESKTOP_POLICY, DESKTOP_SHA, DesktopError, validDesktopOperation, type DesktopOperation } from "@grokbox/runtime-kernel/desktop";
import { assertSafeDirectory, readConfigFile, publishConfigFile } from "./config-layout.node.ts";
import { acquireConfigurationLease } from "./config-lock.node.ts";
type RecordValue={schemaVersion:1;key:string;principalId:string;digest:string;receipt:DesktopOperation};
const fail=(code:ConstructorParameters<typeof DesktopError>[0],message:string):never=>{throw new DesktopError(code,message);};
const missing=(e:unknown)=>(e as NodeJS.ErrnoException)?.code==="ENOENT";
export function desktopOperationKey(installation:string,principal:string,requestId:string){return sha256Text(canonicalJson(["desktop-operation-v1",installation,principal,requestId]));}
/** Necessary desktop replay guards, using the existing protected file publisher
 * and configuration lease. No TTL deletes an unresolved display action. */
export function openDesktopStore(rootValue:string,installation:string){
  const root=resolve(rootValue),directory=join(root,"state/desktop"),identity=sha256Text(canonicalJson([root,installation]));
  const exists=async(path:string)=>lstat(path).then(()=>true).catch(e=>{if(missing(e))return false;throw e;});
  async function validate(){
    if(!await exists(directory))return false;await assertSafeDirectory(directory);
    const marker=await readConfigFile(join(directory,"identity.json"));
    if(!marker||typeof marker!=="object"||Object.keys(marker).sort().join()!=="identity,schemaVersion"||(marker as any).schemaVersion!==1||(marker as any).identity!==identity)return fail("source_unavailable","The desktop safety store is missing or unsupported; it was not replaced.");return true;
  }
  async function initialize(){
    if(await validate())return;
    await assertSafeDirectory(join(root,"state"),true);await mkdir(directory,{mode:0o700});
    await publishConfigFile(join(directory,"identity.json"),{schemaVersion:1,identity});
  }
  function decode(value:unknown,key:string):RecordValue{
    if(!value||typeof value!=="object"||Object.keys(value).sort().join()!=="digest,key,principalId,receipt,schemaVersion")return fail("source_unavailable","Invalid desktop safety record.");
    const r=value as RecordValue;
    if(r.schemaVersion!==1||r.key!==key||!DESKTOP_SHA.test(r.digest)||typeof r.principalId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(r.principalId)||!validDesktopOperation(r.receipt,installation)||r.receipt.operationRef!==`desktop-operation:${installation}:${key}`||desktopOperationKey(installation,r.principalId,r.receipt.requestId)!==key)return fail("source_unavailable","The desktop safety identity is corrupt or unsupported.");return r;
  }
  async function record(key:string):Promise<RecordValue|null>{
    if(!DESKTOP_SHA.test(key))return fail("invalid_input","Invalid desktop operation locator.");
    const path=join(directory,key);if(!await exists(path))return null;await assertSafeDirectory(path);
    return decode(await readConfigFile(join(path,"receipt.json")),key);
  }
  async function all(){
    if(!await validate())return [];
    const entries=await readdir(directory,{withFileTypes:true}),rows:RecordValue[]=[];
    if(entries.length>DESKTOP_POLICY.maxOperations+1)return fail("store_full","Desktop safety capacity exceeded; no identities were evicted.");
    for(const e of entries){if(e.name==="identity.json")continue;if(!e.isDirectory()||!DESKTOP_SHA.test(e.name))return fail("source_unavailable","Unexpected desktop safety footprint; it was preserved.");const row=await record(e.name);if(!row)return fail("source_unavailable","A desktop safety footprint lost its receipt.");rows.push(row);}return rows;
  }
  const read=async(key:string)=>await validate()?record(key):null;
  return {read,
    reserve:async(principalId:string,digest:string,receipt:DesktopOperation)=>{
      const key=desktopOperationKey(installation,principalId,receipt.requestId),lease=await acquireConfigurationLease(root);
      try{await initialize();const prior=await record(key);if(prior){if(prior.digest!==digest)return fail("idempotency_conflict","The original desktop request has different input.");return {created:false,receipt:prior.receipt};}
        const rows=await all();if(rows.length>=DESKTOP_POLICY.maxOperations)return fail("store_full","Desktop safety capacity is full.");
        if(rows.some(r=>r.receipt.state==="unknown"&&r.receipt.rows.some(x=>receipt.rows.some(y=>y.display===x.display))))return fail("operation_unknown","An unresolved original action protects this display. A new identity cannot authorize another stop.");
        const row:RecordValue={schemaVersion:1,key,principalId,digest,receipt};decode(row,key);
        await mkdir(join(directory,key),{mode:0o700});
        try{await publishConfigFile(join(directory,key,"receipt.json"),row);}catch{return fail("operation_unknown","Desktop admission publication is uncertain; its footprint was preserved.");}
        return {created:true,receipt};
      }finally{await lease.release();}
    },
    publish:async(principalId:string,receipt:DesktopOperation)=>{
      const key=desktopOperationKey(installation,principalId,receipt.requestId),lease=await acquireConfigurationLease(root);
      try{if(!await validate())return fail("operation_unknown","The original desktop safety store is missing.");const old=await record(key);if(!old)return fail("operation_unknown","The original desktop receipt is missing.");
        const before=old.receipt;if(before.expectedRevision!==receipt.expectedRevision||before.acceptedAtMs!==receipt.acceptedAtMs||before.origin!==receipt.origin||canonicalJson(before.rows.map(({display,agentId,identity})=>({display,agentId,identity})))!==canonicalJson(receipt.rows.map(({display,agentId,identity})=>({display,agentId,identity}))))return fail("idempotency_conflict","The original desktop candidate set changed.");
        if(before.state!=="unknown"){if(canonicalJson(before)!==canonicalJson(receipt))return fail("idempotency_conflict","A settled desktop receipt cannot be overwritten.");return before;}
        for (let index = 0; index < before.rows.length; index++) {
          const previous = before.rows[index]!, nextRow = receipt.rows[index]!;
          const allowed = previous.state === "planned" ? ["planned", "dispatching", "refused"] : previous.state === "dispatching" ? ["dispatching", "stopped", "refused", "unknown"] : [previous.state];
          if (!allowed.includes(nextRow.state)) return fail("idempotency_conflict", "A desktop row cannot regress or reinterpret its original unknown effect.");
        }
        const next={...old,receipt};decode(next,key);
        try{await publishConfigFile(join(directory,key,"receipt.json"),next);}catch{return fail("operation_unknown","The desktop settlement has no verified publication acknowledgement.");}return receipt;
      }finally{await lease.release();}
    },
  };
}
