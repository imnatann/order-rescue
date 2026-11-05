# Architecture

## Components

- Next.js App Router: server-rendered authenticated shell and login; responsive NamurUI dashboard.
- `src/server/http.ts`, `auth.ts`: bounded input, same-origin controls, role enforcement, hashed sessions, scrypt credentials, persistent throttles and safe errors.
- `src/server/db.ts`: SQLite WAL, foreign keys, full synchronous commits, five-second busy timeout and transactional schema migrations. Database files are not bundled into builds.
- `store.ts`: domain records, operational reads and audited resource changes.
- `planning.ts`: deterministic plan validation and a clearly labelled non-optimal candidate heuristic.
- `agent.ts`: bounded real LLM tool-calling loop; inspection tools, candidate generation and structured plan submission. Tool results are untrusted data. No arbitrary SQL, shell or browser tool is exposed to the model.
- `execution.ts`: durable queue state machine, approval, cancellation, retry, recovery, atomic reservation, inbound receipts and outbound shipment.
- `scripts/worker.ts`: separate durable worker with heartbeat, lease extension and recovery. The web request only queues work; browser disconnects do not stop runs.
- `scripts/start.mjs`: supervised web/worker lifecycle and production HTTPS-origin gate.

## State machine

`queued -> planning -> awaiting_approval -> queued -> executing -> completed`

With explicit automatic execution: `planning -> queued -> executing`.

Planning failures become `failed`; invalid/stale execution plans return to `queued` for up to three planning attempts. Exhausted or unsafe executions become `needs_attention`. Cancellation is durable and prevents a late model response from writing a plan. An expired worker lease is reclaimed; the former owner cannot save or execute.

Supplier failure after reservation releases affected runs' still-active allocations and cancels their unreceived draft POs. It leaves shipped and received history intact. A recovery run inherits the remaining goal and budget after already-incurred costs, while the original is marked `superseded`. Conflicts with another active run require operator attention rather than creating overlapping recovery work.

## Invariants

- Inventory: `0 <= reserved <= on_hand`; offers: `0 <= reserved <= available`.
- Plans allocate only selected order lines and matching SKUs; all quantities are positive integers.
- Shared sources cannot be overbooked across lines or orders. Fulfilled units and active reservations reduce remaining demand.
- Partial fulfillment requires BOTH order and run permission. Full-only plans cover every remaining line.
- Calendar arrival estimates must be on or before each order deadline.
- Approval summaries are generated from validated facts; the model's original decision summary stays in the tool evidence.
- Total cost is computed in code: procurement plus one shipping charge per source per order. Unsafe integer totals and over-budget plans are rejected.
- Execution revalidates the latest snapshot under `BEGIN IMMEDIATE`, rechecks authorizing users, commits reservations and drafts atomically, and queries the results before marking them verified.
- A completed run is idempotent. A repeated idempotency key returns the same run only for identical constraints. PO receipt and completed shipment are idempotent.
- Cancellations release only active holds. Received inventory remains physical inventory. Supplier identity is snapshotted into historical POs.
- An administrator cannot remove the last active administrator.

## Operational boundaries

One organization, one durable disk, one web process and one worker. Multiple workers can coordinate leases on the same host, but the packaged configuration runs one. No external supplier integration, payments, email transmission, carrier guarantee or multi-tenant isolation is claimed. Internal POs require operational submission outside this application until a supplier integration is configured.

## References

- Node.js SQLite: https://nodejs.org/api/sqlite.html
- Node.js cryptography: https://nodejs.org/api/crypto.html
- Next.js bundled version documentation: `node_modules/next/dist/docs/`
- NamurUI attribution and pinned commit: `docs/namur-integration.md`
