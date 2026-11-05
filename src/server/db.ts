import "server-only";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 2;
let instance: DatabaseSync | undefined;
export const dbPath = () =>
  resolve(
    /* turbopackIgnore: true */ process.env.DATABASE_PATH ||
      "data/order-rescue.sqlite",
  );
export function db() {
  if (instance) return instance;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const connection = new DatabaseSync(path);
  connection.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
  );
  migrate(connection);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* permissions can be volume-managed */
  }
  instance = connection;
  return connection;
}
export function closeDb() {
  instance?.close();
  instance = undefined;
}
export function all<T>(
  sql: string,
  ...params: (string | number | null)[]
): T[] {
  // node:sqlite rows have null prototypes; normalize at the DB boundary for React RSC.
  return db()
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row })) as unknown as T[];
}
export function one<T>(
  sql: string,
  ...params: (string | number | null)[]
): T | undefined {
  const row = db()
    .prepare(sql)
    .get(...params);
  return row ? ({ ...row } as unknown as T) : undefined;
}
export function exec(sql: string, ...params: (string | number | null)[]) {
  return db()
    .prepare(sql)
    .run(...params);
}
export function transaction<T>(fn: () => T): T {
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}
export const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 12)}`;
export const now = () => new Date().toISOString();

function migrate(connection: DatabaseSync) {
  connection.exec("BEGIN IMMEDIATE");
  try {
    const version = (
      connection.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;
    if (version > SCHEMA_VERSION)
      throw new Error(
        "Database schema is newer than this application; upgrade the application.",
      );
    if (version === 0)
      connection.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),password_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),created_at TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX sessions_expiry ON sessions(expires_at);
      CREATE TABLE rate_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE products (sku TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE warehouses (id TEXT PRIMARY KEY,name TEXT NOT NULL,transfer_days INTEGER NOT NULL CHECK(transfer_days>=0),shipping_cost_idr INTEGER NOT NULL CHECK(shipping_cost_idr>=0));
      CREATE TABLE inventory (warehouse_id TEXT NOT NULL REFERENCES warehouses(id),sku TEXT NOT NULL REFERENCES products(sku),on_hand INTEGER NOT NULL CHECK(on_hand>=0),reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=on_hand),PRIMARY KEY(warehouse_id,sku));
      CREATE TABLE suppliers (id TEXT PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
      CREATE TABLE offers (id TEXT PRIMARY KEY,supplier_id TEXT NOT NULL REFERENCES suppliers(id),sku TEXT NOT NULL REFERENCES products(sku),available INTEGER NOT NULL CHECK(available>=0),reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=available),unit_price_idr INTEGER NOT NULL CHECK(unit_price_idr>=0),lead_time_days INTEGER NOT NULL CHECK(lead_time_days>=0),shipping_cost_idr INTEGER NOT NULL CHECK(shipping_cost_idr>=0),active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
      CREATE TABLE orders (id TEXT PRIMARY KEY,customer TEXT NOT NULL,due_date TEXT NOT NULL,priority TEXT NOT NULL CHECK(priority IN ('high','normal')),allow_partial INTEGER NOT NULL CHECK(allow_partial IN (0,1)),status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL);
      CREATE TABLE order_lines (id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES orders(id),sku TEXT NOT NULL REFERENCES products(sku),quantity INTEGER NOT NULL CHECK(quantity>0),fulfilled INTEGER NOT NULL DEFAULT 0 CHECK(fulfilled>=0 AND fulfilled<=quantity),UNIQUE(order_id,sku));
      CREATE TABLE runs (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL,constraints_json TEXT NOT NULL,plan_json TEXT,result_json TEXT,error TEXT,attempt INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,approved_by TEXT REFERENCES users(id),idempotency_key TEXT NOT NULL,UNIQUE(user_id,idempotency_key));
      CREATE INDEX runs_queue ON runs(status,created_at);
      CREATE TABLE run_events (id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),type TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,input_json TEXT,output_json TEXT,duration_ms INTEGER,created_at TEXT NOT NULL);
      CREATE INDEX run_events_run ON run_events(run_id,id);
      CREATE TABLE reservations (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),order_id TEXT NOT NULL REFERENCES orders(id),line_id TEXT NOT NULL REFERENCES order_lines(id),warehouse_id TEXT REFERENCES warehouses(id),offer_id TEXT REFERENCES offers(id),quantity INTEGER NOT NULL CHECK(quantity>0),status TEXT NOT NULL CHECK(status IN ('active','released','fulfilled')),created_at TEXT NOT NULL,UNIQUE(run_id,line_id,warehouse_id,offer_id));
      CREATE INDEX reservations_order ON reservations(order_id,status);
      CREATE TABLE purchase_orders (id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),order_id TEXT NOT NULL REFERENCES orders(id),reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),offer_id TEXT NOT NULL REFERENCES offers(id),sku TEXT NOT NULL REFERENCES products(sku),quantity INTEGER NOT NULL,unit_price_idr INTEGER NOT NULL,total_cost_idr INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','received','cancelled')),created_at TEXT NOT NULL,received_at TEXT);
      CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,details_json TEXT,created_at TEXT NOT NULL);
      CREATE INDEX audit_created ON audit_events(id DESC);
      CREATE TABLE worker_heartbeats (id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL);
      PRAGMA user_version=1;
    `);
    if (version <= 1)
      connection.exec(`
      ALTER TABLE purchase_orders ADD COLUMN supplier_name TEXT NOT NULL DEFAULT '';
      UPDATE purchase_orders SET supplier_name=COALESCE((SELECT s.name FROM offers o JOIN suppliers s ON s.id=o.supplier_id WHERE o.id=purchase_orders.offer_id),'');
      PRAGMA user_version=2;
    `);
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    connection.close();
    throw error;
  }
}
