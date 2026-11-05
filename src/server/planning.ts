import type {
  Constraints,
  Inventory,
  Offer,
  Order,
  Plan,
  PlanInput,
  Allocation,
} from "./types";
import { AppError } from "./errors";
import { planSchema } from "./validation";
export type PlanningContext = {
  orders: Order[];
  inventory: Inventory[];
  offers: Offer[];
  today: string;
};
export function todayJakarta(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Jakarta",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function summarizePlan(
  plan: Pick<Plan, "allocations" | "coverage" | "totalCostIdr">,
) {
  const units = plan.allocations.reduce((sum, a) => sum + a.quantity, 0);
  const needed = plan.coverage.reduce((sum, c) => sum + c.required, 0);
  const orders = new Set(plan.coverage.map((c) => c.orderId)).size;
  const latest =
    plan.allocations
      .map((a) => a.arrivalDate)
      .sort()
      .at(-1) ?? "—";
  const cost = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(plan.totalCostIdr);
  return `${units} dari ${needed} unit kebutuhan tersisa dialokasikan untuk ${orders} pesanan melalui ${plan.allocations.length} alokasi sumber. Total pengadaan dan pengiriman ${cost}. Estimasi tiba paling lambat ${latest}, berdasarkan lead time dan kapasitas pada saat validasi.`;
}
export function validatePlan(
  raw: unknown,
  constraints: Constraints,
  context: PlanningContext,
): Plan {
  const input = planSchema.parse(raw);
  const selected = context.orders.filter((o) =>
    constraints.orderIds.includes(o.id),
  );
  if (selected.length !== constraints.orderIds.length)
    throw new AppError(
      "Satu atau lebih pesanan tidak ditemukan.",
      409,
      "STALE_PLAN",
    );
  if (selected.some((o) => ["fulfilled", "cancelled"].includes(o.status)))
    throw new AppError(
      "Pesanan sudah selesai atau dibatalkan.",
      409,
      "STALE_PLAN",
    );
  const lines = new Map(
    selected.flatMap((order) =>
      order.lines.map((line) => [line.id, { order, line }] as const),
    ),
  );
  const counts = new Map<string, number>();
  const used = new Map<string, number>();
  const fees = new Set<string>();
  const duplicates = new Set<string>();
  const allocations: Allocation[] = [];
  let total = 0;
  for (const a of input.allocations) {
    const detail = lines.get(a.lineId);
    if (!detail || detail.line.remaining <= 0)
      throw new AppError(
        "Alokasi mengacu ke baris yang tidak membutuhkan barang.",
        409,
        "STALE_PLAN",
      );
    const { order, line } = detail;
    const unique = `${a.lineId}/${a.kind}/${a.sourceId}`;
    if (duplicates.has(unique))
      throw new AppError("Sumber alokasi duplikat pada baris pesanan.");
    duplicates.add(unique);
    let available: number,
      unitPriceIdr: number,
      shippingCostIdr: number,
      days: number,
      sourceName: string;
    if (a.kind === "warehouse") {
      const stock = context.inventory.find(
        (s) => s.warehouseId === a.sourceId && s.sku === line.sku,
      );
      if (!stock)
        throw new AppError(
          "Sumber stok gudang tidak ditemukan.",
          409,
          "STALE_PLAN",
        );
      available = stock.available;
      unitPriceIdr = 0;
      shippingCostIdr = stock.shippingCostIdr;
      days = stock.transferDays;
      sourceName = stock.warehouseName;
    } else {
      const offer = context.offers.find(
        (s) => s.id === a.sourceId && s.sku === line.sku && s.active,
      );
      if (!offer)
        throw new AppError(
          "Penawaran pemasok sudah tidak aktif atau tidak sesuai SKU.",
          409,
          "STALE_PLAN",
        );
      available = offer.remaining;
      unitPriceIdr = offer.unitPriceIdr;
      shippingCostIdr = offer.shippingCostIdr;
      days = offer.leadTimeDays;
      sourceName = offer.supplierName;
    }
    const stockKey = `${a.kind}/${a.sourceId}/${line.sku}`;
    const cumulative = (used.get(stockKey) ?? 0) + a.quantity;
    if (cumulative > available)
      throw new AppError(
        `Kapasitas ${sourceName} tidak mencukupi; perlu rencana baru.`,
        409,
        "STALE_PLAN",
      );
    used.set(stockKey, cumulative);
    const arrivalDate = addDays(context.today, days);
    if (arrivalDate > order.dueDate)
      throw new AppError(
        `Estimasi tiba melewati tenggat ${order.customer}.`,
        409,
        "DEADLINE_VIOLATION",
      );
    const allocated = (counts.get(line.id) ?? 0) + a.quantity;
    if (allocated > line.remaining)
      throw new AppError("Alokasi melebihi kebutuhan tersisa.");
    counts.set(line.id, allocated);
    // One shipment fee per source and order, even when it serves several order lines.
    const feeKey = `${a.kind}/${a.sourceId}/${order.id}`;
    const fee = fees.has(feeKey) ? 0 : shippingCostIdr;
    fees.add(feeKey);
    const totalCostIdr = a.quantity * unitPriceIdr + fee;
    total += totalCostIdr;
    if (!Number.isSafeInteger(total) || total > constraints.maxCostIdr)
      throw new AppError(
        "Rencana melampaui anggaran pengadaan dan pengiriman.",
        409,
        "BUDGET_VIOLATION",
      );
    allocations.push({
      ...a,
      orderId: order.id,
      sku: line.sku,
      sourceName,
      unitPriceIdr,
      shippingCostIdr: fee,
      totalCostIdr,
      arrivalDate,
    });
  }
  const coverage = selected.flatMap((order) =>
    order.lines
      .filter((line) => line.remaining > 0)
      .map((line) => {
        const allocated = counts.get(line.id) ?? 0;
        if (
          allocated !== line.remaining &&
          (!constraints.allowPartialDelivery || !order.allowPartial)
        )
          throw new AppError(
            `Kebutuhan ${order.customer}/${line.sku} belum terpenuhi seluruhnya.`,
            409,
            "INCOMPLETE_PLAN",
          );
        return {
          orderId: order.id,
          lineId: line.id,
          required: line.remaining,
          allocated,
        };
      }),
  );
  if (!coverage.length || !allocations.length)
    throw new AppError(
      "Tidak ada kebutuhan tersisa untuk direservasi.",
      409,
      "STALE_PLAN",
    );
  const plan = {
    summary: input.summary,
    allocations,
    totalCostIdr: total,
    coverage,
    validatedAt: new Date().toISOString(),
  };
  // Show code-derived totals in approvals. The model's original summary remains in tool evidence.
  return { ...plan, summary: summarizePlan(plan) };
}

