import { summarizePlan } from "./planning";
import "server-only";
import { all, exec, id, now, one, transaction } from "./db";
import { audit } from "./auth";
import { AppError } from "./errors";
import * as schema from "./validation";
import type {
  AuditEvent,
  Inventory,
  Offer,
  Order,
  OrderLine,
  Product,
  PurchaseOrder,
  Run,
  RunEvent,
  Snapshot,
  Warehouse,
} from "./types";

export const dataMode = (): "simulation" | "operations" =>
  process.env.DATA_MODE === "simulation" ? "simulation" : "operations";
export function products() {
  return all<Product>("SELECT sku,name FROM products ORDER BY sku LIMIT 1000");
}
export function warehouses() {
  return all<Warehouse>(
    "SELECT id,name,transfer_days transferDays,shipping_cost_idr shippingCostIdr FROM warehouses ORDER BY name LIMIT 200",
  );
}
export function inventory() {
  return all<Inventory>(
    "SELECT i.warehouse_id warehouseId,w.name warehouseName,i.sku,i.on_hand onHand,i.reserved,(i.on_hand-i.reserved) available,w.transfer_days transferDays,w.shipping_cost_idr shippingCostIdr FROM inventory i JOIN warehouses w ON w.id=i.warehouse_id ORDER BY i.sku,w.name LIMIT 5000",
  );
}
export function suppliers() {
  return all<{ id: string; name: string; active: number }>(
    "SELECT id,name,active FROM suppliers ORDER BY name LIMIT 1000",
  );
}
export function offers() {
  return all<Offer>(
    "SELECT o.id,o.supplier_id supplierId,s.name supplierName,o.sku,o.available,o.reserved,(o.available-o.reserved) remaining,o.unit_price_idr unitPriceIdr,o.lead_time_days leadTimeDays,o.shipping_cost_idr shippingCostIdr,CASE WHEN s.active=1 THEN o.active ELSE 0 END active FROM offers o JOIN suppliers s ON s.id=o.supplier_id ORDER BY s.name,o.sku LIMIT 5000",
  );
}
export function getOrder(orderId: string) {
  const order = one<Omit<Order, "lines">>(
    "SELECT id,customer,due_date dueDate,priority,allow_partial allowPartial,status,created_at createdAt FROM orders WHERE id=?",
    orderId,
  );
  if (!order) return null;
  const lines = all<OrderLine>(
    "SELECT l.id,l.sku,p.name productName,l.quantity,l.fulfilled,COALESCE((SELECT SUM(r.quantity) FROM reservations r WHERE r.line_id=l.id AND r.status='active'),0) allocated,l.quantity-l.fulfilled-COALESCE((SELECT SUM(r.quantity) FROM reservations r WHERE r.line_id=l.id AND r.status='active'),0) remaining FROM order_lines l JOIN products p ON p.sku=l.sku WHERE l.order_id=? ORDER BY l.id",
    orderId,
  );
  return { ...order, lines };
}
export function orders() {
  return all<{ id: string }>(
    "SELECT id FROM orders ORDER BY CASE WHEN status IN ('fulfilled','cancelled') THEN 1 ELSE 0 END,CASE priority WHEN 'high' THEN 0 ELSE 1 END,due_date,created_at DESC LIMIT 500",
  ).map((o) => getOrder(o.id)!);
}
export function recomputeOrder(orderId: string) {
  const order = getOrder(orderId);
  if (!order || order.status === "cancelled") return;
  const pending = one<{ n: number }>(
    "SELECT COUNT(*) n FROM reservations WHERE order_id=? AND status='active' AND warehouse_id IS NULL",
    orderId,
  )!.n;
  let status = "open";
  if (order.lines.every((l) => l.fulfilled === l.quantity))
    status = "fulfilled";
  else if (pending > 0) status = "awaiting_supply";
  else if (order.lines.every((l) => l.quantity - l.fulfilled === l.allocated))
    status = "reserved";
  else if (order.lines.some((l) => l.allocated > 0))
    status = "partially_reserved";
  else if (order.lines.some((l) => l.fulfilled > 0))
    status = "partially_fulfilled";
  exec("UPDATE orders SET status=? WHERE id=?", status, orderId);
}

type RawRun = Omit<Run, "constraints" | "plan" | "result"> & {
  constraintsJson: string;
  planJson: string | null;
  resultJson: string | null;
};
const runColumns =
  "id,user_id userId,status,constraints_json constraintsJson,plan_json planJson,result_json resultJson,error,attempt,created_at createdAt,updated_at updatedAt,lease_owner leaseOwner,lease_until leaseUntil,approved_by approvedBy,idempotency_key idempotencyKey";
