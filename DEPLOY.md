# Deploying

Three units, one hosted database.

| Unit | Dev / testing | Production |
| --- | --- | --- |
| `website/` | Vercel | cPanel — static build in the `arovalabs.com` docroot |
| `admin/` | Vercel | cPanel — static build in the `admin.arovalabs.com` docroot |
| `backend/` | Render web service | cPanel — Setup Node.js App on `api.arovalabs.com` |
| Database | hosted Prisma Postgres | hosted Prisma Postgres (separate production instance) |
| Files | local disk | local disk outside `public_html` |

The database being remote is what keeps this simple: cPanel never has to provide
one, and the same `DATABASE_URL` works from every host. The tradeoff is that the
app must be able to reach it.

---

## Before you deploy anywhere

**Create a separate production database.** Right now dev and production would
share one instance, which means `prisma migrate reset` or a re-seed during
development writes to live patient data. Make a second Prisma Postgres instance
and give production its own `DATABASE_URL` before the site takes a real booking.

**Rotate the credentials that have been shared** — the Prisma connection string
and the Razorpay keys both travelled through a chat log. Test keys are low risk;
the database URL is not.

---

## Render (dev / testing)

1. New → Web Service, point at the repo, root directory `backend`.
2. Build: `npm ci && npx prisma generate && npx prisma migrate deploy`
3. Start: `npm start`
4. Health check path: `/api/v1/health`
5. Environment: copy from `.env.example`. Set at minimum
   `NODE_ENV=production`, `DATABASE_URL`, both JWT secrets (real random values —
   the app refuses to boot in production while they still say `change-me`),
   `CORS_ORIGINS` (the Vercel website and admin URLs), `TRUST_PROXY=true`,
   `JOB_RUNNER=inline`.

Render assigns `PORT` itself; nothing hardcodes it.

## Vercel (website + admin, dev / testing)

One project each, root directory `website` and `admin`.

- Build `npm run build`, output `dist`.
- `VITE_API_URL` → the Render API URL. It is baked in at build time, so changing
  it needs a redeploy, not just an env edit.
- Add both Vercel URLs to the API's `CORS_ORIGINS`.

---

## cPanel (production)

### 1. Subdomains and document roots

Create in cPanel → Domains:

| Subdomain | Document root |
| --- | --- |
| `arovalabs.com` | `public_html` |
| `admin.arovalabs.com` | `public_html/admin` |
| `api.arovalabs.com` | `arova-api/public` *(Passenger serves the app, not this folder)* |

Issue SSL for all three (cPanel → SSL/TLS Status → Run AutoSSL). The admin and
API must be HTTPS or the cross-subdomain refresh cookie will not be sent.

### 2. Node app

cPanel → Setup Node.js App → Create Application:

- **Node version:** 20 (or 22). `package.json` declares `>=20 <25`.
- **Application root:** `arova-api`
- **Application URL:** `api.arovalabs.com`
- **Application startup file:** `app.js` — the shim at the repo root that
  requires `src/server.js`. Passenger supplies `PORT`.

Then add the environment variables from `.env.example` in that same screen.
Production-specific values:

```
NODE_ENV=production
DATABASE_URL=<production Prisma Postgres URL>
JWT_ACCESS_SECRET=<random>         # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_REFRESH_SECRET=<random>
CORS_ORIGINS=https://arovalabs.com,https://admin.arovalabs.com
PUBLIC_URL=https://arovalabs.com
ADMIN_URL=https://admin.arovalabs.com
API_URL=https://api.arovalabs.com
COOKIE_DOMAIN=.arovalabs.com
TRUST_PROXY=true
STORAGE_LOCAL_ROOT=/home/<cpanel-user>/arova-storage
JOB_RUNNER=external
INTERNAL_JOB_TOKEN=<random>
```

`STORAGE_LOCAL_ROOT` **must** be outside `public_html`. Prescriptions and lab
reports are patient data; if they sit under a document root, Apache will serve
them to anyone who guesses the filename, bypassing the signed-download route
entirely.

### 3. Deploy and migrate

From cPanel → Terminal (or over SSH):

```bash
cd ~/arova-api
git pull
npm ci --omit=dev
npx prisma generate
npx prisma migrate deploy      # no shadow database needed, unlike `migrate dev`
npm run db:seed                # idempotent — tops up new default settings
mkdir -p /home/$USER/arova-storage
```

Then hit **Restart** in Setup Node.js App. Passenger reloads on restart, not on
file change.

