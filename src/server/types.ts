export type Role = "admin" | "operator" | "viewer";
export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: number;
  createdAt: string;
};
export type Product = { sku: string; name: string };
export type Warehouse = {
  id: string;
  name: string;
  transferDays: number;
  shippingCostIdr: number;
};
export type Inventory = {
  warehouseId: string;
  warehouseName: string;
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
  transferDays: number;
  shippingCostIdr: number;
};
export type Offer = {
  id: string;
  supplierId: string;
  supplierName: string;
  sku: string;
  available: number;
  reserved: number;
  remaining: number;
  unitPriceIdr: number;
  leadTimeDays: number;
  shippingCostIdr: number;
  active: number;
};
export type OrderLine = {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  fulfilled: number;
  allocated: number;
  remaining: number;
};
export type Order = {
  id: string;
  customer: string;
  dueDate: string;
  priority: "high" | "normal";
  allowPartial: number;
  status: string;
  createdAt: string;
  lines: OrderLine[];
};
export type AllocationInput = {
  lineId: string;
  kind: "warehouse" | "supplier";
  sourceId: string;
  quantity: number;
};
export type PlanInput = { summary: string; allocations: AllocationInput[] };
export type Allocation = AllocationInput & {
  orderId: string;
  sku: string;
  sourceName: string;
  unitPriceIdr: number;
  shippingCostIdr: number;
  totalCostIdr: number;
  arrivalDate: string;
};
export type Plan = {
  summary: string;
  allocations: Allocation[];
  totalCostIdr: number;
  coverage: {
    orderId: string;
    lineId: string;
    required: number;
    allocated: number;
  }[];
  validatedAt: string;
};
export type Constraints = {
  orderIds: string[];
  maxCostIdr: number;
  allowPartialDelivery: boolean;
  autoExecute: boolean;
  goal: string;
};
export type RunStatus =
  | "queued"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "needs_attention"
  | "failed"
  | "cancelled"
  | "superseded";
export type Run = {
  id: string;
  userId: string;
  status: RunStatus;
  constraints: Constraints;
  plan: Plan | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  leaseOwner: string | null;
  leaseUntil: number;
  approvedBy: string | null;
  idempotencyKey: string;
};
export type RunEvent = {
  id: number;
  runId: string;
  type: string;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  durationMs: number | null;
  createdAt: string;
};
export type PurchaseOrder = {
  id: string;
  runId: string;
  orderId: string;
  supplierName: string;
  sku: string;
  quantity: number;
  unitPriceIdr: number;
  totalCostIdr: number;
  status: string;
  createdAt: string;
};
export type AuditEvent = {
  id: number;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: unknown;
  createdAt: string;
};
export type Snapshot = {
  products: Product[];
  warehouses: Warehouse[];
  inventory: Inventory[];
  offers: Offer[];
  orders: Order[];
  runs: Run[];
  purchaseOrders: PurchaseOrder[];
  metrics: {
    completedRuns: number;
    rescuedOrders: number;
    procurementCostIdr: number;
    activeReservations: number;
    averageRunSeconds: number | null;
  };
  mode: "simulation" | "operations";
  workerHealthy: boolean;
};
