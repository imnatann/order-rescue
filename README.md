# Order Rescue

A persistent, authenticated fulfillment workspace for a distributor. A real LLM agent inspects orders, inventory and supplier offers, submits a structured plan, and executes validated internal reservations and procurement drafts. The UI uses NamurUI's Ember identity and actual vendored Button and Tool Call Card components.

## Quick start (local simulation)

Requires Node.js 24 LTS or 26 LTS and npm. Use the Node version in `.nvmrc` for a reproducible environment.

```sh
npm ci
cp .env.example .env.local
# Set LLM_API_KEY in .env.local; do not put it in a NEXT_PUBLIC_ variable.
npm run db:migrate
npm run admin:create
npm run db:seed
npm run dev
```

Open **http://127.0.0.1:3000** (the same origin as `APP_URL`). The bootstrap command creates a unique administrator password in `data/bootstrap-access.txt` with owner-only permissions. If an administrator already exists, it preserves the account. In production, optionally supply `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME` and `BOOTSTRAP_ADMIN_PASSWORD` through your secret manager. There is no shared default password.

`npm run dev` starts BOTH Next.js and the durable worker. The supervisor stops both when either process exits. `npm run dev:web` and `npm run worker` are available for separate terminals.

## Product workflow

1. Manage products, warehouses, physical inventory, suppliers and offers. Create an order with one or more SKU lines, a deadline, priority and partial-delivery policy.
2. Select orders; enter a total procurement-and-shipping budget and fulfillment goal. Choose manual approval or automatic execution within those constraints.
3. The worker claims a durable run, asks the configured LLM to call inspection tools, optionally computes a candidate, and accepts `submit_plan` only after deterministic validation.
4. Review the plan and tool evidence. In manual mode, approve it. The executor revalidates current quantities, deadlines, authorization and costs inside one database transaction.
5. Warehouse stock is reserved. Supplier allocations create **internal draft POs** and reserve tracked offer capacity. No order, email, payment or request is submitted to an external supplier.
6. Record physical receipt of a PO into a warehouse; incoming stock is reserved for the order. Record shipment to decrease physical stock and complete fulfillment.
7. If a supplier offer fails, mark it failed. Unreceived active allocations in affected runs are released and queued for recovery. Received goods remain in inventory; already incurred costs reduce the recovery budget. Historical runs, POs and audit events remain available.

Simulation mode includes a control to fail a supplier between planning and execution. It demonstrates automatic replanning without making external purchases. The simulation seed is idempotent and refuses to run in operations mode.

## Security and roles

- **Admin:** all operations plus user creation, role changes, account disabling and provider checks.
- **Operator:** manage business records, create/approve/cancel/retry runs, receive stock, ship orders, recover failed offers and read audit logs.
- **Viewer:** inspect operations, runs, evidence and exports; no business mutations.

Passwords use asynchronous salted scrypt. Session tokens are random, hashed at rest, HttpOnly, SameSite Strict and Secure when `APP_URL` is HTTPS. Role/password changes and account disabling revoke sessions. Login and API throttles are stored in the database. Every API read and write enforces authorization; mutation endpoints also require the configured Origin and `X-Requested-With: OrderRescue`. Request bodies are capped at 64 KiB including streamed bodies. Pages use nonce-based script CSP; inline styles are allowed for NamurUI's self-contained styles and visual state. No model text is executed as HTML or code.

Provider credentials stay in server-only modules and the ignored local environment. Model calls have a timeout and response-size cap. Provider bodies, passwords and tokens are not logged. `data/`, backups, `.env.local` and bootstrap credentials are excluded from Git, build tracing, container context and release archives.

## Configuration

See [.env.example](.env.example) and [.env.production.example](.env.production.example).

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Exact browser origin. Required HTTPS in production behind a TLS reverse proxy. |
| `DATABASE_PATH` | SQLite file on persistent local storage shared by web and worker. |
| `DATA_MODE` | `simulation` for demonstration, `operations` for an empty real workspace. |
| `LLM_BASE_URL` | OpenAI-compatible Chat Completions base URL, including `/v1`. |
| `LLM_API_KEY` | Provider secret, server only. |
| `LLM_MODEL` | Requested model ID; configured integration uses `inferhub/deepseek-v4.1-flash`. |
| `PORT`, `HOSTNAME_OVERRIDE` | Listener port/address; default `3000` and loopback. |
| `ALLOW_INSECURE_LOCALHOST` | `true` only for a loopback production smoke test without TLS. |

`localhost:20128` refers to the machine/container running the server. For remote hosting, use an authenticated provider endpoint reachable from that deployment. No provider is hardcoded in client code.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Web and durable worker in development |
| `npm run check` | Type generation, TypeScript, project lint, automated tests and production build |
| `npm run test:production` | Standalone production HTTP workflow with live LLM, shutdown and restart in an isolated database |
| `npm run test:live` | Real-provider workflow, failed-supplier replanning, receiving and shipping in an isolated temporary database |
| `npm run build` | Production and standalone artifacts |
| `npm start` | Supervised production web and worker |
| `npm run db:migrate` | Apply transactional, versioned schema migrations |
| `npm run admin:create` | Bootstrap first administrator without overwriting existing accounts |
| `npm run db:seed` | Seed synthetic data in simulation mode only |
| `npm run db:backup -- [new-file.sqlite]` | Consistent SQLite online backup |
| `npm run db:restore -- backup.sqlite new-file.sqlite` | Validate and restore into a NEW file, preserving existing data |
| `npm run format` | Format project code; vendored Namur sources remain unchanged |

## Deployment and operations

Read [deployment](docs/deployment.md), [operations](docs/operations.md), [architecture](docs/architecture.md), [API](docs/api.md), [acceptance criteria](docs/production-requirements.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

Deploy one web instance and one worker on the same persistent local disk. SQLite WAL and transactions protect reservations across processes. This deployment is intentionally a single organization; do not run separate ephemeral instances or put the SQLite file on network storage. The current UI displays the 500 most relevant orders, 100 newest runs and 500 latest events per run; the database retains history. Database scaling or multi-organization hosting needs a separate architecture change.

The software records internal operations. Warehouse availability, supplier capacity, lead times and prices must be kept current by an authorized operator or a separately implemented ERP integration. Arrival dates use calendar-day estimates, not carrier guarantees. Metrics represent actual database actions; no time or cost savings are invented.
