declare module "sql.js/dist/sql-asm.js" {
  type Value = string | number | null | Uint8Array;
  type Params = Value[];
  export interface Statement {
    bind(values?: Params): boolean;
    step(): boolean;
    getAsObject(): Record<string, Value>;
    free(): boolean;
  }
  export interface Database {
    run(sql: string, params?: Params): Database;
    prepare(sql: string, params?: Params): Statement;
    export(): Uint8Array;
    close(): void;
  }
  export default function initSqlJs(config?: { printErr?: (text: string) => void }): Promise<{ Database: new (bytes?: Uint8Array) => Database }>;
}