export function candidatePlan(
  constraints: Constraints,
  context: PlanningContext,
) {
  const stockLeft = new Map(
    context.inventory.map((s) => [`${s.warehouseId}/${s.sku}`, s.available]),
  );
  const offerLeft = new Map(context.offers.map((s) => [s.id, s.remaining]));
  const allocations: PlanInput["allocations"] = [];
  const issues: string[] = [];
  const selected = context.orders
    .filter((o) => constraints.orderIds.includes(o.id))
    .sort(
      (a, b) =>
        (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1) ||
        a.dueDate.localeCompare(b.dueDate),
    );
  for (const order of selected)
    for (const line of order.lines) {
      let needed = line.remaining;
      for (const stock of context.inventory
        .filter(
          (s) =>
            s.sku === line.sku &&
            addDays(context.today, s.transferDays) <= order.dueDate,
        )
        .sort((a, b) => a.shippingCostIdr - b.shippingCostIdr)) {
        const key = `${stock.warehouseId}/${stock.sku}`;
        const quantity = Math.min(needed, stockLeft.get(key) ?? 0);
        if (quantity > 0) {
          allocations.push({
            lineId: line.id,
            kind: "warehouse",
            sourceId: stock.warehouseId,
            quantity,
          });
          stockLeft.set(key, (stockLeft.get(key) ?? 0) - quantity);
          needed -= quantity;
        }
        if (!needed) break;
      }
      for (const offer of context.offers
        .filter(
          (s) =>
            s.active &&
            s.sku === line.sku &&
            addDays(context.today, s.leadTimeDays) <= order.dueDate,
        )
        .sort(
          (a, b) =>
            a.unitPriceIdr +
            a.shippingCostIdr /
              Math.max(1, Math.min(needed, offerLeft.get(a.id) ?? 0)) -
            (b.unitPriceIdr +
              b.shippingCostIdr /
                Math.max(1, Math.min(needed, offerLeft.get(b.id) ?? 0))),
        )) {
        const quantity = Math.min(needed, offerLeft.get(offer.id) ?? 0);
        if (quantity > 0) {
          allocations.push({
            lineId: line.id,
            kind: "supplier",
            sourceId: offer.id,
            quantity,
          });
          offerLeft.set(offer.id, (offerLeft.get(offer.id) ?? 0) - quantity);
          needed -= quantity;
        }
        if (!needed) break;
      }
      if (needed > 0)
        issues.push(
          `${order.id}/${line.sku}: kekurangan ${needed} unit yang dapat tiba sebelum tenggat.`,
        );
    }
  const draft: PlanInput = {
    summary:
      "Kandidat berbasis prioritas pesanan, ketersediaan, dan tenggat. Periksa biaya serta alternatif sebelum memilih.",
    allocations,
  };
  try {
    return {
      candidate: draft,
      validation: validatePlan(draft, constraints, context),
      issues,
      optimalityGuaranteed: false,
    };
  } catch (error) {
    return {
      candidate: draft,
      issues: [
        ...issues,
        error instanceof Error ? error.message : "Validasi gagal.",
      ],
      valid: false,
      optimalityGuaranteed: false,
    };
  }
}
