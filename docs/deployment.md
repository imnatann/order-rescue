# Deployment

## Native Node deployment

Use Node.js 24 LTS (also tested on Node 26), persistent local disk, a process supervisor and an HTTPS reverse proxy. Do not expose Next directly to the internet without TLS.

1. Install locked dependencies with `npm ci`.
2. Set `APP_URL` to the exact HTTPS origin. Set `DATABASE_PATH` to a persistent absolute path, `DATA_MODE=operations`, and provider variables through the deployment's secret mechanism.
3. Run `npm run db:migrate` and `npm run admin:create`. Preserve the generated credential file securely; change the password after the first login.
4. Run `npm run check` before release; for a production-only install, build with development dependencies then `npm prune --omit=dev`.
5. Start `npm start` under systemd, launchd, a container or another process supervisor. It launches web plus worker and stops both if either exits.
6. Put the listener behind your reverse proxy at `APP_URL`. Preserve request Origin; the application does not trust arbitrary forwarded headers for CSRF or authentication.
7. Verify `/api/health`, `/api/ready`, login, creating a run, approval and a test receipt/shipment with disposable records.

For a loopback production smoke test only:

```sh
APP_URL=http://127.0.0.1:3001 PORT=3001 ALLOW_INSECURE_LOCALHOST=true npm start
```

This exception does not allow an arbitrary non-HTTPS public origin.

## Docker Compose

The image starts as the non-root Node user, includes the standalone Next build, and supervises the worker. The SQLite file and backups live in named volumes.

```sh
cp .env.production.example .env.production
# Edit APP_URL, administrator email and provider configuration. Set the real key securely.
docker compose build
docker compose run --rm app npm run db:migrate
docker compose run --rm app npm run admin:create
docker compose up -d
docker compose logs --tail=100 app
```

Port 3000 is bound to host loopback by default; terminate HTTPS at a host reverse proxy. The bootstrap-generated credentials are in `/app/data/bootstrap-access.txt` inside the persistent volume. Set a supplied bootstrap password through a secret manager to avoid needing that file.

The example provider hostname `host.docker.internal` is different from `localhost` inside a container. Ensure the provider is reachable on the host's Docker-facing interface, or use a separately secured endpoint. Do not expose an unauthenticated provider to the internet.

`docker compose exec app npm run db:backup` creates a consistent backup in the persistent backup volume. Copy backups off the machine and protect them like the primary database.

## Releases and rollback

Take an online backup before upgrades. Apply migrations using the new code. Schema version 2 adds immutable supplier-name snapshots to procurement records. The application refuses to open a database newer than its supported schema. Do not downgrade code across a schema change against the same database; restore a pre-upgrade backup to a new path and point the previous release at that path.

## Deployment verification limits

A native production launch and standalone smoke test can be verified on the development machine. Building/running the Linux Docker image requires a Docker daemon. CI is supplied for Linux Node 24 and 26 but a supplied workflow is not evidence that a remote CI run has happened. Check the release verification report for the commands actually run.
