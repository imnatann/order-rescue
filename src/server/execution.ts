import "server-only";
import { all, exec, id, now, one, transaction } from "./db";
import { audit, requireRole } from "./auth";
import { AppError } from "./errors";
import { constraintsSchema } from "./validation";
import {
  event,
  getOrder,
  getRun,
  inventory,
  offers,
  recomputeOrder,
} from "./store";
import { todayJakarta, validatePlan, type PlanningContext } from "./planning";
import type { Constraints, Run, User } from "./types";

export function contextFor(constraints: Constraints): PlanningContext {
  return {
    orders: constraints.orderIds
      .map((orderId) => getOrder(orderId))
      .filter((o) => o !== null),
    inventory: inventory(),
    offers: offers(),
    today: todayJakarta(),
  };
}
export function createRun(raw: unknown, user: User, idempotencyKey: string) {
  requireRole(user, ["admin", "operator"]);
  const constraints = constraintsSchema.parse(raw);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey))
    throw new AppError("Idempotency-Key wajib berisi 8–100 karakter aman.");
  return transaction(() => {
    const prior = one<{ id: string }>(
      "SELECT id FROM runs WHERE user_id=? AND idempotency_key=?",
      user.id,
      idempotencyKey,
    );
    if (prior) {
      const previous = getRun(prior.id)!;
      if (JSON.stringify(previous.constraints) !== JSON.stringify(constraints))
        throw new AppError(
          "Idempotency-Key sudah digunakan untuk parameter berbeda.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
      return previous;
    }
    for (const orderId of constraints.orderIds) {
      const order = getOrder(orderId);
      if (!order) throw new AppError("Pesanan tidak ditemukan.", 404);
      if (
        ["fulfilled", "cancelled"].includes(order.status) ||
        !order.lines.some((l) => l.remaining > 0)
      )
        throw new AppError(
          "Pesanan tidak memiliki kebutuhan yang belum dialokasikan.",
          409,
        );
    }
    const active = all<{ constraints_json: string }>(
      "SELECT constraints_json FROM runs WHERE status IN ('queued','planning','awaiting_approval','executing')",
    );
    if (
      active.some((r) =>
        (JSON.parse(r.constraints_json) as Constraints).orderIds.some((v) =>
          constraints.orderIds.includes(v),
        ),
      )
    )
      throw new AppError(
        "Pesanan sedang ditangani run lain. Selesaikan atau batalkan run tersebut.",
        409,
      );
    const runId = id("RUN");
    const timestamp = now();
    exec(
      "INSERT INTO runs(id,user_id,status,constraints_json,created_at,updated_at,idempotency_key) VALUES(?,?,'queued',?,?,?,?)",
      runId,
      user.id,
      JSON.stringify(constraints),
      timestamp,
      timestamp,
      idempotencyKey,
    );
    event(runId, "lifecycle", "run_queued", "success", constraints);
    audit(user.id, "run.created", "run", runId, constraints);
    return getRun(runId)!;
  });
}
export function approveRun(runId: string, user: User) {
  requireRole(user, ["admin", "operator"]);
  return transaction(() => {
    const run = getRun(runId);
    if (!run) throw new AppError("Run tidak ditemukan.", 404);
    if (run.status === "completed") return run;
    if (run.status !== "awaiting_approval" || !run.plan)
      throw new AppError("Run tidak sedang menunggu persetujuan.", 409);
    exec(
      "UPDATE runs SET status='queued',approved_by=?,updated_at=?,lease_owner=NULL,lease_until=0 WHERE id=?",
      user.id,
      now(),
      runId,
    );
    event(runId, "approval", "plan_approved", "success", {
      actor: user.id,
      totalCostIdr: run.plan.totalCostIdr,
    });
    audit(user.id, "run.approved", "run", runId, {
      totalCostIdr: run.plan.totalCostIdr,
    });
    return getRun(runId)!;
  });
}
export function cancelRun(runId: string, user: User) {
  requireRole(user, ["admin", "operator"]);
  return transaction(() => {
    const run = getRun(runId);
    if (!run) throw new AppError("Run tidak ditemukan.", 404);
    if (run.status === "cancelled") return run;
    if (run.status === "completed")
      throw new AppError(
        "Run telah dieksekusi. Kelola reservasi melalui pembatalan pesanan.",
        409,
      );
    exec(
      "UPDATE runs SET status='cancelled',lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?",
      now(),
      runId,
    );
    event(runId, "lifecycle", "run_cancelled", "success", { actor: user.id });
    audit(user.id, "run.cancelled", "run", runId);
    return getRun(runId)!;
  });
}
export function retryRun(runId: string, user: User) {
  requireRole(user, ["admin", "operator"]);
  return transaction(() => {
    const run = getRun(runId);
    if (!run) throw new AppError("Run tidak ditemukan.", 404);
    if (!["failed", "needs_attention", "cancelled"].includes(run.status))
      throw new AppError("Run belum dapat dicoba ulang.", 409);
    if (one("SELECT id FROM reservations WHERE run_id=? LIMIT 1", runId))
      throw new AppError(
        "Run sudah memiliki jejak eksekusi; buat run baru untuk kebutuhan tersisa.",
        409,
      );
    const active = all<{ id: string; constraints: string }>(
      "SELECT id,constraints_json constraints FROM runs WHERE id!=? AND status IN ('queued','planning','awaiting_approval','executing')",
      runId,
    );
    if (
      active.some((r) =>
        (JSON.parse(r.constraints) as Constraints).orderIds.some((v) =>
          run.constraints.orderIds.includes(v),
        ),
      )
    )
      throw new AppError("Pesanan sedang ditangani run lain.", 409);
    for (const orderId of run.constraints.orderIds) {
      const order = getOrder(orderId);
      if (
        !order ||
        ["fulfilled", "cancelled"].includes(order.status) ||
        !order.lines.some((l) => l.remaining > 0)
      )
        throw new AppError("Pesanan tidak memiliki kebutuhan tersisa.", 409);
    }
    exec(
      "UPDATE runs SET status='queued',attempt=0,plan_json=NULL,result_json=NULL,error=NULL,approved_by=NULL,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?",
      now(),
      runId,
    );
    event(runId, "lifecycle", "run_retried", "success", { actor: user.id });
    audit(user.id, "run.retried", "run", runId);
    return getRun(runId)!;
  });
}
export function claimRun(workerId: string): Run | null {
  return transaction(() => {
    const current = Date.now();
    const stale = all<{ id: string; attempt: number }>(
      "SELECT id,attempt FROM runs WHERE status IN ('planning','executing') AND lease_until<?",
      current,
    );
    for (const run of stale) {
      exec(
        "UPDATE runs SET status=?,lease_owner=NULL,lease_until=0,error=?,updated_at=? WHERE id=?",
        run.attempt >= 3 ? "failed" : "queued",
        run.attempt >= 3
          ? "Batas pemulihan proses tercapai; coba ulang secara manual."
          : null,
        now(),
        run.id,
      );
      event(run.id, "lifecycle", "worker_recovered", "success", null, {
        attempt: run.attempt,
      });
    }
    const next = one<{ id: string }>(
      "SELECT id FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1",
    );
    if (!next) return null;
    const run = getRun(next.id)!;
    const execution = Boolean(
      run.plan && (run.approvedBy || run.constraints.autoExecute),
    );
    if (!execution && run.attempt >= 3) {
      exec(
        "UPDATE runs SET status='needs_attention',error='Batas percobaan rencana tercapai.',updated_at=? WHERE id=?",
        now(),
        run.id,
      );
      return null;
    }
    exec(
      "UPDATE runs SET status=?,attempt=attempt+?,lease_owner=?,lease_until=?,updated_at=? WHERE id=?",
      execution ? "executing" : "planning",
      execution ? 0 : 1,
      workerId,
      current + 120_000,
      now(),
      run.id,
    );
    event(
      run.id,
      "lifecycle",
      execution ? "execution_started" : "planning_started",
      "running",
      null,
      { workerId },
    );
    return getRun(run.id)!;
  });
}
export function ownsLease(runId: string, workerId: string) {
  return Boolean(
    one(
      "SELECT id FROM runs WHERE id=? AND lease_owner=? AND status IN ('planning','executing') AND lease_until>?",
      runId,
      workerId,
      Date.now(),
    ),
  );
}
export function savePlan(runId: string, workerId: string, raw: unknown) {
  return transaction(() => {
    const run = getRun(runId);
    if (!run || run.status !== "planning" || !ownsLease(runId, workerId))
      throw new AppError(
        "Run telah dihentikan atau lease kedaluwarsa.",
        409,
        "LEASE_LOST",
      );
    const plan = validatePlan(
      raw,
      run.constraints,
      contextFor(run.constraints),
    );
    exec(
      "UPDATE runs SET status=?,plan_json=?,error=NULL,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?",
      run.constraints.autoExecute ? "queued" : "awaiting_approval",
      JSON.stringify(plan),
      now(),
      runId,
    );
    event(runId, "plan", "plan_validated", "success", null, plan);
    return plan;
  });
}
export function executeRun(runId: string, workerId: string) {
  try {
    return transaction(() => {
      const run = getRun(runId);
      if (!run) throw new AppError("Run tidak ditemukan.", 404);
      if (run.status === "completed") return run.result;
      if (
        run.status !== "executing" ||
        !run.plan ||
        !ownsLease(runId, workerId)
      )
        throw new AppError("Lease eksekusi tidak berlaku.", 409, "LEASE_LOST");
      const actor = one<User>(
        "SELECT id,email,name,role,active,created_at createdAt FROM users WHERE id=?",
        run.approvedBy ?? run.userId,
      );
      if (!actor?.active)
        throw new AppError(
          "Pengguna yang mengotorisasi run sudah tidak aktif.",
          403,
        );
      requireRole(actor, ["admin", "operator"]);
      const owner = one<{ active: number; role: string }>(
        "SELECT active,role FROM users WHERE id=?",
        run.userId,
      );
      if (!owner?.active || owner.role === "viewer")
        throw new AppError(
          "Pemilik run tidak lagi memiliki izin eksekusi.",
          403,
        );
      const plan = validatePlan(
        {
          summary: run.plan.summary,
          allocations: run.plan.allocations.map(
            ({ lineId, kind, sourceId, quantity }) => ({
              lineId,
              kind,
              sourceId,
              quantity,
            }),
          ),
        },
        run.constraints,
        contextFor(run.constraints),
      );
      if (
        run.approvedBy &&
        (plan.totalCostIdr > run.plan.totalCostIdr ||
          plan.allocations.some(
            (a, i) => a.sourceName !== run.plan!.allocations[i]?.sourceName,
          ))
      )
        throw new AppError(
          "Biaya atau sumber berubah setelah persetujuan; rencana perlu diperiksa kembali.",
          409,
          "STALE_PLAN",
        );
      const reservations: string[] = [];
      const purchaseOrders: string[] = [];
      for (const a of plan.allocations) {
        const reservationId = id("RSV");
        if (a.kind === "warehouse") {
          const updated = exec(
            "UPDATE inventory SET reserved=reserved+? WHERE warehouse_id=? AND sku=? AND on_hand-reserved>=?",
            a.quantity,
            a.sourceId,
            a.sku,
            a.quantity,
          );
          if (updated.changes !== 1)
            throw new AppError(
              "Stok berubah saat reservasi.",
              409,
              "STALE_PLAN",
            );
          exec(
            "INSERT INTO reservations(id,run_id,order_id,line_id,warehouse_id,quantity,status,created_at) VALUES(?,?,?,?,?,?,'active',?)",
            reservationId,
            runId,
            a.orderId,
            a.lineId,
            a.sourceId,
            a.quantity,
            now(),
          );
        } else {
          const updated = exec(
            "UPDATE offers SET reserved=reserved+? WHERE id=? AND active=1 AND available-reserved>=?",
            a.quantity,
            a.sourceId,
            a.quantity,
          );
          if (updated.changes !== 1)
            throw new AppError(
              "Penawaran berubah saat reservasi.",
              409,
              "STALE_PLAN",
            );
          exec(
            "INSERT INTO reservations(id,run_id,order_id,line_id,offer_id,quantity,status,created_at) VALUES(?,?,?,?,?,?,'active',?)",
            reservationId,
            runId,
            a.orderId,
            a.lineId,
            a.sourceId,
            a.quantity,
            now(),
          );
          const poId = id("PO");
          exec(
            "INSERT INTO purchase_orders(id,run_id,order_id,reservation_id,offer_id,sku,quantity,unit_price_idr,total_cost_idr,status,created_at,supplier_name) VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?)",
            poId,
            runId,
            a.orderId,
            reservationId,
            a.sourceId,
            a.sku,
            a.quantity,
            a.unitPriceIdr,
            a.totalCostIdr,
            now(),
            a.sourceName,
          );
          purchaseOrders.push(poId);
        }
        reservations.push(reservationId);
      }
      for (const orderId of run.constraints.orderIds) recomputeOrder(orderId);
      const actual = one<{ units: number; count: number }>(
        "SELECT COALESCE(SUM(quantity),0) units,COUNT(*) count FROM reservations WHERE run_id=? AND status='active'",
        runId,
      )!;
      const expectedUnits = plan.allocations.reduce(
        (sum, a) => sum + a.quantity,
        0,
      );
      const actualPurchases = one<{ n: number }>(
        "SELECT COUNT(*) n FROM purchase_orders WHERE run_id=? AND status='draft'",
        runId,
      )!.n;
      if (
        actual.units !== expectedUnits ||
        actual.count !== reservations.length ||
        actualPurchases !== purchaseOrders.length
      )
        throw new AppError(
          "Verifikasi hasil eksekusi tidak sesuai rencana; transaksi dibatalkan.",
          409,
          "VERIFICATION_FAILED",
        );
      event(
        runId,
        "tool",
        "verify_outcome",
        "success",
        {
          expectedUnits,
          expectedReservations: reservations.length,
          expectedPurchaseOrders: purchaseOrders.length,
        },
        {
          actualUnits: actual.units,
          actualReservations: actual.count,
          actualPurchaseOrders: actualPurchases,
        },
      );
      const result = {
        reservationIds: reservations,
        purchaseOrderIds: purchaseOrders,
        totalCostIdr: plan.totalCostIdr,
        allocatedUnits: plan.allocations.reduce(
          (sum, a) => sum + a.quantity,
          0,
        ),
        externalPurchaseSubmitted: false,
        verified: true,
      };
      exec(
        "UPDATE runs SET status='completed',plan_json=?,result_json=?,error=NULL,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?",
        JSON.stringify(plan),
        JSON.stringify(result),
        now(),
        runId,
      );
      event(
        runId,
        "execution",
        "reservations_committed",
        "success",
        null,
        result,
      );
      audit(actor.id, "run.executed", "run", runId, result);
      return result;
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "LEASE_LOST") return null;
    transaction(() => {
      const run = getRun(runId);
      if (!run || run.status !== "executing" || run.leaseOwner !== workerId)
        return;
      const replan =
        error instanceof AppError &&
        [
          "STALE_PLAN",
          "DEADLINE_VIOLATION",
          "INCOMPLETE_PLAN",
          "BUDGET_VIOLATION",
        ].includes(error.code) &&
        run.attempt < 3;
      const message =
        error instanceof AppError
          ? error.message
          : "Eksekusi gagal; seluruh perubahan transaksi dibatalkan.";
      exec(
        "UPDATE runs SET status=?,plan_json=NULL,approved_by=NULL,error=?,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?",
        replan ? "queued" : "needs_attention",
        message,
        now(),
        runId,
      );
      event(
        runId,
        "execution",
        replan ? "replan_required" : "execution_failed",
        "error",
        null,
        { message },
      );
    });
    return null;
  }
}
export function failRun(runId: string, workerId: string, message: string) {
  transaction(() => {
    const updated = exec(
      "UPDATE runs SET status='failed',error=?,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=? AND lease_owner=? AND status IN ('planning','executing')",
      message.slice(0, 500),
      now(),
      runId,
      workerId,
    );
    if (updated.changes)
      event(runId, "lifecycle", "run_failed", "error", null, {
        message: message.slice(0, 500),
      });
  });
}
export function receivePurchase(poId: string, warehouseId: string, user: User) {
  requireRole(user, ["admin", "operator"]);
  return transaction(() => {
    const po = one<{
      id: string;
      status: string;
      reservationId: string;
      orderId: string;
      offerId: string;
      sku: string;
      quantity: number;
    }>(
      "SELECT id,status,reservation_id reservationId,order_id orderId,offer_id offerId,sku,quantity FROM purchase_orders WHERE id=?",
      poId,
    );
    if (!po) throw new AppError("PO tidak ditemukan.", 404);
    if (po.status === "received") return { id: poId, status: "received" };
    if (po.status !== "draft") throw new AppError("PO sudah dibatalkan.", 409);
    if (!one("SELECT id FROM warehouses WHERE id=?", warehouseId))
      throw new AppError("Gudang penerima tidak ditemukan.", 404);
    const changed = exec(
      "UPDATE offers SET available=available-?,reserved=reserved-? WHERE id=? AND reserved>=? AND available>=?",
      po.quantity,
      po.quantity,
      po.offerId,
      po.quantity,
      po.quantity,
    );
    if (changed.changes !== 1)
      throw new AppError("Kapasitas reservasi pemasok tidak konsisten.", 409);
    exec(
      "INSERT INTO inventory(warehouse_id,sku,on_hand,reserved) VALUES(?,?,?,?) ON CONFLICT(warehouse_id,sku) DO UPDATE SET on_hand=on_hand+excluded.on_hand,reserved=reserved+excluded.reserved",
      warehouseId,
      po.sku,
      po.quantity,
      po.quantity,
    );
    exec(
      "UPDATE reservations SET warehouse_id=? WHERE id=? AND status='active'",
      warehouseId,
      po.reservationId,
    );
    exec(
      "UPDATE purchase_orders SET status='received',received_at=? WHERE id=?",
      now(),
      poId,
    );
    recomputeOrder(po.orderId);
    audit(user.id, "purchase.received", "purchase", poId, {
      warehouseId,
      quantity: po.quantity,
    });
    return { id: poId, status: "received" };
  });
}
export function shipOrder(orderId: string, user: User) {
  requireRole(user, ["admin", "operator"]);
  return transaction(() => {
    const order = getOrder(orderId);
    if (!order) throw new AppError("Pesanan tidak ditemukan.", 404);
    if (order.status === "fulfilled")
      return { id: orderId, status: "fulfilled" };
    if (order.status === "cancelled")
      throw new AppError("Pesanan sudah dibatalkan.", 409);
    const ready = all<{
      id: string;
      lineId: string;
      warehouseId: string;
      sku: string;
      quantity: number;
    }>(
      "SELECT r.id,r.line_id lineId,r.warehouse_id warehouseId,l.sku,r.quantity FROM reservations r JOIN order_lines l ON l.id=r.line_id WHERE r.order_id=? AND r.status='active' AND r.warehouse_id IS NOT NULL",
      orderId,
    );
    if (!ready.length) throw new AppError("Belum ada stok siap dikirim.", 409);
    if (
      !order.allowPartial &&
      order.lines.some(
        (l) =>
          ready
            .filter((r) => r.lineId === l.id)
            .reduce((sum, r) => sum + r.quantity, 0) !==
          l.quantity - l.fulfilled,
      )
    )
      throw new AppError(
        "Pesanan tidak mengizinkan pengiriman parsial. Terima seluruh pasokan terlebih dahulu.",
        409,
      );
    for (const row of ready) {
      const changed = exec(
        "UPDATE inventory SET on_hand=on_hand-?,reserved=reserved-? WHERE warehouse_id=? AND sku=? AND on_hand>=? AND reserved>=?",
        row.quantity,
        row.quantity,
        row.warehouseId,
        row.sku,
        row.quantity,
        row.quantity,
      );
      if (changed.changes !== 1)
        throw new AppError("Stok reservasi tidak konsisten.", 409);
      exec(
        "UPDATE order_lines SET fulfilled=fulfilled+? WHERE id=?",
        row.quantity,
        row.lineId,
      );
      exec("UPDATE reservations SET status='fulfilled' WHERE id=?", row.id);
    }
    recomputeOrder(orderId);
    audit(user.id, "order.shipped", "order", orderId, {
      units: ready.reduce((sum, r) => sum + r.quantity, 0),
    });
    return { id: orderId, status: getOrder(orderId)!.status };
  });
}
export function cancelOrder(orderId: string, user: User) {
  requireRole(user, ["admin", "operator"]);
  return transaction(() => {
    const order = getOrder(orderId);
    if (!order) throw new AppError("Pesanan tidak ditemukan.", 404);
    if (order.status === "cancelled")
      return { id: orderId, status: "cancelled" };
    if (order.status === "fulfilled")
      throw new AppError("Pesanan selesai tidak dapat dibatalkan.", 409);
    const reservations = all<{
      id: string;
      warehouseId: string | null;
      offerId: string | null;
      quantity: number;
      sku: string;
    }>(
      "SELECT r.id,r.warehouse_id warehouseId,r.offer_id offerId,r.quantity,l.sku FROM reservations r JOIN order_lines l ON l.id=r.line_id WHERE r.order_id=? AND r.status='active'",
      orderId,
    );
    for (const r of reservations) {
      if (r.warehouseId)
        exec(
          "UPDATE inventory SET reserved=reserved-? WHERE warehouse_id=? AND sku=?",
          r.quantity,
          r.warehouseId,
          r.sku,
        );
      else if (r.offerId)
        exec(
          "UPDATE offers SET reserved=reserved-? WHERE id=?",
          r.quantity,
          r.offerId,
        );
      exec("UPDATE reservations SET status='released' WHERE id=?", r.id);
    }
    exec(
      "UPDATE purchase_orders SET status='cancelled' WHERE order_id=? AND status='draft'",
      orderId,
    );
    exec("UPDATE orders SET status='cancelled' WHERE id=?", orderId);
    const active = all<{ id: string; constraints: string }>(
      "SELECT id,constraints_json constraints FROM runs WHERE status IN ('queued','planning','awaiting_approval','executing')",
    );
    for (const run of active)
      if (
        (JSON.parse(run.constraints) as Constraints).orderIds.includes(orderId)
      ) {
        exec(
          "UPDATE runs SET status='cancelled',lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?",
          now(),
          run.id,
        );
        event(run.id, "lifecycle", "order_cancelled", "success", { orderId });
      }
    audit(user.id, "order.cancelled", "order", orderId, {
      released: reservations.length,
    });
    return { id: orderId, status: "cancelled" };
  });
}

/** Mark a supplier offer unavailable and recover unreceived, committed allocations. */
export function failOffer(offerId: string, user: User) {
  requireRole(user, ["admin", "operator"]);
  return transaction(() => {
    const offer = offers().find((o) => o.id === offerId);
    if (!offer) throw new AppError("Penawaran tidak ditemukan.", 404);
    exec("UPDATE offers SET active=0 WHERE id=?", offerId);
    const affected = all<{ runId: string }>(
      "SELECT DISTINCT run_id runId FROM reservations WHERE offer_id=? AND warehouse_id IS NULL AND status='active'",
      offerId,
    );
    const recoveryRunIds: string[] = [];
    for (const { runId } of affected) {
      const prior = getRun(runId)!;
      const held = all<{
        id: string;
        warehouseId: string | null;
        offerId: string | null;
        sku: string;
        quantity: number;
      }>(
        "SELECT r.id,r.warehouse_id warehouseId,r.offer_id offerId,l.sku,r.quantity FROM reservations r JOIN order_lines l ON l.id=r.line_id WHERE r.run_id=? AND r.status='active'",
        runId,
      );
      for (const r of held) {
        if (r.warehouseId)
          exec(
            "UPDATE inventory SET reserved=reserved-? WHERE warehouse_id=? AND sku=?",
            r.quantity,
            r.warehouseId,
            r.sku,
          );
        else if (r.offerId)
          exec(
            "UPDATE offers SET reserved=reserved-? WHERE id=?",
            r.quantity,
            r.offerId,
          );
        exec("UPDATE reservations SET status='released' WHERE id=?", r.id);
      }
      exec(
        "UPDATE purchase_orders SET status='cancelled' WHERE run_id=? AND status='draft'",
        runId,
      );
      for (const orderId of prior.constraints.orderIds) recomputeOrder(orderId);
      const remainingIds = prior.constraints.orderIds.filter((orderId) => {
        const order = getOrder(orderId);
        return (
          order &&
          !["fulfilled", "cancelled"].includes(order.status) &&
          order.lines.some((l) => l.remaining > 0)
        );
      });
      const incurred = one<{ cost: number }>(
        "SELECT COALESCE(SUM(total_cost_idr),0) cost FROM purchase_orders WHERE run_id=? AND status='received'",
        runId,
      )!.cost;
      const spentWarehouseFees = (prior.plan?.allocations ?? [])
        .filter(
          (a) =>
            a.kind === "warehouse" &&
            one(
              "SELECT id FROM reservations WHERE run_id=? AND line_id=? AND warehouse_id=? AND status='fulfilled'",
              runId,
              a.lineId,
              a.sourceId,
            ),
        )
        .reduce((sum, a) => sum + a.shippingCostIdr, 0);
      const conflict = all<{ constraints: string }>(
        "SELECT constraints_json constraints FROM runs WHERE id!=? AND status IN ('queued','planning','awaiting_approval','executing')",
        runId,
      ).some((r) =>
        (JSON.parse(r.constraints) as Constraints).orderIds.some((v) =>
          remainingIds.includes(v),
        ),
      );
      let recoveryId: string | null = null;
      if (remainingIds.length && !conflict) {
        recoveryId = id("RUN");
        const timestamp = now();
        const constraints: Constraints = {
          ...prior.constraints,
          orderIds: remainingIds,
          maxCostIdr: Math.max(
            0,
            prior.constraints.maxCostIdr - incurred - spentWarehouseFees,
          ),
          goal: `${prior.constraints.goal.slice(0, 1000)}\nPulihkan kebutuhan tersisa setelah penawaran ${offerId} gagal. Biaya yang sudah terjadi telah dikurangi dari anggaran.`,
        };
        exec(
          "INSERT INTO runs(id,user_id,status,constraints_json,created_at,updated_at,idempotency_key) VALUES(?,?,'queued',?,?,?,?)",
          recoveryId,
          user.id,
          JSON.stringify(constraints),
          timestamp,
          timestamp,
          `recovery_${runId}_${offerId}`,
        );
        event(
          recoveryId,
          "lifecycle",
          "recovery_queued",
          "success",
          {
            parentRunId: runId,
            failedOfferId: offerId,
            incurredCostIdr: incurred + spentWarehouseFees,
          },
          constraints,
        );
        recoveryRunIds.push(recoveryId);
      }
      exec(
        "UPDATE runs SET status=?,result_json=?,error=?,lease_owner=NULL,lease_until=0,updated_at=? WHERE id=?",
        recoveryId ? "superseded" : "needs_attention",
        JSON.stringify({
          ...prior.result,
          released: true,
          recoveryRunId: recoveryId,
        }),
        recoveryId
          ? `Pasokan gagal; alokasi aktif dilepas dan dipulihkan oleh ${recoveryId}.`
          : "Pasokan gagal; alokasi dilepas. Selesaikan run lain sebelum memulai rescue kebutuhan tersisa.",
        now(),
        runId,
      );
      event(
        runId,
        "execution",
        "supplier_failure_recovered",
        "success",
        { offerId },
        {
          releasedReservations: held.length,
          recoveryRunId: recoveryId,
          incurredCostIdr: incurred + spentWarehouseFees,
        },
      );
    }
    audit(user.id, "offer.failed", "offer", offerId, {
      affectedRuns: affected.map((r) => r.runId),
      recoveryRunIds,
    });
    return { offerId, recoveryRunIds };
  });
}
