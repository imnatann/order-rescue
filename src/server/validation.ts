import { z } from "zod";
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Gunakan huruf, angka, titik, garis bawah atau tanda hubung.",
  );
const text = z.string().trim().min(1).max(160);
const qty = z.number().int().min(0).max(1_000_000);
const money = z.number().int().min(0).max(1_000_000_000_000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T12:00:00Z`);
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, "Tanggal tidak valid.");
export const productSchema = z.object({ sku: identifier, name: text }).strict();
export const warehouseSchema = z
  .object({
    id: identifier.optional(),
    name: text,
    transferDays: z.number().int().min(0).max(365),
    shippingCostIdr: money,
  })
  .strict();
export const stockSchema = z
  .object({ warehouseId: identifier, sku: identifier, onHand: qty })
  .strict();
export const supplierSchema = z
  .object({
    id: identifier.optional(),
    name: text,
    active: z.boolean().default(true),
  })
  .strict();
export const offerSchema = z
  .object({
    id: identifier.optional(),
    supplierId: identifier,
    sku: identifier,
    available: qty,
    unitPriceIdr: money,
    leadTimeDays: z.number().int().min(0).max(365),
    shippingCostIdr: money,
    active: z.boolean().default(true),
  })
  .strict();
export const orderSchema = z
  .object({
    customer: text,
    dueDate: date,
    priority: z.enum(["high", "normal"]),
    allowPartial: z.boolean().default(false),
    lines: z
      .array(z.object({ sku: identifier, quantity: qty.min(1) }).strict())
      .min(1)
      .max(30),
  })
  .strict()
  .refine(
    (o) => new Set(o.lines.map((l) => l.sku)).size === o.lines.length,
    "SKU dalam pesanan harus unik.",
  );
export const constraintsSchema = z
  .object({
    orderIds: z.array(identifier).min(1).max(30),
    maxCostIdr: money,
    allowPartialDelivery: z.boolean(),
    autoExecute: z.boolean(),
    goal: z.string().trim().max(1500).default(""),
  })
  .strict()
  .refine(
    (c) => new Set(c.orderIds).size === c.orderIds.length,
    "Pesanan tidak boleh duplikat.",
  );
export const allocationSchema = z
  .object({
    lineId: identifier,
    kind: z.enum(["warehouse", "supplier"]),
    sourceId: identifier,
    quantity: qty.min(1),
  })
  .strict();
export const planSchema = z
  .object({
    summary: z.string().trim().min(1).max(3000),
    allocations: z.array(allocationSchema).min(1).max(200),
  })
  .strict();
export const loginSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(256),
  })
  .strict();
export const userSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    name: text,
    role: z.enum(["admin", "operator", "viewer"]),
    password: z.string().min(12).max(256),
  })
  .strict();
export const userUpdateSchema = z
  .object({
    name: text.optional(),
    role: z.enum(["admin", "operator", "viewer"]).optional(),
    active: z.boolean().optional(),
    password: z.string().min(12).max(256).optional(),
  })
  .strict();
export const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .strict();
