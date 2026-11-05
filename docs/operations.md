# Operations runbook

## Daily operations

Keep physical inventory and supplier offers current. Capacity includes reserved quantity, so adjustments cannot reduce physical stock or capacity below active holds. Record actual PO receipt before shipment. A draft PO is an internal document; the application does not contact the supplier or transfer money.

The approval screen shows sources, quantities, dates and server-computed cost. Manual approval cannot authorize a higher cost that appears later; a changed price or source triggers replanning and a new approval. Automatic mode uses the budget explicitly set by the operator.

## Failed suppliers

Use **Pemasok -> Tandai gagal**. If no committed holds exist, the offer is deactivated; pending plans are revalidated when executed. If unreceived allocations exist, active allocations in affected runs are released, unreceived drafts are cancelled, and recovery work is queued. Already shipped quantities stay fulfilled. Received goods stay in the receiving warehouse. Recovery budget deducts received PO cost and already shipped warehouse fees.

If another active run covers the same order, the original is marked for attention rather than creating overlapping work. Finish/cancel that other run, then start rescue for the remaining demand. Reactivate an offer only after confirming the supplier's capacity and lead time.

## Worker recovery

`/api/ready` requires a database, configured provider and worker heartbeat less than 30 seconds old. It does not spend tokens to probe the LLM. **Pengaturan -> Uji koneksi LLM** performs a real provider request.

The worker refreshes its lease every 10 seconds; leases last 120 seconds. After an abrupt crash, another worker reclaims the expired lease and replans safely. Graceful termination aborts the current model request and expires its lease. Three planning attempts is the automatic limit. Retry a failed run after correcting the cause; all prior events remain in the database.

If the whole supervised application exits, restart it using the host process supervisor. Persistent queue rows survive. Never delete the database to restart a stuck run.

## Backups and restore drill

```sh
npm run db:backup -- backups/daily-2026-11-04.sqlite
npm run db:restore -- backups/daily-2026-11-04.sqlite data/restored.sqlite
```

The backup API creates a consistent snapshot even while the app is active. Restore validates SQLite integrity, foreign keys and schema, writes to a NEW file and refuses to overwrite existing data. Stop web and worker, change `DATABASE_PATH` to the restored file, then restart. Verify login, representative orders, reservations and queue state before accepting traffic.

Retain at least one backup outside the deployment host. Backups contain customer/order data and hashed credentials/sessions; restrict access and encrypt off-host storage. The application creates files with owner-only permissions where supported.

## Monitoring

- Liveness: `/api/health` (public, no business data).
- Readiness: `/api/ready` (public dependency booleans only).
- Worker startup/fatal messages and safe API error logs: structured JSON, no provider bodies or credentials.
- Business audit: authorized **Jejak audit**, with actor, action and entity.
- Per-run evidence: inspection results, validation failures, model usage counters, plans, committed actions and outcome verification. No private reasoning traces are recorded.

## Data retention and limits

The database retains historical runs, audit records and operational documents. The UI is bounded to 500 relevant orders, 100 recent runs and 500 latest events per selected run. Review database size and backup retention periodically. No automatic destructive retention job runs.

This deployment is a single organization on one disk. Do not horizontally scale independent web/worker containers against separate SQLite copies. Use a deliberate database migration and tenant-isolation design for that requirement.
