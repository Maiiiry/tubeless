import { describe, expect, it } from "vitest";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";

describe("fake Durable Object storage", () => {
  it.each([
    "BEGIN",
    "COMMIT",
    "SAVEPOINT s",
    "PRAGMA user_version",
    "PRAGMA journal_mode",
    "/* c */ BEGIN",
    "-- c\nCOMMIT",
  ])("rejects transaction control: %s", (query) => {
    const { sql } = createFakeDurableStorage();
    expect(() => sql.exec(query)).toThrow(/transactionSync/);
  });

  it("rejects multi-statement input but accepts a trigger body containing semicolons", () => {
    const { sql } = createFakeDurableStorage();
    expect(() => sql.exec("CREATE TABLE a(x); CREATE TABLE b(y)")).toThrow(/one statement/);
    expect(() => sql.exec("SELECT 1; -- trailing comment")).not.toThrow();
    expect(() => sql.exec("SELECT ';' AS semi")).not.toThrow();
    sql.exec("CREATE TABLE t(x)");
    sql.exec("CREATE TABLE log(x)");
    expect(() =>
      sql.exec(
        `CREATE TRIGGER t_ai AFTER INSERT ON t
         BEGIN
           INSERT INTO log(x) VALUES (new.x);
           INSERT INTO log(x) VALUES (new.x);
         END`
      )
    ).not.toThrow();
    sql.exec("INSERT INTO t(x) VALUES (1)");
    expect(sql.exec("SELECT count(*) AS n FROM log").toArray()).toEqual([{ n: 2 }]);
    expect(() =>
      sql.exec("CREATE TRIGGER t_bi BEFORE INSERT ON t BEGIN SELECT 1; END; SELECT 2")
    ).toThrow(/one statement/);
  });

  it("allows at most 100 bound parameters", () => {
    const { sql } = createFakeDurableStorage();
    const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");
    const values = (count: number) => Array.from({ length: count }, (_, index) => index);
    expect(() => sql.exec(`SELECT ${placeholders(100)}`, ...values(100))).not.toThrow();
    expect(() => sql.exec(`SELECT ${placeholders(101)}`, ...values(101))).toThrow(/too many/);
  });

  it("returns the transaction value and rolls back every write when it throws", () => {
    const storage = createFakeDurableStorage();
    storage.sql.exec("CREATE TABLE t(x)");
    expect(
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO t(x) VALUES (1)");
        return "ok";
      })
    ).toBe("ok");
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO t(x) VALUES (2)");
        storage.sql.exec("INSERT INTO t(x) VALUES (3)");
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(storage.sql.exec("SELECT x FROM t").toArray()).toEqual([{ x: 1 }]);
  });

  it("round-trips values and tracks the alarm", async () => {
    const storage = createFakeDurableStorage();
    await storage.put("k", { a: 1 });
    expect(await storage.get("k")).toEqual({ a: 1 });
    expect(await storage.get("missing")).toBeUndefined();
    expect(storage.alarmAtMs()).toBeUndefined();
    await storage.setAlarm(123);
    expect(storage.alarmAtMs()).toBe(123);
    await storage.deleteAlarm();
    expect(storage.alarmAtMs()).toBeUndefined();
  });

  it("clears tables and values on deleteAll", async () => {
    const storage = createFakeDurableStorage();
    storage.sql.exec("CREATE TABLE t(x)");
    await storage.put("k", 1);
    await storage.deleteAll();
    expect(() => storage.sql.exec("SELECT x FROM t")).toThrow();
    expect(await storage.get("k")).toBeUndefined();
  });
});
