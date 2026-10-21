export interface DurableSQLStorage {
  sql: {
    exec(
      query: string,
      ...bindings: (string | number | null | ArrayBuffer | ArrayBufferView)[]
    ): { toArray(): Record<string, unknown>[]; next(): IteratorResult<Record<string, unknown>> };
  };
  transactionSync<T>(callback: () => T): T;
}
export interface SQLMigration {
  version: number;
  sql: string;
}
