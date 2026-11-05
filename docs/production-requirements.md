# Production acceptance criteria

Order Rescue is a single-organization distributor operations application. Deploy one web instance and one durable worker on the same local SQLite volume; it is not an ephemeral/serverless deployment.

1. Server-enforced authentication, revocable sessions, administrator/operator/viewer permissions, login throttling and same-origin mutation protection. No default production password.
2. Persistent products, warehouses, inventory, supplier offers, multi-line orders, procurement documents, reservations, users, runs and audit events. Schema migrations and validated inputs.
3. Real configured LLM tool-calling loop: read operational tools, submit a structured plan, validate quantities/costs/deadlines in code, persist the plan, approve or execute within user constraints, verify results.
4. Transactional execution: no overselling, no budget bypass, no duplicate actions, no stale-plan execution. Replan automatically when an offer fails or availability changes; bounded attempts and durable failure state.
5. Durable queued work with leases, cancellation, retry, restart recovery and observable tool events. A stopped process cannot silently lose a run.
6. Working Namur UI: login, operations dashboard, searchable orders and details, forms to manage operational data, run constraints, plans, approvals, history, supplier failure demonstration, procurement receiving, shipping, audit and user administration.
7. Business metrics calculated from persisted events, source provenance for suggested actions, clear simulated supplier integration labels. No fabricated success or claimed external supplier purchase.
8. Automated tests for validation, allocation, deadline/budget enforcement, concurrency/idempotency, rollback, replan/recovery, session/role restrictions, API flows and actual configured provider compatibility.
9. Production build, type checking and project lint pass. Secrets absent from client bundles and distributable source. Security headers, bounded payloads, timeouts, error handling and health/readiness checks.
10. Deployment scripts/container definition, migration/seed/bootstrap CLI, backup/restore and operational documentation, reproducible package lock, environment template, CI and release archive. Smoke-test the production process; report unverified deployment environments explicitly.

External integrations: warehouse/supplier systems are represented by the application's persisted inventory and offers. Purchase orders are internal drafts; no third-party email, order submission, payments or external purchasing occurs without a separately configured integration. The demo failure controls are available only in simulation mode. Production can start with empty operational data.
