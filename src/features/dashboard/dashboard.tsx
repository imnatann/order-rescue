"use client";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type FormEvent,
} from "react";
import { Button } from "@/components/namurui/button";
import { ToolCallCard } from "@/components/namurui/tool-call-card";
import type {
  AuditEvent,
  Order,
  Run,
  RunEvent,
  Snapshot,
  User,
} from "@/server/types";

type Workspace = Snapshot & {
  suppliers: { id: string; name: string; active: number }[];
  llmConfigured: boolean;
};
type View =
  | "overview"
  | "orders"
  | "inventory"
  | "suppliers"
  | "runs"
  | "purchases"
  | "audit"
  | "settings";
type Field = {
  key: string;
  label: string;
  type?:
    "text" | "number" | "email" | "password" | "date" | "checkbox" | "select";
  options?: { value: string; label: string }[];
  required?: boolean;
  min?: number;
  max?: number;
};
type Editor = {
  title: string;
  resource?: string;
  url?: string;
  method?: string;
  fields: Field[];
  values: Record<string, unknown>;
};
const money = (n: number) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);
const day = (s: string) =>
  new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Jakarta",
  }).format(new Date(s.length === 10 ? `${s}T12:00:00Z` : s));
const statuses: Record<string, string> = {
  open: "Terbuka",
  awaiting_supply: "Menunggu pasokan",
  reserved: "Siap dikirim",
  partially_reserved: "Reservasi parsial",
  partially_fulfilled: "Terkirim sebagian",
  fulfilled: "Selesai",
  cancelled: "Dibatalkan",
  queued: "Dalam antrean",
  planning: "Menyusun rencana",
  awaiting_approval: "Perlu persetujuan",
  executing: "Mengeksekusi",
  completed: "Selesai",
  needs_attention: "Perlu perhatian",
  failed: "Gagal",
  superseded: "Digantikan run pemulihan",
  draft: "Draft PO",
  received: "Diterima",
};
const working = (r: Run) =>
  ["queued", "planning", "executing"].includes(r.status);
async function api<T>(
  url: string,
  body?: unknown,
  method = "POST",
  extra: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : method,
    headers: {
      ...(body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Requested-With": "OrderRescue",
          }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(100_000),
  });
  const result = await response.json();
  if (response.status === 401) {
    window.location.assign(new URL("/login", window.location.origin).href);
    throw new Error("Sesi berakhir. Silakan masuk kembali.");
  }
  if (!response.ok) throw new Error(result.error || "Permintaan gagal.");
  return result;
}
function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      width={small ? 18 : 26}
      height={small ? 18 : 26}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 2 21 7v10l-9 5-9-5V7l9-5Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="m3 7 9 5 9-5M12 12v10M8 4.3l9 5"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span className={`status-badge status-${value}`}>
      {statuses[value] ?? value}
    </span>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