> `prisma migrate dev` is a development command — it wants to create a shadow
> database and can prompt to reset. Production always uses `migrate deploy`.

### 4. Verify, in this order

```bash
curl https://api.arovalabs.com/api/v1/health   # app up?
curl https://api.arovalabs.com/api/v1/ready    # database reachable from cPanel?
```

`/ready` is the one that matters here. **If it reports the database as down,
cPanel is firewalling outbound 5432** — some shared plans block non-standard
outbound ports. Test it before building anything on top:

```bash
node -e "require('net').createConnection(5432,'pooled.db.prisma.io').on('connect',()=>{console.log('outbound 5432 OK');process.exit(0)}).on('error',e=>{console.log('BLOCKED:',e.message);process.exit(1)})"
```

If it is blocked, ask support to allow it. Failing that the database has to move
to cPanel's own Postgres (if the plan offers it) or MySQL, which means switching
the Prisma provider — so find out early.

### 5. Static builds

Build locally or in CI with the production API URL, then upload `dist/` to the
matching document root:

```bash
cd website && VITE_API_URL=https://api.arovalabs.com npm run build
cd ../admin  && VITE_API_URL=https://api.arovalabs.com npm run build
```

Each docroot needs an `.htaccess`, or every client-side route will 404 on
refresh — Apache looks for a file at `/tests/` and there isn't one:

```apache
Options -MultiViews
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]
RewriteRule ^ index.html [L]

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json image/svg+xml
</IfModule>

# Vite emits content-hashed filenames, so assets can be cached hard while
# index.html must never be, or visitors keep getting the old app shell.
<FilesMatch "\.(js|css|woff2?|svg|png|jpe?g|webp|avif)$">
  Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>
<FilesMatch "index\.html$">
  Header set Cache-Control "no-cache, must-revalidate"
</FilesMatch>
```

### 6. Cron

Passenger stops an idle application, so an in-process timer never fires reliably
— that is why `JOB_RUNNER=external` in production. Scheduled work is triggered
over HTTP instead. cPanel → Cron Jobs:

```
# every 15 minutes — webhook retries, abandoned carts, report reminders
*/15 * * * * curl -fsS -H "Authorization: Bearer $INTERNAL_JOB_TOKEN" https://api.arovalabs.com/api/v1/internal/jobs/tick >/dev/null

# nightly 02:00 — slot generation, cleanup
0 2 * * * curl -fsS -H "Authorization: Bearer $INTERNAL_JOB_TOKEN" https://api.arovalabs.com/api/v1/internal/jobs/nightly >/dev/null
```

Substitute the real token — cPanel cron does not read the app's environment.

### 7. Razorpay webhook

Razorpay dashboard → Settings → Webhooks:

- URL `https://api.arovalabs.com/api/v1/payments/webhook`
- Secret → also set as `RAZORPAY_WEBHOOK_SECRET`
- Events: `payment.captured`, `payment.failed`, `refund.processed`,
  `order.paid`

The webhook route is mounted ahead of the JSON body parser so the raw body
survives for signature verification. Verification failing with a correct secret
almost always means something re-serialised the body first.

### 8. Backups

The hosted Prisma Postgres handles its own backups — confirm the retention on
your plan. For an independent copy:

```bash
0 3 * * * pg_dump "$DATABASE_URL" | gzip > ~/backups/arova-$(date +\%F).sql.gz
```

Back up `STORAGE_LOCAL_ROOT` too; uploaded reports are not in the database and
are not in version control.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 503 from Passenger | Startup threw. See `~/arova-api/stderr.log` and cPanel's error log. Usually a failed env validation — the message names the variable. |
| App refuses to boot, "unsafe configuration" | `NODE_ENV=production` with placeholder JWT secrets or empty `CORS_ORIGINS`. Intentional. |
| `/ready` says database down | Outbound 5432 blocked, or a stale `DATABASE_URL`. See §4. |
| Admin logs in then logs straight out | Refresh cookie not reaching the API. Needs HTTPS on both subdomains, `COOKIE_DOMAIN=.arovalabs.com`, and the admin origin in `CORS_ORIGINS`. |
| Client-side routes 404 on refresh | Missing `.htaccess` in that docroot. |
| Rate limiting blocks everyone at once | `TRUST_PROXY` not set, so every request looks like it comes from the proxy's IP. |
| Changes not live after `git pull` | Passenger needs an explicit Restart. |