function parseRun(row: RawRun): Run {
  const { constraintsJson, planJson, resultJson, ...rest } = row;
  return {
    ...rest,
    constraints: JSON.parse(constraintsJson),
    plan: planJson
      ? (() => {
          const plan = JSON.parse(planJson);
          return { ...plan, summary: summarizePlan(plan) };
        })()
      : null,
    result: resultJson ? JSON.parse(resultJson) : null,
  };
}
export function getRun(runId: string) {
  const row = one<RawRun>(`SELECT ${runColumns} FROM runs WHERE id=?`, runId);
  return row ? parseRun(row) : null;
}
export function runs() {
  return all<RawRun>(
    `SELECT ${runColumns} FROM runs ORDER BY created_at DESC LIMIT 100`,
  ).map(parseRun);
}
export function events(runId: string) {
  return all<
    RunEvent & { inputJson: string | null; outputJson: string | null }
  >(
    "SELECT id,run_id runId,type,name,status,input_json inputJson,output_json outputJson,duration_ms durationMs,created_at createdAt FROM run_events WHERE id IN (SELECT id FROM run_events WHERE run_id=? ORDER BY id DESC LIMIT 500) ORDER BY id",
    runId,
  ).map(({ inputJson, outputJson, ...rest }) => ({
    ...rest,
    input: inputJson ? JSON.parse(inputJson) : null,
    output: outputJson ? JSON.parse(outputJson) : null,
  }));
}
export function event(
  runId: string,
  type: string,
  name: string,
  status: string,
  input: unknown = null,
  output: unknown = null,
  durationMs: number | null = null,
) {
  exec(
    "INSERT INTO run_events(run_id,type,name,status,input_json,output_json,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?)",
    runId,
    type,
    name,
    status,
    JSON.stringify(input),
    JSON.stringify(output),
    durationMs,
    now(),
  );
}
export function purchaseOrders() {
  return all<PurchaseOrder>(
    "SELECT p.id,p.run_id runId,p.order_id orderId,p.supplier_name supplierName,p.sku,p.quantity,p.unit_price_idr unitPriceIdr,p.total_cost_idr totalCostIdr,p.status,p.created_at createdAt FROM purchase_orders p JOIN offers o ON o.id=p.offer_id JOIN suppliers s ON s.id=o.supplier_id ORDER BY p.created_at DESC LIMIT 500",
  );
}
export function auditEvents(before?: number) {
  return all<AuditEvent & { detailsJson: string | null }>(
    "SELECT id,actor_id actorId,action,entity_type entityType,entity_id entityId,details_json detailsJson,created_at createdAt FROM audit_events WHERE id<? ORDER BY id DESC LIMIT 100",
    before ?? Number.MAX_SAFE_INTEGER,
  ).map(({ detailsJson, ...rest }) => ({
    ...rest,
    details: detailsJson ? JSON.parse(detailsJson) : null,
  }));
}
export function workerHealthy() {
  return Boolean(
    one(
      "SELECT id FROM worker_heartbeats WHERE updated_at>? LIMIT 1",
      Date.now() - 30_000,
    ),
  );
}
export function snapshot(): Snapshot {
  return transaction(() => {
    const completed = one<{ n: number; avg: number | null }>(
      "SELECT COUNT(*) n,AVG((julianday(updated_at)-julianday(created_at))*86400) avg FROM runs WHERE status='completed'",
    )!;
    return {
      products: products(),
      warehouses: warehouses(),
      inventory: inventory(),
      offers: offers(),
      orders: orders(),
      runs: runs(),
      purchaseOrders: purchaseOrders(),
      mode: dataMode(),
      workerHealthy: workerHealthy(),
      metrics: {
        completedRuns: completed.n,
        averageRunSeconds: completed.avg,
        rescuedOrders: one<{ n: number }>(
          "SELECT COUNT(DISTINCT order_id) n FROM reservations WHERE status IN ('active','fulfilled')",
        )!.n,
        procurementCostIdr: one<{ n: number }>(
          "SELECT COALESCE(SUM(total_cost_idr),0) n FROM purchase_orders WHERE status!='cancelled'",
        )!.n,
        activeReservations: one<{ n: number }>(
          "SELECT COALESCE(SUM(quantity),0) n FROM reservations WHERE status='active'",
        )!.n,
      },
    };
  });
}

