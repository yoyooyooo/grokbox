import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type sqlite from "sqlite3";
export type SqlValue=string|number|null;
export type SqlRow=Record<string,string|number|null|Uint8Array>;
/** Native busy_timeout sleeps on a libuv worker. Concurrent read-only waiters
 * can occupy the pool needed by the writer's COMMIT. Retry only settled reads
 * on OPEN_READONLY handles, yielding between attempts with the same 1s bound.
 * No transaction callback, write/COMMIT, LOCKED or unknown result is replayed. */
async function waitReadLock<A>(read:()=>Promise<A>):Promise<A>{
 const deadline=performance.now()+1000;
 for(let attempt=0;;attempt++){
  try{return await read();}catch(error){
   const remaining=deadline-performance.now();
   if((error as NodeJS.ErrnoException)?.code!=="SQLITE_BUSY"||remaining<=0||attempt>=100)throw error;
   await new Promise<void>(resolve=>setTimeout(resolve,Math.min(10,Math.ceil(remaining))));
  }
 }
}
/** Native disk SQLite, not a JS image or an execution ledger. Async callbacks
 * stay below the monitor Effect owner. Never imported by the Host/preload. */
export class MonitorSqlite {
  constructor(private readonly database:sqlite.Database,private readonly readOnly=false){}
  run(sql:string,params:SqlValue[]=[]):Promise<void>{return new Promise((resolve,reject)=>{
    const done=(error:Error|null)=>error?reject(error):resolve();
    if(params.length)this.database.run(sql,params,done);else this.database.exec(sql,done);
  });}
  all(sql:string,params:SqlValue[]=[]):Promise<SqlRow[]>{
   const values=[...params];
   const read=()=>new Promise<SqlRow[]>((resolve,reject)=>this.database.all(sql,values,(error,rows:SqlRow[])=>error?reject(error):resolve(rows)));
   return this.readOnly?waitReadLock(read):read();
  }
  async first(sql:string,params:SqlValue[]=[]):Promise<SqlRow|null>{return (await this.all(sql,params))[0]??null;}
  close():Promise<void>{return new Promise((resolve,reject)=>this.database.close(error=>error?reject(error):resolve()));}
}
export async function privateMonitorDirectory(path:string,create=false):Promise<void>{
 if(create)await mkdir(path,{recursive:true,mode:0o700});
 const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw Error("monitor_path_unsafe");
}
export async function openMonitorSqlite(file:string,mode:"read"|"write"|"create"):Promise<MonitorSqlite>{
 await privateMonitorDirectory(dirname(file));
 if(mode==="create"){const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.close();}
 const before=await lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||(before.mode&0o077)!==0||(process.getuid&&before.uid!==process.getuid()))throw Error("monitor_store_unsafe");
 const native=await import("sqlite3");const api=native.default;
 const db=await new Promise<sqlite.Database>((resolve,reject)=>{
   const connection=new api.Database(file,mode==="read"?api.OPEN_READONLY:api.OPEN_READWRITE,error=>error?reject(error):resolve(connection));
 });
 const connection=new MonitorSqlite(db,mode==="read");
 try{
   const after=await lstat(file);if(after.dev!==before.dev||after.ino!==before.ino||after.isSymbolicLink())throw Error("monitor_store_changed");
   db.configure("busyTimeout",mode==="read"?0:1000);
   // Rollback-journal disk transactions preserve strict read-only opens without
   // creating WAL/SHM files. Writers touch changed pages, never export the DB.
   // Admission reserves the DELETE rollback journal, not unconstrained temp
   // files elsewhere on the filesystem. These pragmas are connection-local;
   // never change an existing journal mode merely to make a budget look valid.
   const configure=()=>connection.run("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096;");
   if(mode==="read")await waitReadLock(configure);else await configure();
   if(mode!=="read"){
    const journal=await connection.first("PRAGMA journal_mode");
    if(journal?.journal_mode!=="delete")throw Error("monitor_journal_mode_unsupported");
    await connection.run("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
   }
   return connection;
 }catch(error){await connection.close();throw error;}
}
