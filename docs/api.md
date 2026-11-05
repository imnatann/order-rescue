# API contract

All business endpoints require the HttpOnly session cookie set by login. Mutations require the exact `Origin` configured by `APP_URL`, `Content-Type: application/json`, and `X-Requested-With: OrderRescue`. Every body is schema-validated and limited to 64 KiB including streamed bodies. Responses use `Cache-Control: no-store`.

## Session and system

| Method | Path | Access / purpose |
| --- | --- | --- |
| GET | `/api/health` | Public liveness |
| GET | `/api/ready` | Public dependency booleans; 503 if degraded |
| POST | `/api/auth/login` | `{email,password}`; generic auth error; persistent throttle |
| POST | `/api/auth/logout` | Authenticated; revokes current session |
| GET | `/api/auth/me` | Authenticated user without password hash |
| POST | `/api/auth/password` | `{currentPassword,newPassword}`; revokes all user sessions |
| GET | `/api/settings` | Safe model/runtime status; never API key |
| POST | `/api/provider/check` | Admin only; real bounded provider request |

## Operations

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/workspace` | Consistent operational dashboard payload |
| GET | `/api/orders`, `/api/orders/:id` | Orders and line-level remaining/allocated/shipped units |
| GET | `/api/products`, `/api/warehouses`, `/api/inventory` | Product and inventory reads |
| GET | `/api/suppliers`, `/api/purchases` | Supplier/offer and procurement reads |
| POST | `/api/resources/:resource` | Operator/admin create or upsert `products`, `warehouses`, `inventory`, `suppliers`, `offers`; create `orders` |
| POST | `/api/orders/:id/ship` | Ship ready allocations; enforce full-only policy |
| POST | `/api/orders/:id/cancel` | Release active holds and cancel unreceived drafts |
| POST | `/api/purchases/:id/receive` | `{warehouseId}`; idempotent receipt into reserved inventory |
| POST | `/api/offers/:id/fail` | Deactivate source and queue recovery for committed unreceived allocations |
| POST | `/api/simulation/fail-offer` | `{offerId}`; simulation mode only |

## Agent

`POST /api/runs` accepts:

```json
{
  "orderIds": ["ORD-001"],
  "maxCostIdr": 500000,
  "allowPartialDelivery": false,
  "autoExecute": false,
  "goal": "Penuhi sebelum tenggat dalam anggaran."
}
```

Supply an `Idempotency-Key` header (8–100 safe alphanumeric/underscore/hyphen characters). Identical constraints return the prior run; a key reused for different constraints is rejected. Response: 202 with persisted `{run}`. A worker processes it independently of the HTTP connection.

- GET `/api/runs/:id`: run plus latest 500 evidence events.
- POST `/api/runs/:id/approve`: manual approval, then queue validated execution.
- POST `/api/runs/:id/cancel`: durable cancellation before commit.
- POST `/api/runs/:id/retry`: reset failed/cancelled unexecuted work after resolving conflicts.

The LLM can call only `inspect_orders`, `inspect_inventory`, `inspect_supplier_offers`, `build_candidate_plan` and `submit_plan`. It cannot execute arbitrary code, SQL, payments or supplier communications.

## Users, audit and exports

- GET/POST `/api/users`, PATCH `/api/users/:id`: admin only; minimum new password length 12; last active administrator is protected.
- GET `/api/audit?before=<id>`: admin/operator, 100 events per page.
- GET `/api/export/orders.csv`: authenticated, bounded current order view; spreadsheet formula prefixes neutralized.
- GET `/api/export/runs/:id`: authenticated JSON evidence export.

Errors use `{error,code}` with appropriate HTTP status. Typical statuses: 400 invalid input, 401 no valid session, 403 role/origin denial, 404 unknown resource, 409 stale/unsafe business operation, 413 payload limit, 429 throttled, 500 safe unexpected error.
