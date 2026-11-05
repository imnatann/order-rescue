import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, exec, now } from "../src/server/db";
import { saveResource, getOrder } from "../src/server/store";
import { addDays, todayJakarta } from "../src/server/planning";
import type { Constraints, User } from "../src/server/types";
let directory = "";
export const admin: User = {
  id: "USR-admin",
  email: "admin@example.test",
  name: "Test Admin",
  role: "admin",
  active: 1,
  createdAt: "2026-01-01T00:00:00Z",
};
export function setup() {
  closeDb();
  directory = mkdtempSync(join(tmpdir(), "order-rescue-test-"));
  process.env.DATABASE_PATH = join(directory, "test.sqlite");
  process.env.APP_URL = "http://127.0.0.1:3000";
  process.env.DATA_MODE = "simulation";
  exec(
    "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    admin.id,
    admin.email,
    admin.name,
    admin.role,
    "unused",
    now(),
  );
  saveResource("products", { sku: "CUP", name: "Cups" }, admin.id);
  saveResource(
    "warehouses",
    {
      id: "WH-1",
      name: "Local warehouse",
      transferDays: 0,
      shippingCostIdr: 0,
    },
    admin.id,
  );
  saveResource(
    "warehouses",
    {
      id: "WH-2",
      name: "Remote warehouse",
      transferDays: 1,
      shippingCostIdr: 5000,
    },
    admin.id,
  );
  saveResource(
    "inventory",
    { warehouseId: "WH-1", sku: "CUP", onHand: 100 },
    admin.id,
  );
  saveResource(
    "inventory",
    { warehouseId: "WH-2", sku: "CUP", onHand: 50 },
    admin.id,
  );
  saveResource(
    "suppliers",
    { id: "SUP-1", name: "Supplier one", active: true },
    admin.id,
  );
  saveResource(
    "suppliers",
    { id: "SUP-2", name: "Supplier two", active: true },
    admin.id,
  );
  saveResource(
    "offers",
    {
      id: "OFF-1",
      supplierId: "SUP-1",
      sku: "CUP",
      available: 500,
      unitPriceIdr: 800,
      leadTimeDays: 1,
      shippingCostIdr: 10000,
      active: true,
    },
    admin.id,
  );
  saveResource(
    "offers",
    {
      id: "OFF-2",
      supplierId: "SUP-2",
      sku: "CUP",
      available: 500,
      unitPriceIdr: 900,
      leadTimeDays: 1,
      shippingCostIdr: 5000,
      active: true,
    },
    admin.id,
  );
  return directory;
}
export function cleanup() {
  closeDb();
  if (directory) rmSync(directory, { recursive: true, force: true });
}
export function order(quantity = 300, partial = false) {
  const result = saveResource(
    "orders",
    {
      customer: "Test Customer",
      dueDate: addDays(todayJakarta(), 3),
      priority: "high",
      allowPartial: partial,
      lines: [{ sku: "CUP", quantity }],
    },
    admin.id,
  );
  return getOrder(result.id)!;
}
export function constraints(
  orderIds: string[],
  overrides: Partial<Constraints> = {},
): Constraints {
  return {
    orderIds,
    maxCostIdr: 500000,
    allowPartialDelivery: false,
    autoExecute: false,
    goal: "Fulfill test orders",
    ...overrides,
  };
}
