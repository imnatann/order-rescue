# Demonstration guide (3–5 minutes)

Use a disposable simulation database in its own directory. Do not reset production data to rehearse.

1. Show the order, stock across two warehouses, and supplier prices/lead times. Explain that the interface and API represent a distributor's internal operations.
2. Select an order with a shortage; set a procurement-and-shipping budget and manual approval. Start rescue.
3. Show the live tool evidence: selected orders, inventory, supplier offers, candidate and submitted plan. Explain the deterministic cost, quantity and deadline checks.
4. Click **Simulasikan pemasok gagal** on a plan that uses a supplier. Show `replan_required` and the replacement source. The agent must keep the budget and deadline constraints.
5. Approve the replacement plan. Show verified reservations and the newly created internal draft PO.
6. In the simulation, record receipt into a warehouse and then shipment. Show the fulfilled order and updated physical stock.
7. Close with auditability, restart-safe work, permission controls, and measured operational counters. Do not describe internal PO creation as a real external supplier order or claim unmeasured savings.

For a new rehearsal workspace, use a separate directory, for example `DATABASE_PATH=data/rehearsal/order-rescue.sqlite DATA_MODE=simulation`. Run migration, administrator bootstrap and seed with the same environment, then launch web/worker using that path. Bootstrap credentials are written in that database directory.
