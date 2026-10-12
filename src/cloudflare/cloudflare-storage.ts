/** Structural subset of Durable Object SqlStorage used by Tubeless. */
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** Structural subset of DurableObjectStorage used by Tubeless. */
export interface DurableStorageLike {
  readonly sql: SqlStorageLike;
  transactionSync<T>(fn: () => T): T;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTimeMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}
