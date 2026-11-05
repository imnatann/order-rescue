# Order Rescue 1.0.0 — release verification

Compiled 5 November 2026 (Asia/Jakarta). This report distinguishes executed checks from supplied deployment configuration.

| Acceptance area | Evidence inspected | Result |
| --- | --- | --- |
| Authentication and permissions | `tests/auth.test.ts`, `tests/http.test.ts`; actual browser login and user/settings screens | Pass: scrypt passwords, hashed/revocable sessions, roles, persistent throttles, origin checks, last-admin protection |
| Persistent operations | SQLite schema version 2; `tests/backup.test.ts`, `tests/execution.test.ts`; browser receipt and shipment | Pass: multi-line orders, inventory, supplier offers, reservations, internal POs and audit history |
| Real LLM agent | `npm run test:live` with `inferhub/deepseek-v4.1-flash` | Pass: real inspection tool calls, structured submission, supplier-failure replan, verified execution, receiving and shipping |
| Execution correctness | `tests/planning.test.ts`, `tests/execution.test.ts` | Pass: budgets, deadlines, shared capacity, integer quantities, partial-delivery rules, idempotency, rollback, stale plans, historical supplier identity and recovery budget |
| Durable work | `tests/worker.test.ts`; lease/recovery tests; production restart smoke | Pass: real worker killed during a provider request; replacement worker reclaimed expired work and committed once. Lease expiry was accelerated in the test. |
| UI | Native browser interactions against the production build | Pass: login, navigation, product update, manual run, failed supplier, replan, approval, PO receipt, shipment, settings and both themes |
| Responsive rendering | Native browser at 390 px viewport | Pass: run page content width 390 px; no document-wide horizontal overflow. Tables scroll within their containers. |
| Automated regression suite | Node 24.22.1 and Node 26.13.0 | 40 tests passed on each runtime, 0 failures |
| Code/build checks | Type generation, `tsc --noEmit`, ESLint, production build | Pass |
| Production artifact | `npm run test:production` on Node 24.22.1 | Pass: standalone server, authenticated HTTP workflow, real LLM automatic execution, nonce CSP, relative database path, graceful shutdown and persistence across restart |
| Backup/restore | Real SQLite online backup and restore subprocess test | Pass: integrity/schema validation, state preservation and refusal to overwrite an existing target |
| Runtime dependency audit | `npm audit --omit=dev --json` | No known runtime dependency advisories at verification time. Development tooling advisories are separate. |
| Secrets | Byte scan of real provider/bootstrap secrets in client assets, standalone artifact and release source | Release gate: zero matches; private environment/database/access files excluded |
| Deployment assets | Dockerfile, Compose configuration, pinned GitHub Actions, environment templates and runbooks | Supplied; Docker image execution and remote GitHub Actions have not been run on this machine |

The live provider verification completed two planning attempts after failing the first selected supplier. It recorded 11 tool events, including outcome verification, with a final validated cost of Rp145,000. No external purchase was submitted.

The local demonstration also completed ORD-001 through browser actions: the first plan cost Rp135,000; the failed source triggered a new Rp145,000 plan; an operator approved it, recorded receipt of 150 units and shipped all 300 units. The audit trail remains in the local simulation database.

## Deployment scope

The application is prepared for a single organization on a persistent local SQLite volume with supervised web and worker processes. The local preview runs on loopback HTTP using the documented smoke-test exception. Public deployment requires an actual host/domain, HTTPS termination and a provider endpoint reachable from that host. No public deployment or external supplier integration is claimed.

Internal procurement documents and tracked supplier capacity are operational records. The application does not email suppliers, place external orders or pay invoices. Calendar arrival estimates depend on the operator-maintained data.

## Reproduce

```sh
npm ci
npm run check
# With a configured local provider:
npm run test:live
npm run test:production
```

A clean source ZIP installation was extracted into an isolated directory and verified with Node 24.22.1: `npm ci` and the complete `npm run check` passed, including all 40 tests and the production build. The separate `start:web` command was also smoke-tested: liveness responded 200 and no worker was started. The installed development toolchain reported 8 moderate advisories; the production-only audit reported zero advisories. The source package includes the exact regression tests and deployment instructions used for this release.
