import "./load-env";
import { all, closeDb, exec, now, transaction } from "../src/server/db";
import { dataMode } from "../src/server/store";
import { todayJakarta, addDays } from "../src/server/planning";
if (dataMode() !== "simulation")
  throw new Error("Seeding is permitted only with DATA_MODE=simulation.");
transaction(() => {
  if (all("SELECT sku FROM products LIMIT 1").length) {
    console.log("Operational data already exists; seed skipped.");
    return;
  }
  for (const [sku, name] of [
    ["CUP-250", "Gelas kertas 250 ml"],
    ["BOX-M", "Kotak makanan ukuran M"],
    ["BAG-L", "Tas kertas ukuran L"],
    ["SEAL-90", "Segel gelas 90 mm"],
  ])
    exec("INSERT INTO products(sku,name) VALUES(?,?)", sku, name);
  exec(
    "INSERT INTO warehouses VALUES('WH-01','Gudang Jakarta',0,0),('WH-02','Gudang Bekasi',1,5000)",
  );
  for (const [w, s, q] of [
    ["WH-01", "CUP-250", 100],
    ["WH-02", "CUP-250", 50],
    ["WH-01", "BOX-M", 200],
    ["WH-02", "BOX-M", 80],
    ["WH-01", "BAG-L", 50],
    ["WH-02", "SEAL-90", 300],
  ] as const)
    exec(
      "INSERT INTO inventory(warehouse_id,sku,on_hand) VALUES(?,?,?)",
      w,
      s,
      q,
    );
  exec(
    "INSERT INTO suppliers(id,name) VALUES('SUP-01','Kemasan Prima'),('SUP-02','Mitra Pack'),('SUP-03','Nusa Packaging')",
  );
  for (const [i, s, sku, qty, price, days, shipping] of [
    ["OFF-01", "SUP-01", "CUP-250", 500, 900, 1, 5000],
    ["OFF-02", "SUP-02", "CUP-250", 500, 800, 1, 10000],
    ["OFF-03", "SUP-03", "BOX-M", 400, 1500, 1, 5000],
    ["OFF-04", "SUP-03", "CUP-250", 300, 1000, 2, 5000],
    ["OFF-05", "SUP-01", "BAG-L", 500, 1200, 1, 5000],
    ["OFF-06", "SUP-02", "SEAL-90", 1000, 150, 1, 5000],
  ] as const)
    exec(
      "INSERT INTO offers(id,supplier_id,sku,available,unit_price_idr,lead_time_days,shipping_cost_idr) VALUES(?,?,?,?,?,?,?)",
      i,
      s,
      sku,
      qty,
      price,
      days,
      shipping,
    );
  const today = todayJakarta();
  const seedOrders = [
    {
      id: "ORD-001",
      name: "Kopi Senja",
      days: 2,
      priority: "high",
      partial: 0,
      lines: [["CUP-250", 300]],
    },
    {
      id: "ORD-002",
      name: "Roti Pagi",
      days: 3,
      priority: "normal",
      partial: 0,
      lines: [["BOX-M", 120]],
    },
    {
      id: "ORD-003",
      name: "Dapur Nusa",
      days: 4,
      priority: "normal",
      partial: 1,
      lines: [
        ["CUP-250", 100],
        ["BOX-M", 100],
      ],
    },
    {
      id: "ORD-004",
      name: "Pasar Organik",
      days: 3,
      priority: "high",
      partial: 1,
      lines: [["BAG-L", 150]],
    },
    {
      id: "ORD-005",
      name: "Teh Sore",
      days: 2,
      priority: "normal",
      partial: 0,
      lines: [["SEAL-90", 200]],
    },
  ];
  for (const o of seedOrders) {
    exec(
      "INSERT INTO orders(id,customer,due_date,priority,allow_partial,created_at) VALUES(?,?,?,?,?,?)",
      o.id,
      o.name,
      addDays(today, o.days),
      o.priority,
      o.partial,
      now(),
    );
    o.lines.forEach(([sku, qty], i) =>
      exec(
        "INSERT INTO order_lines(id,order_id,sku,quantity) VALUES(?,?,?,?)",
        `${o.id}-L${i + 1}`,
        o.id,
        String(sku),
        Number(qty),
      ),
    );
  }
  console.log("Simulation data seeded: 5 orders, 2 warehouses, 3 suppliers.");
});
closeDb();