function exists(
  table: "products" | "warehouses" | "suppliers",
  key: string,
  value: string,
) {
  if (!one(`SELECT ${key} FROM ${table} WHERE ${key}=?`, value))
    throw new AppError(`${table}: referensi ${value} tidak ditemukan.`, 404);
}
export function saveResource(resource: string, raw: unknown, actorId: string) {
  return transaction(() => {
    let entityId = "";
    if (resource === "products") {
      const v = schema.productSchema.parse(raw);
      entityId = v.sku;
      exec(
        "INSERT INTO products(sku,name) VALUES(?,?) ON CONFLICT(sku) DO UPDATE SET name=excluded.name",
        v.sku,
        v.name,
      );
    } else if (resource === "warehouses") {
      const v = schema.warehouseSchema.parse(raw);
      entityId = v.id ?? id("WH");
      exec(
        "INSERT INTO warehouses(id,name,transfer_days,shipping_cost_idr) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,transfer_days=excluded.transfer_days,shipping_cost_idr=excluded.shipping_cost_idr",
        entityId,
        v.name,
        v.transferDays,
        v.shippingCostIdr,
      );
    } else if (resource === "inventory") {
      const v = schema.stockSchema.parse(raw);
      exists("warehouses", "id", v.warehouseId);
      exists("products", "sku", v.sku);
      entityId = `${v.warehouseId}/${v.sku}`;
      const current = one<{ reserved: number }>(
        "SELECT reserved FROM inventory WHERE warehouse_id=? AND sku=?",
        v.warehouseId,
        v.sku,
      );
      if (current && v.onHand < current.reserved)
        throw new AppError(
          "Stok fisik tidak boleh lebih kecil dari stok yang direservasi.",
          409,
        );
      exec(
        "INSERT INTO inventory(warehouse_id,sku,on_hand) VALUES(?,?,?) ON CONFLICT(warehouse_id,sku) DO UPDATE SET on_hand=excluded.on_hand",
        v.warehouseId,
        v.sku,
        v.onHand,
      );
    } else if (resource === "suppliers") {
      const v = schema.supplierSchema.parse(raw);
      entityId = v.id ?? id("SUP");
      if (
        !v.active &&
        one(
          "SELECT r.id FROM reservations r JOIN offers o ON o.id=r.offer_id WHERE o.supplier_id=? AND r.status='active' AND r.warehouse_id IS NULL LIMIT 1",
          entityId,
        )
      )
        throw new AppError(
          "Pemasok memiliki draft PO aktif. Batalkan pesanan terkait sebelum menonaktifkan pemasok.",
          409,
        );
      exec(
        "INSERT INTO suppliers(id,name,active) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active",
        entityId,
        v.name,
        Number(v.active),
      );
    } else if (resource === "offers") {
      const v = schema.offerSchema.parse(raw);
      exists("suppliers", "id", v.supplierId);
      exists("products", "sku", v.sku);
      entityId = v.id ?? id("OFF");
      const current = one<{
        reserved: number;
        supplierId: string;
        sku: string;
      }>(
        "SELECT reserved,supplier_id supplierId,sku FROM offers WHERE id=?",
        entityId,
      );
      if (
        current &&
        (current.reserved > v.available ||
          (current.reserved > 0 &&
            (!v.active ||
              current.sku !== v.sku ||
              current.supplierId !== v.supplierId)))
      )
        throw new AppError(
          "Penawaran memiliki reservasi aktif; batalkan pesanan terkait sebelum mengubah kapasitas atau menonaktifkannya.",
          409,
        );
      exec(
        "INSERT INTO offers(id,supplier_id,sku,available,unit_price_idr,lead_time_days,shipping_cost_idr,active) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET supplier_id=excluded.supplier_id,sku=excluded.sku,available=excluded.available,unit_price_idr=excluded.unit_price_idr,lead_time_days=excluded.lead_time_days,shipping_cost_idr=excluded.shipping_cost_idr,active=excluded.active",
        entityId,
        v.supplierId,
        v.sku,
        v.available,
        v.unitPriceIdr,
        v.leadTimeDays,
        v.shippingCostIdr,
        Number(v.active),
      );
    } else if (resource === "orders") {
      const v = schema.orderSchema.parse(raw);
      v.lines.forEach((l) => exists("products", "sku", l.sku));
      entityId = id("ORD");
      exec(
        "INSERT INTO orders(id,customer,due_date,priority,allow_partial,created_at) VALUES(?,?,?,?,?,?)",
        entityId,
        v.customer,
        v.dueDate,
        v.priority,
        Number(v.allowPartial),
        now(),
      );
      for (const line of v.lines)
        exec(
          "INSERT INTO order_lines(id,order_id,sku,quantity) VALUES(?,?,?,?)",
          id("LINE"),
          entityId,
          line.sku,
          line.quantity,
        );
    } else throw new AppError("Jenis data tidak ditemukan.", 404);
    audit(actorId, `${resource}.saved`, resource, entityId, raw);
    return { id: entityId };
  });
}