function Panel({
  title,
  eyebrow,
  actions,
  children,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Dashboard({
  initialData,
  user,
}: {
  initialData: Workspace;
  user: User;
}) {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState<View>("overview");
  const [dark, setDark] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [orderId, setOrderId] = useState(initialData.orders[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [runId, setRunId] = useState(initialData.runs[0]?.id ?? "");
  const [detail, setDetail] = useState<{ run: Run; events: RunEvent[] } | null>(
    null,
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [orderForm, setOrderForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    text: string;
    perform: () => Promise<void>;
  } | null>(null);
  const [budget, setBudget] = useState(500000);
  const [auto, setAuto] = useState(false);
  const [partial, setPartial] = useState(false);
  const [goal, setGoal] = useState(
    "Penuhi pesanan terpilih sebelum tenggat dengan biaya pengadaan dan pengiriman sesuai anggaran.",
  );
  const [audits, setAudits] = useState<AuditEvent[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [settings, setSettings] = useState<{
    model: string | null;
    llmConfigured: boolean;
    workerHealthy: boolean;
  } | null>(null);
  const canEdit = user.role !== "viewer";
  const isAdmin = user.role === "admin";
  const refresh = useCallback(async () => {
    const result = await api<Workspace>("/api/workspace");
    setData(result);
  }, []);
  useEffect(() => {
    let mounted = true;
    const timer = setInterval(() => {
      api<Workspace>("/api/workspace")
        .then((d) => {
          if (mounted) setData(d);
        })
        .catch(() => {});
    }, 4000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!runId) return;
    let mounted = true;
    const load = () =>
      api<{ run: Run; events: RunEvent[] }>(`/api/runs/${runId}`)
        .then((d) => {
          if (mounted) setDetail(d);
        })
        .catch((e) => {
          if (mounted) setToast({ message: e.message, error: true });
        });
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [runId]);
  useEffect(() => {
    let mounted = true;
    if (view === "audit" && canEdit)
      api<{ data: AuditEvent[] }>("/api/audit")
        .then((d) => {
          if (mounted) setAudits(d.data);
        })
        .catch((e) => setToast({ message: e.message, error: true }));
    if (view === "settings") {
      api<{
        model: string | null;
        llmConfigured: boolean;
        workerHealthy: boolean;
      }>("/api/settings")
        .then((d) => {
          if (mounted) setSettings(d);
        })
        .catch(() => {});
      if (isAdmin)
        api<{ data: User[] }>("/api/users")
          .then((d) => {
            if (mounted) setUsers(d.data);
          })
          .catch(() => {});
    }
    return () => {
      mounted = false;
    };
  }, [view, canEdit, isAdmin]);
  useEffect(() => {
    if (!editor && !orderForm && !confirmation) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>(".modal");
    const focusable = () =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        ) ?? [],
      );
    focusable()[0]?.focus();
    function keydown(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) {
        setEditor(null);
        setOrderForm(false);
        setConfirmation(null);
      }
      if (e.key === "Tab") {
        const list = focusable();
        const first = list[0];
        const last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [editor, orderForm, confirmation, busy]);
  async function action(
    fn: () => Promise<unknown>,
    message = "Perubahan berhasil disimpan.",
  ) {
    if (actionLock.current) return false;
    actionLock.current = true;
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (view === "settings" && isAdmin)
        setUsers((await api<{ data: User[] }>("/api/users")).data);
      if (runId) setDetail(await api(`/api/runs/${runId}`));
      setToast({ message, error: false });
      return true;
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : "Terjadi kesalahan.",
        error: true,
      });
      return false;
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }
  function navigate(next: View) {
    setView(next);
    setQuery("");
  }
  const selectedOrder = data.orders.find((o) => o.id === orderId);
  const liveDetail = detail?.run.id === runId ? detail : null;
  const currentRun = liveDetail?.run ?? data.runs.find((r) => r.id === runId);
  const filtered = data.orders.filter((o) =>
    `${o.id} ${o.customer} ${o.lines.map((l) => l.sku).join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const open = data.orders.filter(
    (o) =>
      !["fulfilled", "cancelled"].includes(o.status) &&
      o.lines.some((l) => l.remaining > 0),
  );
  const shortageSkus = new Set(
    open.flatMap((o) =>
      o.lines
        .filter(
          (l) =>
            l.remaining >
            data.inventory
              .filter((s) => s.sku === l.sku)
              .reduce((n, s) => n + s.available, 0),
        )
        .map((l) => l.sku),
    ),
  );
  const nav: { id: View; label: string; symbol: string }[] = [
    { id: "overview", label: "Ringkasan", symbol: "◫" },
    { id: "orders", label: "Pesanan", symbol: "▤" },
    { id: "inventory", label: "Inventori", symbol: "◇" },
    { id: "suppliers", label: "Pemasok", symbol: "⌘" },
    { id: "runs", label: "Rescue Agent", symbol: "↗" },
    { id: "purchases", label: "Pengadaan", symbol: "▧" },
    ...(canEdit
      ? [{ id: "audit" as const, label: "Jejak audit", symbol: "≡" }]
      : []),
    { id: "settings", label: "Pengaturan", symbol: "⚙" },
  ];
  const choose = (id: string) =>
    setSelected((ids) =>
      ids.includes(id)
        ? ids.filter((v) => v !== id)
        : [...ids, id].slice(0, 30),
    );
  function editResource(
    title: string,
    resource: string,
    fields: Field[],
    values: Record<string, unknown> = {},
  ) {
    setEditor({ title, resource, fields, values });
  }
  const skuOptions = data.products.map((p) => ({
    value: p.sku,
    label: `${p.sku} · ${p.name}`,
  }));
  const whOptions = data.warehouses.map((w) => ({
    value: w.id,
    label: w.name,
  }));
  const supplierOptions = data.suppliers.map((s) => ({
    value: s.id,
    label: s.name,
  }));
  const productFields: Field[] = [
    { key: "sku", label: "SKU", required: true },
    { key: "name", label: "Nama produk", required: true },
  ];
  const warehouseFields: Field[] = [
    { key: "name", label: "Nama gudang", required: true },
    {
      key: "transferDays",
      label: "Waktu transfer (hari kalender)",
      type: "number",
      required: true,
      min: 0,
      max: 365,
    },
    {
      key: "shippingCostIdr",
      label: "Biaya pengiriman per pesanan (Rp)",
      type: "number",
      required: true,
      min: 0,
    },
  ];
  const stockFields: Field[] = [
    {
      key: "warehouseId",
      label: "Gudang",
      type: "select",
      options: whOptions,
      required: true,
    },
    {
      key: "sku",
      label: "Produk",
      type: "select",
      options: skuOptions,
      required: true,
    },
    {
      key: "onHand",
      label: "Stok fisik (termasuk reservasi)",
      type: "number",
      required: true,
      min: 0,
      max: 1000000,
    },
  ];
  const supplierFields: Field[] = [
    { key: "name", label: "Nama pemasok", required: true },
    { key: "active", label: "Pemasok aktif", type: "checkbox" },
  ];
  const offerFields: Field[] = [
    {
      key: "supplierId",
      label: "Pemasok",
      type: "select",
      options: supplierOptions,
      required: true,
    },
    {
      key: "sku",
      label: "Produk",
      type: "select",
      options: skuOptions,
      required: true,
    },
    {
      key: "available",
      label: "Kapasitas total (termasuk reservasi)",
      type: "number",
      required: true,
      min: 0,
      max: 1000000,
    },
    {
      key: "unitPriceIdr",
      label: "Harga satuan (Rp)",
      type: "number",
      required: true,
      min: 0,
    },
    {
      key: "leadTimeDays",
      label: "Lead time (hari kalender)",
      type: "number",
      required: true,
      min: 0,
      max: 365,
    },
    {
      key: "shippingCostIdr",
      label: "Ongkir per pesanan (Rp)",
      type: "number",
      required: true,
      min: 0,
    },
    { key: "active", label: "Penawaran aktif", type: "checkbox" },
  ];
  function confirm(title: string, text: string, perform: () => Promise<void>) {
    setConfirmation({ title, text, perform });
  }
  async function startRun() {
    const ids = selected.length
      ? selected
      : selectedOrder?.lines.some((l) => l.remaining > 0)
        ? [selectedOrder.id]
        : [];
    await action(async () => {
      const result = await api<{ run: Run }>(
        "/api/runs",
        {
          orderIds: ids,
          maxCostIdr: budget,
          allowPartialDelivery: partial,
          autoExecute: auto,
          goal,
        },
        "POST",
        { "Idempotency-Key": crypto.randomUUID() },
      );
      setRunId(result.run.id);
      setView("runs");
    }, "Run masuk antrean. Agent akan membaca data dan menyusun rencana.");
  }
  async function saveEditor(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editor) return;
    const form = new FormData(e.currentTarget);
    const values = { ...editor.values };
    for (const f of editor.fields) {
      const value = form.get(f.key);
      if (f.type === "checkbox") values[f.key] = value === "on";
      else if (f.type === "number") values[f.key] = Number(value);
      else if (f.type === "password" && !value && !f.required)
        delete values[f.key];
      else values[f.key] = String(value ?? "");
    }
    const ok = await action(() =>
      api(
        editor.url ?? `/api/resources/${editor.resource}`,
        values,
        editor.method ?? "POST",
      ),
    );
    if (ok) setEditor(null);
  }
  function showRun(id: string) {
    setRunId(id);
    navigate("runs");
  }
  function orderTable(list: Order[]) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {canEdit && (
                <th>
                  <span className="sr-only">Pilih</span>
                </th>
              )}
              <th>PELANGGAN / PESANAN</th>
              <th>ITEM</th>
              <th>TENGGAT</th>
              <th>STATUS</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id} data-selected={o.id === orderId}>
                {canEdit && (
                  <td>
                    <input
                      aria-label={`Pilih ${o.customer}`}
                      type="checkbox"
                      checked={selected.includes(o.id)}
                      disabled={
                        !o.lines.some((l) => l.remaining > 0) ||
                        ["fulfilled", "cancelled"].includes(o.status)
                      }
                      onChange={() => choose(o.id)}
                    />
                  </td>
                )}
                <td>
                  <button
                    className="order-select"
                    aria-pressed={o.id === orderId}
                    onClick={() => setOrderId(o.id)}
                  >
                    <strong>{o.customer}</strong>
                    <small>{o.id}</small>
                  </button>
                </td>
                <td>
                  <strong>
                    {o.lines.reduce((n, l) => n + l.quantity, 0)} unit
                  </strong>
                  <small>
                    {o.lines.length} SKU ·{" "}
                    {o.priority === "high" ? "Prioritas tinggi" : "Normal"}
                  </small>
                </td>
                <td>{day(o.dueDate)}</td>
                <td>
                  <Status value={o.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <Empty>Belum ada pesanan yang sesuai.</Empty>}
      </div>
    );
  }
  const controls = (
    <div className="rescue-controls">
      <label>
        Anggaran pengadaan & pengiriman (Rp)
        <input
          type="number"
          min="0"
          max="1000000000000"
          step="1"
          value={budget}
          onChange={(e) => setBudget(Number(e.target.value))}
        />
      </label>
      <label>
        Tujuan pemenuhan
        <textarea
          rows={3}
          maxLength={1500}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={partial}
          onChange={(e) => setPartial(e.target.checked)}
        />
        Izinkan alokasi parsial jika pesanan mengizinkan
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
        />
        Eksekusi otomatis jika seluruh batasan terpenuhi
      </label>
      <Button
        loading={busy}
        disabled={
          !canEdit ||
          !data.llmConfigured ||
          !data.workerHealthy ||
          (!selected.length &&
            !selectedOrder?.lines.some((l) => l.remaining > 0)) ||
          !Number.isSafeInteger(budget) ||
          budget < 0
        }
        onClick={startRun}
      >
        Mulai rescue{selected.length ? ` · ${selected.length} pesanan` : ""}
      </Button>
      <p className="help-text">
        {!data.llmConfigured
          ? "Provider LLM belum dikonfigurasi."
          : !data.workerHealthy
            ? "Worker belum aktif. Jalankan aplikasi beserta worker."
            : auto
              ? "Agent dapat mereservasi stok dan membuat draft PO dalam anggaran ini."
              : "Rencana akan menunggu persetujuan sebelum stok direservasi."}
      </p>
    </div>
  );
  return (
    <div className="rescue-app" data-theme={dark ? "dark" : "light"}>
      <a className="skip-link" href="#main">
        Lewati ke konten
      </a>
      <aside className="sidebar">
        <button
          className="brand brand-button"
          onClick={() => navigate("overview")}
        >
          <span className="brand-mark">
            <Mark />
          </span>
          <span>
            order<span className="brand-soft">rescue</span>
            <small>OPERATIONS WORKSPACE</small>
          </span>
        </button>
        <div className="workspace">
          <span className="workspace-avatar">OR</span>
          <div>
            <strong>Fulfillment operations</strong>
            <small>
              {data.mode === "simulation"
                ? "Workspace simulasi"
                : "Workspace operasional"}
            </small>
          </div>
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="Navigasi utama">
          {nav.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "nav-active" : ""}
              aria-current={view === n.id ? "page" : undefined}
              onClick={() => navigate(n.id)}
              title={n.label}
            >
              <span>{n.symbol}</span>
              <span>{n.label}</span>
              {n.id === "runs" && data.runs.some(working) && (
                <span className="nav-count">●</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <span
              className={`status-dot ${data.workerHealthy ? "" : "dot-off"}`}
            />
            {data.workerHealthy ? "Worker terhubung" : "Worker tidak aktif"}
            <small>
              {data.mode === "simulation"
                ? "Integrasi pemasok disimulasikan"
                : "Dokumen PO dikelola internal"}
            </small>
          </div>
          <button
            className="profile profile-button"
            onClick={() => navigate("settings")}
          >
            <span className="profile-avatar">
              {user.name.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <strong>{user.name}</strong>
              <small>{user.role}</small>
            </div>
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span className="muted">Workspace</span>
            <span className="slash">/</span>
            <span>{nav.find((n) => n.id === view)?.label}</span>
          </div>
          <div className="topbar-actions">
            <span className="demo-label">
              {data.mode === "simulation" ? "SIMULASI" : "OPERASIONAL"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDark(!dark)}
              aria-label={dark ? "Aktifkan tema terang" : "Aktifkan tema gelap"}
            >
              {dark ? "☀" : "☾"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                action(async () => {
                  await api("/api/auth/logout", {});
                  window.location.assign(
                    new URL("/login", window.location.origin).href,
                  );
                }, "Sesi diakhiri.")
              }
            >
              Keluar
            </Button>
          </div>
        </header>
        <nav className="mobile-nav" aria-label="Navigasi mobile">
          {nav.map((n) => (
            <button
              key={n.id}
              aria-current={view === n.id ? "page" : undefined}
              onClick={() => navigate(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <main id="main">
          {toast && (
            <div
              className={`toast ${toast.error ? "toast-error" : ""}`}
              role={toast.error ? "alert" : "status"}
            >
              <span>{toast.message}</span>
              <button
                aria-label="Tutup pemberitahuan"
                onClick={() => setToast(null)}
              >
                ×
              </button>
            </div>
          )}
          <section className="page-heading">
            <div>
              <p className="eyebrow">INTELLIGENT FULFILLMENT OPERATIONS</p>
              <h1>
                {view === "overview"
                  ? "Kendalikan pemenuhan pesanan."
                  : nav.find((n) => n.id === view)?.label}
              </h1>
              <p className="muted">
                {view === "runs"
                  ? "Rencana terukur. Eksekusi tervalidasi. Setiap tindakan tercatat."
                  : "Kelola kebutuhan, pasokan, dan keputusan operasional dalam satu workspace."}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() => action(refresh, "Data diperbarui.")}
            >
              ↻ Perbarui
            </Button>
          </section>
          {view === "overview" && (
            <>
              <div className="metrics">
                <article>
                  <div>
                    <span>Pesanan perlu dipenuhi</span>
                    <Mark small />
                  </div>
                  <strong>{open.length.toString().padStart(2, "0")}</strong>
                  <small>{shortageSkus.size} SKU perlu tambahan pasokan</small>
                </article>
                <article>
                  <div>
                    <span>Rescue selesai</span>
                    <span className="success">↗</span>
                  </div>
                  <strong>
                    {data.metrics.completedRuns.toString().padStart(2, "0")}
                  </strong>
                  <small>
                    {data.metrics.rescuedOrders} pesanan memiliki jejak alokasi
                  </small>
                </article>
                <article>
                  <div>
                    <span>Unit direservasi</span>
                    <span>◇</span>
                  </div>
                  <strong>{data.metrics.activeReservations}</strong>
                  <small>Reservasi aktif di gudang dan pemasok</small>
                </article>
                <article>
                  <div>
                    <span>Nilai pengadaan</span>
                    <span>⌘</span>
                  </div>
                  <strong className="metric-money">
                    {money(data.metrics.procurementCostIdr)}
                  </strong>
                  <small>Draft dan PO diterima · bukan pembayaran</small>
                </article>
              </div>
              <div className="work-grid">
                <Panel
                  title="Pesanan pelanggan"
                  eyebrow="ORDER BOOK"
                  actions={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate("orders")}
                    >
                      Lihat semua ↗
                    </Button>
                  }
                >
                  <div className="search-row">
                    <label className="search">
                      <span>⌕</span>
                      <input
                        aria-label="Cari pesanan"
                        placeholder="Cari pelanggan, pesanan, atau SKU…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                  </div>
                  {orderTable(filtered.slice(0, 8))}
                  <div className="table-foot">
                    Pilih satu atau beberapa pesanan untuk menjalankan rescue.
                  </div>
                </Panel>
                <Panel
                  title={selectedOrder?.customer ?? "Mulai rescue"}
                  eyebrow="RESCUE WORKSPACE"
                  className="detail-panel"
                >
                  {selectedOrder && (
                    <div className="selected-lines">
                      <div className="order-reference">
                        <span>{selectedOrder.id}</span>
                        <Status value={selectedOrder.status} />
                      </div>
                      {selectedOrder.lines.map((l) => (
                        <div className="line-summary" key={l.id}>
                          <div>
                            <strong>{l.sku}</strong>
                            <small>{l.productName}</small>
                          </div>
                          <div>
                            <strong>{l.remaining} unit</strong>
                            <small>belum dialokasikan</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {canEdit ? (
                    controls
                  ) : (
                    <Empty>
                      Akses baca. Operator menjalankan proses rescue.
                    </Empty>
                  )}
                </Panel>
              </div>
              <Panel
                title="Run terbaru"
                eyebrow="AGENT ACTIVITY"
                className="spaced-panel"
              >
                {!data.runs.length ? (
                  <Empty>Belum ada run. Pilih pesanan lalu mulai rescue.</Empty>
                ) : (
                  <div className="run-preview-list">
                    {data.runs.slice(0, 5).map((r) => (
                      <button key={r.id} onClick={() => showRun(r.id)}>
                        <span>
                          <strong>{r.id}</strong>
                          <small>
                            {r.constraints.orderIds.length} pesanan ·{" "}
                            {day(r.createdAt)}
                          </small>
                        </span>
                        <Status value={r.status} />
                        <span>
                          {r.plan
                            ? money(r.plan.totalCostIdr)
                            : "Menunggu rencana"}
                        </span>
                        <span>↗</span>
                      </button>
                    ))}
                  </div>
                )}
              </Panel>
            </>
          )}
          {view === "orders" && (
            <>
              <Panel
                title="Daftar pesanan"
                eyebrow="ORDER MANAGEMENT"
                actions={
                  <div className="button-row">
                    <a className="text-link" href="/api/export/orders.csv">
                      Ekspor CSV
                    </a>
                    {canEdit && (
                      <Button size="sm" onClick={() => setOrderForm(true)}>
                        + Pesanan
                      </Button>
                    )}
                  </div>
                }
              >
                <div className="search-row">
                  <label className="search">
                    <input
                      aria-label="Cari pesanan"
                      placeholder="Cari pesanan…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                </div>
                {orderTable(filtered)}
              </Panel>
              <div className="work-grid spaced-panel">
                <Panel
                  title={selectedOrder?.customer ?? "Detail pesanan"}
                  eyebrow="ORDER DETAIL"
                >
                  {selectedOrder ? (
                    <>
                      <div className="detail-body">
                        <p>
                          {selectedOrder.id} · Tenggat{" "}
                          {day(selectedOrder.dueDate)} ·{" "}
                          {selectedOrder.allowPartial
                            ? "Pengiriman parsial diizinkan"
                            : "Harus dikirim penuh"}
                        </p>
                        {selectedOrder.lines.map((l) => (
                          <div className="line-summary" key={l.id}>
                            <div>
                              <strong>{l.sku}</strong>
                              <small>{l.productName}</small>
                            </div>
                            <span>
                              {l.quantity} dipesan · {l.allocated} direservasi ·{" "}
                              {l.fulfilled} terkirim
                            </span>
                          </div>
                        ))}
                      </div>
                      {canEdit &&
                        !["fulfilled", "cancelled"].includes(
                          selectedOrder.status,
                        ) && (
                          <div className="panel-actions">
                            <Button
                              variant="secondary"
                              onClick={() =>
                                confirm(
                                  "Konfirmasi pengiriman",
                                  `Catat pengiriman stok siap untuk ${selectedOrder.customer}. Stok fisik akan berkurang.`,
                                  async () => {
                                    await action(
                                      () =>
                                        api(
                                          `/api/orders/${selectedOrder.id}/ship`,
                                          {},
                                        ),
                                      "Pengiriman tercatat.",
                                    );
                                  },
                                )
                              }
                            >
                              Kirim stok siap
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() =>
                                confirm(
                                  "Batalkan pesanan",
                                  `Reservasi ${selectedOrder.customer} akan dilepas dan draft PO dibatalkan. Barang yang sudah diterima tetap berada di gudang.`,
                                  async () => {
                                    await action(
                                      () =>
                                        api(
                                          `/api/orders/${selectedOrder.id}/cancel`,
                                          {},
                                        ),
                                      "Pesanan dibatalkan.",
                                    );
                                  },
                                )
                              }
                            >
                              Batalkan pesanan
                            </Button>
                          </div>
                        )}
                    </>
                  ) : (
                    <Empty>Pilih pesanan dari daftar.</Empty>
                  )}
                </Panel>
                <Panel title="Jalankan rescue" eyebrow="CONSTRAINTS">
                  {canEdit ? controls : <Empty>Akses baca.</Empty>}
                </Panel>
              </div>
            </>
          )}
          {view === "inventory" && (
            <>
              <Panel
                title="Stok dan reservasi"
                eyebrow="LIVE INVENTORY"
                actions={
                  canEdit && (
                    <Button
                      size="sm"
                      onClick={() =>
                        editResource(
                          "Atur stok fisik",
                          "inventory",
                          stockFields,
                          { onHand: 0 },
                        )
                      }
                    >
                      + Atur stok
                    </Button>
                  )
                }
              >
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>PRODUK</th>
                        <th>GUDANG</th>
                        <th>FISIK</th>
                        <th>RESERVASI</th>
                        <th>TERSEDIA</th>
                        {canEdit && <th>AKSI</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {data.inventory.map((s) => (
                        <tr key={`${s.warehouseId}/${s.sku}`}>
                          <td>
                            <strong>{s.sku}</strong>
                          </td>
                          <td>{s.warehouseName}</td>
                          <td>{s.onHand}</td>
                          <td>{s.reserved}</td>
                          <td>{s.available}</td>
                          {canEdit && (
                            <td>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  editResource(
                                    "Perbarui stok fisik",
                                    "inventory",
                                    stockFields,
                                    {
                                      warehouseId: s.warehouseId,
                                      sku: s.sku,
                                      onHand: s.onHand,
                                    },
                                  )
                                }
                              >
                                Ubah
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data.inventory.length && (
                    <Empty>
                      Tambahkan produk dan gudang, lalu isi stok fisik.
                    </Empty>
                  )}
                </div>
              </Panel>
              <div className="bottom-grid">
                <Panel
                  title="Produk"
                  actions={
                    canEdit && (
                      <Button
                        size="sm"
                        onClick={() =>
                          editResource(
                            "Tambah produk",
                            "products",
                            productFields,
                          )
                        }
                      >
                        + Produk
                      </Button>
                    )
                  }
                >
                  <div className="resource-list">
                    {data.products.map((p) => (
                      <div className="resource-row" key={p.sku}>
                        <span className="resource-icon">◇</span>
                        <div>
                          <strong>{p.name}</strong>
                          <small>{p.sku}</small>
                        </div>
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              editResource(
                                "Ubah nama produk",
                                "products",
                                [productFields[1]],
                                p,
                              )
                            }
                          >
                            Ubah
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel
                  title="Gudang"
                  actions={
                    canEdit && (
                      <Button
                        size="sm"
                        onClick={() =>
                          editResource(
                            "Tambah gudang",
                            "warehouses",
                            warehouseFields,
                            { transferDays: 0, shippingCostIdr: 0 },
                          )
                        }
                      >
                        + Gudang
                      </Button>
                    )
                  }
                >
                  <div className="resource-list">
                    {data.warehouses.map((w) => (
                      <div className="resource-row" key={w.id}>
                        <span className="resource-icon">▧</span>
                        <div>
                          <strong>{w.name}</strong>
                          <small>
                            {w.transferDays} hari kalender ·{" "}
                            {money(w.shippingCostIdr)} / pesanan
                          </small>
                        </div>
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              editResource(
                                "Ubah gudang",
                                "warehouses",
                                warehouseFields,
                                { ...w },
                              )
                            }
                          >
                            Ubah
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            </>
          )}
          {view === "suppliers" && (
            <>
              <Panel
                title="Jaringan pemasok"
                actions={
                  canEdit && (
                    <Button
                      size="sm"
                      onClick={() =>
                        editResource(
                          "Tambah pemasok",
                          "suppliers",
                          supplierFields,
                          { active: true },
                        )
                      }
                    >
                      + Pemasok
                    </Button>
                  )
                }
              >
                <div className="resource-list">
                  {data.suppliers.map((s) => (
                    <div className="resource-row" key={s.id}>
                      <span className="resource-icon">⌘</span>
                      <div>
                        <strong>{s.name}</strong>
                        <small>
                          {s.id} · {s.active ? "Aktif" : "Nonaktif"}
                        </small>
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            editResource(
                              "Ubah pemasok",
                              "suppliers",
                              supplierFields,
                              { ...s, active: Boolean(s.active) },
                            )
                          }
                        >
                          Ubah
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel
                title="Penawaran dan kapasitas"
                eyebrow="SUPPLIER OFFERS"
                className="spaced-panel"
                actions={
                  canEdit && (
                    <Button
                      size="sm"
                      onClick={() =>
                        editResource(
                          "Tambah penawaran",
                          "offers",
                          offerFields,
                          {
                            available: 0,
                            unitPriceIdr: 0,
                            leadTimeDays: 1,
                            shippingCostIdr: 0,
                            active: true,
                          },
                        )
                      }
                    >
                      + Penawaran
                    </Button>
                  )
                }
              >
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>PEMASOK / SKU</th>
                        <th>TERSEDIA</th>
                        <th>HARGA SATUAN</th>
                        <th>LEAD TIME / ONGKIR</th>
                        <th>STATUS</th>
                        {canEdit && <th>AKSI</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {data.offers.map((o) => (
                        <tr key={o.id}>
                          <td>
                            <strong>{o.supplierName}</strong>
                            <small>
                              {o.sku} · {o.id}
                            </small>
                          </td>
                          <td>
                            {o.remaining}
                            <small>{o.reserved} direservasi</small>
                          </td>
                          <td>{money(o.unitPriceIdr)}</td>
                          <td>
                            {o.leadTimeDays} hari
                            <small>{money(o.shippingCostIdr)} / pesanan</small>
                          </td>
                          <td>{o.active ? "Aktif" : "Nonaktif"}</td>
                          {canEdit && (
                            <td>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  editResource(
                                    "Ubah penawaran",
                                    "offers",
                                    offerFields,
                                    {
                                      id: o.id,
                                      supplierId: o.supplierId,
                                      sku: o.sku,
                                      available: o.available,
                                      unitPriceIdr: o.unitPriceIdr,
                                      leadTimeDays: o.leadTimeDays,
                                      shippingCostIdr: o.shippingCostIdr,
                                      active: Boolean(o.active),
                                    },
                                  )
                                }
                              >
                                Ubah
                              </Button>
                              {Boolean(o.active) && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    confirm(
                                      "Tandai penawaran gagal",
                                      `Penawaran ${o.supplierName}/${o.sku} dinonaktifkan. Alokasi aktif run yang menunggu pasokan ini akan dilepas, lalu kebutuhan tersisa dijadwalkan untuk dipulihkan.`,
                                      async () => {
                                        await action(async () => {
                                          const result = await api<{
                                            recoveryRunIds: string[];
                                          }>(`/api/offers/${o.id}/fail`, {});
                                          if (result.recoveryRunIds[0]) {
                                            setRunId(result.recoveryRunIds[0]);
                                            setView("runs");
                                          }
                                        }, "Penawaran dinonaktifkan; pemulihan yang diperlukan telah dijadwalkan.");
                                      },
                                    )
                                  }
                                >
                                  Tandai gagal
                                </Button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data.offers.length && (
                    <Empty>
                      Tambahkan pemasok dan penawaran untuk perencanaan
                      pengadaan.
                    </Empty>
                  )}
                </div>
              </Panel>
            </>
          )}
          {view === "runs" && (
            <div className="run-layout">
              <Panel title="Riwayat rescue" eyebrow="PERSISTENT RUNS">
                <div className="run-list">
                  {data.runs.map((r) => (
                    <button
                      key={r.id}
                      className={r.id === runId ? "selected-run" : ""}
                      onClick={() => setRunId(r.id)}
                    >
                      <strong>{r.id}</strong>
                      <Status value={r.status} />
                      <small>
                        {r.constraints.orderIds.length} pesanan ·{" "}
                        {day(r.createdAt)} · percobaan {r.attempt}
                      </small>
                    </button>
                  ))}
                  {!data.runs.length && (
                    <Empty>Mulai run dari halaman pesanan.</Empty>
                  )}
                </div>
              </Panel>
              <div>
                {currentRun ? (
                  <>
                    <Panel
                      title={currentRun.id}
                      eyebrow="RESCUE RUN"
                      actions={<Status value={currentRun.status} />}
                    >
                      <div className="detail-body">
                        <p>
                          {currentRun.constraints.goal ||
                            "Penuhi pesanan dalam batasan yang ditetapkan."}
                        </p>
                        <div className="run-facts">
                          <span>
                            Anggaran
                            <strong>
                              {money(currentRun.constraints.maxCostIdr)}
                            </strong>
                          </span>
                          <span>
                            Pesanan
                            <strong>
                              {currentRun.constraints.orderIds.join(", ")}
                            </strong>
                          </span>
                          <span>
                            Otorisasi
                            <strong>
                              {currentRun.constraints.autoExecute
                                ? "Otomatis dalam batasan"
                                : "Persetujuan operator"}
                            </strong>
                          </span>
                        </div>
                        {currentRun.error && (
                          <p className="form-error" role="alert">
                            {currentRun.error}
                          </p>
                        )}
                        {currentRun.plan && (
                          <>
                            <div className="plan-total">
                              <span>Biaya rencana tervalidasi</span>
                              <strong>
                                {money(currentRun.plan.totalCostIdr)}
                              </strong>
                            </div>
                            <p className="plan-summary">
                              {currentRun.plan.summary}
                            </p>
                            <div className="table-wrap">
                              <table>
                                <thead>
                                  <tr>
                                    <th>PESANAN / SKU</th>
                                    <th>SUMBER</th>
                                    <th>JUMLAH</th>
                                    <th>ESTIMASI TIBA</th>
                                    <th>BIAYA</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {currentRun.plan.allocations.map((a, i) => (
                                    <tr key={i}>
                                      <td>
                                        {a.orderId}
                                        <small>{a.sku}</small>
                                      </td>
                                      <td>
                                        {a.sourceName}
                                        <small>
                                          {a.kind === "supplier"
                                            ? "Pengadaan"
                                            : "Stok gudang"}
                                        </small>
                                      </td>
                                      <td>{a.quantity}</td>
                                      <td>{day(a.arrivalDate)}</td>
                                      <td>{money(a.totalCostIdr)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </>
                        )}
                        {currentRun.result && !currentRun.result.released && (
                          <div className="success-box">
                            Reservasi tersimpan dan hasil terverifikasi. Draft
                            PO:{" "}
                            {Array.isArray(currentRun.result.purchaseOrderIds)
                              ? currentRun.result.purchaseOrderIds.length
                              : 0}
                            .
                            <p>
                              PO belum dikirim ke pemasok. Lanjutkan penerimaan
                              barang dan pengiriman pada halaman operasional.
                            </p>
                          </div>
                        )}
                        {typeof currentRun.result?.recoveryRunId ===
                          "string" && (
                          <Button
                            variant="secondary"
                            onClick={() =>
                              showRun(
                                currentRun.result!.recoveryRunId as string,
                              )
                            }
                          >
                            Lihat run pemulihan ↗
                          </Button>
                        )}
                        <div className="button-row">
                          <a
                            className="text-link"
                            href={`/api/export/runs/${currentRun.id}`}
                          >
                            Unduh jejak run
                          </a>
                        </div>
                      </div>
                      {canEdit && (
                        <div className="panel-actions">
                          {currentRun.status === "awaiting_approval" && (
                            <Button
                              loading={busy}
                              onClick={() =>
                                action(
                                  () =>
                                    api(
                                      `/api/runs/${currentRun.id}/approve`,
                                      {},
                                    ),
                                  "Rencana disetujui; menunggu eksekusi tervalidasi.",
                                )
                              }
                            >
                              Setujui & eksekusi
                            </Button>
                          )}
                          {["failed", "needs_attention", "cancelled"].includes(
                            currentRun.status,
                          ) && (
                            <Button
                              variant="secondary"
                              loading={busy}
                              onClick={() =>
                                action(
                                  () =>
                                    api(`/api/runs/${currentRun.id}/retry`, {}),
                                  "Run dijadwalkan ulang.",
                                )
                              }
                            >
                              Coba ulang
                            </Button>
                          )}
                          {[
                            "queued",
                            "planning",
                            "awaiting_approval",
                            "executing",
                          ].includes(currentRun.status) && (
                            <Button
                              variant="ghost"
                              loading={busy}
                              onClick={() =>
                                action(
                                  () =>
                                    api(
                                      `/api/runs/${currentRun.id}/cancel`,
                                      {},
                                    ),
                                  "Run dibatalkan.",
                                )
                              }
                            >
                              Hentikan run
                            </Button>
                          )}
                        </div>
                      )}
                      {canEdit &&
                        data.mode === "simulation" &&
                        currentRun.status === "awaiting_approval" &&
                        currentRun.plan?.allocations.some(
                          (a) => a.kind === "supplier",
                        ) && (
                          <div className="simulation-box">
                            <strong>
                              Uji adaptasi terhadap kegagalan pemasok
                            </strong>
                            <p>
                              Nonaktifkan satu sumber dalam rencana, lalu minta
                              eksekusi. Validasi akan menolak sumber tersebut
                              dan agent menyusun ulang rencana dari data
                              terbaru.
                            </p>
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={busy}
                              onClick={() =>
                                action(async () => {
                                  const offerId =
                                    currentRun.plan!.allocations.find(
                                      (a) => a.kind === "supplier",
                                    )!.sourceId;
                                  await api("/api/simulation/fail-offer", {
                                    offerId,
                                  });
                                  await api(
                                    `/api/runs/${currentRun.id}/approve`,
                                    {},
                                  );
                                }, "Pemasok disimulasikan gagal. Run akan memvalidasi ulang dan menyusun rencana baru.")
                              }
                            >
                              Simulasikan pemasok gagal
                            </Button>
                          </div>
                        )}
                    </Panel>
                    <Panel
                      title="Aktivitas dan bukti"
                      eyebrow="TOOL EXECUTION TRACE"
                      className="spaced-panel"
                    >
                      <div className="tool-calls">
                        {liveDetail?.events.map((e) =>
                          e.type === "tool" ? (
                            <ToolCallCard
                              key={e.id}
                              name={e.name}
                              status={
                                e.status === "error"
                                  ? "error"
                                  : e.status === "running"
                                    ? "running"
                                    : "success"
                              }
                              args={e.input}
                              result={e.output}
                              error={
                                e.status === "error"
                                  ? String(
                                      (e.output as { error?: string })?.error ??
                                        "Validasi alat gagal",
                                    )
                                  : undefined
                              }
                              duration={e.durationMs ?? undefined}
                              summary={
                                e.status === "error"
                                  ? "Perlu koreksi"
                                  : "Hasil alat tersimpan"
                              }
                            />
                          ) : (
                            <div
                              key={e.id}
                              className={`timeline-event event-${e.status}`}
                            >
                              <span className="timeline-dot" />
                              <div>
                                <strong>{e.name.replaceAll("_", " ")}</strong>
                                <small>
                                  {new Date(e.createdAt).toLocaleTimeString(
                                    "id-ID",
                                    { timeZone: "Asia/Jakarta" },
                                  )}{" "}
                                  WIB
                                  {e.durationMs !== null
                                    ? ` · ${e.durationMs} ms`
                                    : ""}
                                </small>
                              </div>
                              {e.type === "model" && (
                                <span className="subtle-pill">LLM</span>
                              )}
                            </div>
                          ),
                        )}
                        {!liveDetail?.events.length && (
                          <Empty>Memuat riwayat run…</Empty>
                        )}
                      </div>
                    </Panel>
                  </>
                ) : (
                  <Panel title="Belum ada run">
                    <Empty>
                      Pilih pesanan dari halaman Pesanan lalu mulai rescue.
                    </Empty>
                  </Panel>
                )}
              </div>
            </div>
          )}
          {view === "purchases" && (
            <Panel
              title="Dokumen pengadaan internal"
              eyebrow="PROCUREMENT"
              actions={
                <span className="subtle-pill">PO tidak dikirim otomatis</span>
              }
            >
              <p className="section-help">
                Catat penerimaan barang hanya setelah barang benar-benar tiba.
                Stok masuk langsung direservasi untuk pesanan terkait.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>PO / PESANAN</th>
                      <th>PEMASOK / SKU</th>
                      <th>JUMLAH</th>
                      <th>NILAI</th>
                      <th>STATUS</th>
                      {canEdit && <th>AKSI</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.purchaseOrders.map((po) => (
                      <tr key={po.id}>
                        <td>
                          {po.id}
                          <small>{po.orderId}</small>
                        </td>
                        <td>
                          {po.supplierName}
                          <small>{po.sku}</small>
                        </td>
                        <td>{po.quantity}</td>
                        <td>{money(po.totalCostIdr)}</td>
                        <td>
                          <Status value={po.status} />
                        </td>
                        {canEdit && (
                          <td>
                            {po.status === "draft" && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                  setEditor({
                                    title: `Terima barang · ${po.id}`,
                                    url: `/api/purchases/${po.id}/receive`,
                                    fields: [
                                      {
                                        key: "warehouseId",
                                        label: "Gudang penerima",
                                        type: "select",
                                        options: whOptions,
                                        required: true,
                                      },
                                    ],
                                    values: {},
                                  })
                                }
                              >
                                Terima barang
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.purchaseOrders.length && (
                  <Empty>
                    Draft PO akan dibuat ketika agent mengeksekusi rencana yang
                    memerlukan pasokan baru.
                  </Empty>
                )}
              </div>
            </Panel>
          )}
          {view === "audit" && canEdit && (
            <Panel title="Jejak perubahan" eyebrow="AUDIT LOG">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>WAKTU</th>
                      <th>TINDAKAN</th>
                      <th>ENTITAS</th>
                      <th>AKTOR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audits.map((a) => (
                      <tr key={a.id}>
                        <td>
                          {day(a.createdAt)}
                          <small>
                            {new Date(a.createdAt).toLocaleTimeString("id-ID", {
                              timeZone: "Asia/Jakarta",
                            })}
                          </small>
                        </td>
                        <td>{a.action}</td>
                        <td>
                          {a.entityId}
                          <small>{a.entityType}</small>
                        </td>
                        <td>{a.actorId ?? "Sistem"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="panel-actions">
                <Button
                  variant="secondary"
                  disabled={!audits.length}
                  onClick={() =>
                    action(async () => {
                      const more = await api<{ data: AuditEvent[] }>(
                        `/api/audit?before=${audits.at(-1)?.id}`,
                      );
                      setAudits((prev) => [...prev, ...more.data]);
                    }, "Riwayat dimuat.")
                  }
                >
                  Muat lebih lama
                </Button>
              </div>
            </Panel>
          )}
          {view === "settings" && (
            <>
              <div className="bottom-grid">
                <Panel title="Koneksi & runtime" eyebrow="SYSTEM STATUS">
                  <div className="detail-body">
                    <div className="settings-row">
                      <span>Provider LLM</span>
                      <strong>
                        {data.llmConfigured
                          ? "Dikonfigurasi"
                          : "Belum dikonfigurasi"}
                      </strong>
                    </div>
                    <div className="settings-row">
                      <span>Model</span>
                      <code>{settings?.model ?? "—"}</code>
                    </div>
                    <div className="settings-row">
                      <span>Worker</span>
                      <strong>
                        {data.workerHealthy ? "Aktif" : "Tidak aktif"}
                      </strong>
                    </div>
                    <div className="settings-row">
                      <span>Mode data</span>
                      <strong>{data.mode}</strong>
                    </div>
                    <div className="settings-row">
                      <span>Masa sesi</span>
                      <strong>12 jam</strong>
                    </div>
                    {isAdmin && (
                      <Button
                        variant="secondary"
                        loading={busy}
                        onClick={() =>
                          action(async () => {
                            const result = await api<{
                              model: string;
                              latencyMs: number;
                            }>("/api/provider/check", {});
                            setToast({
                              message: `Provider berhasil merespons dalam ${result.latencyMs} ms.`,
                              error: false,
                            });
                          }, "Provider berhasil merespons.")
                        }
                      >
                        Uji koneksi LLM
                      </Button>
                    )}
                    <p className="help-text">
                      Kredensial provider dikelola melalui konfigurasi server.
                      API key tidak dikirim ke browser.
                    </p>
                  </div>
                </Panel>
                <Panel title="Keamanan akun" eyebrow="YOUR ACCOUNT">
                  <div className="detail-body">
                    <p>
                      <strong>{user.name}</strong>
                      <br />
                      {user.email}
                      <br />
                      <span className="subtle-pill">{user.role}</span>
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setEditor({
                          title: "Ubah kata sandi",
                          url: "/api/auth/password",
                          fields: [
                            {
                              key: "currentPassword",
                              label: "Kata sandi saat ini",
                              type: "password",
                              required: true,
                            },
                            {
                              key: "newPassword",
                              label: "Kata sandi baru (minimal 12 karakter)",
                              type: "password",
                              required: true,
                            },
                          ],
                          values: {},
                        })
                      }
                    >
                      Ubah kata sandi
                    </Button>
                    <p className="help-text">
                      Mengubah kata sandi mencabut seluruh sesi akun. Masuk
                      kembali setelah berhasil.
                    </p>
                  </div>
                </Panel>
              </div>
              {isAdmin && (
                <Panel
                  title="Pengguna workspace"
                  eyebrow="ACCESS MANAGEMENT"
                  className="spaced-panel"
                  actions={
                    <Button
                      size="sm"
                      onClick={() =>
                        setEditor({
                          title: "Tambah pengguna",
                          url: "/api/users",
                          fields: [
                            { key: "name", label: "Nama", required: true },
                            {
                              key: "email",
                              label: "Email",
                              type: "email",
                              required: true,
                            },
                            {
                              key: "role",
                              label: "Peran",
                              type: "select",
                              options: ["admin", "operator", "viewer"].map(
                                (v) => ({ value: v, label: v }),
                              ),
                              required: true,
                            },
                            {
                              key: "password",
                              label: "Kata sandi (minimal 12 karakter)",
                              type: "password",
                              required: true,
                            },
                          ],
                          values: { role: "viewer" },
                        })
                      }
                    >
                      + Pengguna
                    </Button>
                  }
                >
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>NAMA</th>
                          <th>EMAIL</th>
                          <th>PERAN</th>
                          <th>STATUS</th>
                          <th>AKSI</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.map((u) => (
                          <tr key={u.id}>
                            <td>{u.name}</td>
                            <td>{u.email}</td>
                            <td>{u.role}</td>
                            <td>{u.active ? "Aktif" : "Nonaktif"}</td>
                            <td>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setEditor({
                                    title: `Ubah pengguna · ${u.name}`,
                                    url: `/api/users/${u.id}`,
                                    method: "PATCH",
                                    fields: [
                                      {
                                        key: "name",
                                        label: "Nama",
                                        required: true,
                                      },
                                      {
                                        key: "role",
                                        label: "Peran",
                                        type: "select",
                                        options: [
                                          "admin",
                                          "operator",
                                          "viewer",
                                        ].map((v) => ({ value: v, label: v })),
                                        required: true,
                                      },
                                      {
                                        key: "active",
                                        label: "Akun aktif",
                                        type: "checkbox",
                                      },
                                      {
                                        key: "password",
                                        label: "Kata sandi baru (opsional)",
                                        type: "password",
                                      },
                                    ],
                                    values: {
                                      name: u.name,
                                      role: u.role,
                                      active: Boolean(u.active),
                                    },
                                  })
                                }
                              >
                                Kelola
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <Mark small />
              Order Rescue
            </span>
            <span>Persistent operations · Namur UI / Ember</span>
          </footer>
        </main>
      </div>
      {editor && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="editor-title"
            className="modal"
          >
            <header>
              <h2 id="editor-title">{editor.title}</h2>
              <button aria-label="Tutup form" onClick={() => setEditor(null)}>
                ×
              </button>
            </header>
            <form onSubmit={saveEditor}>
              {editor.fields.map((f) => (
                <label
                  className={f.type === "checkbox" ? "check-label" : ""}
                  key={f.key}
                >
                  {f.type === "checkbox" ? (
                    <>
                      <input
                        name={f.key}
                        aria-label={f.label}
                        type="checkbox"
                        defaultChecked={Boolean(editor.values[f.key])}
                      />
                      {f.label}
                    </>
                  ) : (
                    <>
                      {f.label}
                      {f.type === "select" ? (
                        <select
                          name={f.key}
                          aria-label={f.label}
                          required={f.required}
                          defaultValue={String(
                            editor.values[f.key] ?? f.options?.[0]?.value ?? "",
                          )}
                        >
                          {f.options?.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          name={f.key}
                          aria-label={f.label}
                          type={f.type ?? "text"}
                          required={f.required}
                          min={f.min}
                          max={f.max}
                          minLength={
                            f.type === "password" && f.key !== "currentPassword"
                              ? 12
                              : undefined
                          }
                          maxLength={f.type === "password" ? 256 : 160}
                          autoComplete={
                            f.type === "password" ? "new-password" : "off"
                          }
                          defaultValue={
                            f.type === "password"
                              ? ""
                              : String(editor.values[f.key] ?? "")
                          }
                        />
                      )}
                    </>
                  )}
                </label>
              ))}
              <div className="button-row">
                <Button type="submit" loading={busy}>
                  Simpan
                </Button>
                <Button variant="ghost" onClick={() => setEditor(null)}>
                  Batal
                </Button>
              </div>
            </form>
          </section>
        </div>
      )}
      {orderForm && (
        <OrderForm
          products={skuOptions}
          busy={busy}
          close={() => setOrderForm(false)}
          save={async (body) => {
            const ok = await action(
              () => api("/api/resources/orders", body),
              "Pesanan berhasil dibuat.",
            );
            if (ok) setOrderForm(false);
          }}
        />
      )}
      {confirmation && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="modal"
          >
            <h2 id="confirm-title">{confirmation.title}</h2>
            <p className="muted">{confirmation.text}</p>
            <div className="button-row">
              <Button
                loading={busy}
                onClick={async () => {
                  await confirmation.perform();
                  setConfirmation(null);
                }}
              >
                Konfirmasi
              </Button>
              <Button variant="ghost" onClick={() => setConfirmation(null)}>
                Batal
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function OrderForm({
  products,
  busy,
  close,
  save,
}: {
  products: { value: string; label: string }[];
  busy: boolean;
  close: () => void;
  save: (body: unknown) => Promise<void>;
}) {
  const [lines, setLines] = useState([
    { sku: products[0]?.value ?? "", quantity: 1 },
  ]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await save({
      customer: form.get("customer"),
      dueDate: form.get("dueDate"),
      priority: form.get("priority"),
      allowPartial: form.get("allowPartial") === "on",
      lines,
    });
  }
  return (
    <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-form-title"
        className="modal"
      >
        <header>
          <h2 id="order-form-title">Tambah pesanan</h2>
          <button aria-label="Tutup form" onClick={close}>
            ×
          </button>
        </header>
        <form onSubmit={submit}>
          <label>
            Pelanggan
            <input name="customer" required maxLength={160} />
          </label>
          <label>
            Tenggat pengiriman
            <input name="dueDate" type="date" required />
          </label>
          <label>
            Prioritas
            <select name="priority">
              <option value="normal">Normal</option>
              <option value="high">Tinggi</option>
            </select>
          </label>
          <label className="check-label">
            <input name="allowPartial" type="checkbox" />
            Izinkan pengiriman parsial
          </label>
          <p className="eyebrow">ITEM PESANAN</p>
          {lines.map((line, i) => (
            <div className="line-editor" key={i}>
              <select
                aria-label={`Produk item ${i + 1}`}
                required
                value={line.sku}
                onChange={(e) =>
                  setLines(
                    lines.map((l, index) =>
                      index === i ? { ...l, sku: e.target.value } : l,
                    ),
                  )
                }
              >
                {products.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Jumlah item ${i + 1}`}
                type="number"
                min={1}
                max={1000000}
                required
                value={line.quantity}
                onChange={(e) =>
                  setLines(
                    lines.map((l, index) =>
                      index === i
                        ? { ...l, quantity: Number(e.target.value) }
                        : l,
                    ),
                  )
                }
              />
              <button
                type="button"
                disabled={lines.length === 1}
                aria-label={`Hapus item ${i + 1}`}
                onClick={() =>
                  setLines(lines.filter((_, index) => index !== i))
                }
              >
                ×
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={lines.length >= 30 || lines.length >= products.length}
            onClick={() =>
              setLines([
                ...lines,
                {
                  sku:
                    products.find((p) => !lines.some((l) => l.sku === p.value))
                      ?.value ??
                    products[0]?.value ??
                    "",
                  quantity: 1,
                },
              ])
            }
          >
            + Tambah item
          </Button>
          <div className="button-row">
            <Button loading={busy} disabled={!products.length} type="submit">
              Buat pesanan
            </Button>
            <Button variant="ghost" onClick={close}>
              Batal
            </Button>
          </div>
          {!products.length && (
            <p className="form-error">Tambahkan produk terlebih dahulu.</p>
          )}
        </form>
      </section>
    </div>
  );
}
