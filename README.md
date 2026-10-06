# Arova Labs API

Express + Prisma + PostgreSQL. Serves the public website and the admin dashboard.
Scope, data model and endpoint list live in [`../SPEC.md`](../SPEC.md).

## The database is remote

Hosted Prisma Postgres, in dev and in production. cPanel never has to provide a
database and one connection string works from every host — but two consequences
follow:

- **Round trips cost ~50ms** (≈500ms for the first query after a cold pool).
  Fine for normal use, but it makes N+1 queries expensive in a way a local
  database hides. Prefer one query with `include` over several sequential ones.
- **Verify outbound 5432 from each host.** Some shared cPanel plans firewall
  non-standard outbound ports, which breaks production while Vercel and Render
  work fine. `/api/v1/ready` is the check — see `DEPLOY.md`.

Dev and production should be **separate instances**, or a `migrate reset` during
development writes to live patient data.

## Running locally

```bash
cp .env.example .env     # already present; set DATABASE_URL
npm install
npm run prisma:migrate   # create/apply migrations
npm run db:seed          # settings + the six collection centers (idempotent)
npm run dev              # http://localhost:4100
```

Port 4100, not 4000 — WSL's relay holds 4000 on this machine.

Check it:

```bash
curl http://localhost:4100/api/v1/health   # process up, no DB touched
curl http://localhost:4100/api/v1/ready    # process up AND database reachable
```

`/health` deliberately does not query the database, so a monitor can tell "app
down" from "app up, database unreachable" — two separate failures on shared
hosting.

Working offline, or want throwaway data? `npm run db:up` starts a local Postgres 17
on host port 5433; point `DATABASE_URL` at
`postgres://arova:arova@localhost:5433/arova_labs`. Nothing on the server uses
Docker — it is a local convenience only.

## Layout

```
app.js                  cPanel/Passenger startup shim → src/server.js
src/server.js           binds the port, graceful shutdown
src/app.js              Express app with no server attached (importable by tests)
src/routes.js           the API router — one place that says what exists
src/config/env.js       every env var, validated at boot; refuses unsafe prod config
src/lib/                prisma client, logger, ApiError, asyncHandler
src/middleware/         validate, rateLimit, errorHandler
src/modules/<domain>/   routes + controller + service + validation per domain
prisma/schema.prisma    the data model
storage/                uploaded prescriptions and reports (gitignored)
```

## Conventions

- **Money is integer minor units** (paise). No floats anywhere near a total.
- **Keep queries per request low.** The database is remote; see above.
- **Every async route is wrapped** in `asyncHandler` — Express 4 does not forward
  a rejected promise, and an unwrapped `await` that throws hangs the request.
- **Validation at the edge.** `validate({ body, query, params })` parses with Zod
  and replaces the request part with the parsed value; handlers never re-check.
- **Errors go through `ApiError`.** Anything else thrown is treated as a bug:
  logged with a stack, returned as a generic 500. One response shape:
  `{ error: { code, message, fields? } }`.
- **Order and payment history is snapshotted.** `OrderItem` copies the product
  title, slug and price, so editing a product never rewrites past orders.
- **Uploads are never public.** `Upload.storedPath` is a path, not a URL;
  delivery goes through a signed, expiring route.

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | nodemon, pretty logs |
| `npm start` | production start |
| `npm run db:up` / `db:down` | optional local Postgres container |
| `npm run prisma:migrate` | create + apply a migration (dev) |
| `npm run prisma:deploy` | apply existing migrations (production) |
| `npm run prisma:studio` | browse the database |
| `npm run db:seed` | import the website's static data |
| `npm run db:reset` | drop, re-migrate, re-seed |

## Deployment

See [`DEPLOY.md`](./DEPLOY.md). Short version: Render for dev/testing, cPanel
"Setup Node.js App" for production. No Docker on the server — Compose here is a
local convenience only.
