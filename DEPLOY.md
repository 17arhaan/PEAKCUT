# Going Live — Deployment Guide

Two deployables: the **web app** (Vercel) and the **worker** (Modal). They meet
at the worker seam (`web/lib/worker.ts`) — with `MODAL_TOKEN_*` set the web app
dispatches jobs to Modal; unset, it runs the pipeline as a local subprocess.

> Local dev needs none of this: `docker compose up -d db` + `npm run dev` runs
> the whole product with a stub worker and dev sign-in. See `web/SETUP.md`.

---

## Accounts to create (all have free tiers)

Do these in order. Each row lists exactly what value the deploy needs back.

| # | Account | Free? | What to create | Value(s) needed |
|---|---------|-------|----------------|-----------------|
| 1 | **Neon** (neon.tech) | Yes | A project → a Postgres database | The **pooled connection string** (`postgresql://...-pooler...`) |
| 2 | **Cloudflare R2** (dash.cloudflare.com → R2) | Yes (10GB) | A bucket named `peakcut` + an API token | Account ID, Access Key ID, Secret Access Key, bucket name |
| 3 | **Modal** (modal.com) | Yes ($30/mo credit) | `modal token new` on the deploy machine | Token ID + secret |
| 4 | **Vercel** (vercel.com) | Yes | Connect the GitHub `PEAKCUT` repo | Sign in with GitHub — the rest is CLI or "Import" |
| 5 | **Google Cloud** (console.cloud.google.com) | Yes | OAuth 2.0 credentials (for real logins) | Client ID + Client Secret |
| 6 | **Dodo Payments** (dodopayments.com) | Yes | Merchant account (last — for charging money) | API key + webhook secret |

**Launch needs only 1–4.** Google OAuth (5) and Dodo (6) layer on after — the
app works with dev-login and no billing until then.

---

## 1. Database (Neon)

The schema lives in `web/lib/db/schema.ts` and is synced with drizzle-kit. The
repo has no committed SQL migrations — dev syncs directly with `push`:

```bash
cd web
DATABASE_URL=<neon-pooled-url> npx drizzle-kit push   # sync schema to the DB
```

Fine for the first deploy against an empty DB. Before real traffic, switch to
versioned migrations — `drizzle-kit generate` writes SQL into `./drizzle`,
commit it, then `drizzle-kit migrate` on deploy — so schema changes replay
deterministically instead of being diffed against live tables.

## 2. Worker (Modal)

The pipeline is one Modal app (`worker/src/shorts/modal_app.py`, app
`peakcut`) with a `trigger` web endpoint the Next.js app calls and a
`process_job` function that runs the pipeline, uploads clips to R2, and
calls back to `/api/worker/callback` (progress + done/error).

```bash
cd worker
modal secret create anthropic ANTHROPIC_API_KEY=<key>   # once
# once -- the web<->worker bridge secret + R2 creds the worker uploads with:
modal secret create peakcut-web \
  WORKER_SHARED_SECRET=$(openssl rand -hex 32) \
  R2_ACCOUNT_ID=<id> R2_ACCESS_KEY_ID=<key> R2_SECRET_ACCESS_KEY=<secret> R2_BUCKET=peakcut
modal deploy src/shorts/modal_app.py                    # deploy / redeploy
modal run src/shorts/modal_app.py --source <url>        # smoke-test one run
```

`modal deploy` prints the `trigger` endpoint URL — that's `MODAL_TRIGGER_URL`
for the web app, and the same `WORKER_SHARED_SECRET` goes into both the Modal
secret and the Vercel env.

Live crew vs stub is controlled by `SHORTS_LLM` inside the function (see the
header comment in `modal_app.py`). Model selection: `SHORTS_LLM_MODEL_<AGENT>`
> `SHORTS_LLM_MODEL` > per-agent defaults (Critic runs `claude-haiku-4-5`,
everything else `claude-sonnet-5`).

## 3. Web (Vercel)

Set env vars in the Vercel project (Production scope), then deploy. Keys mirror
`web/.env.example`:

| Var | Required | Notes |
|-----|----------|-------|
| `DATABASE_URL` | ✅ | Neon pooled connection string. |
| `AUTH_SECRET` | ✅ | `openssl rand -base64 32`. |
| `AUTH_DEV` | — | **Must be unset in prod** — `1` enables passwordless login. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✅ (prod auth) | Real sign-in once the dev provider is off. |
| `MODAL_TRIGGER_URL` | ✅ (real jobs) | The deployed `trigger` endpoint URL. |
| `WORKER_SHARED_SECRET` | ✅ (real jobs) | Same value as in the `peakcut-web` Modal secret. |
| `APP_URL` | ✅ (real jobs) | Public base URL (callback target), e.g. `https://peakcut.app`. |
| `R2_*` (all four) | ✅ (clip storage) | Object storage for uploads + rendered clips; unset → local disk. |
| `DODO_API_KEY` / `DODO_WEBHOOK_SECRET` | — | Billing; unset → credits are manual. |
| `CRON_SECRET` | — | Bearer token for the stuck-job sweeper (`app/api/cron/sweep`). |

```bash
cd web
vercel --prod        # or push to the connected branch
```

After deploy, sanity-check: sign in works, `/dashboard/new` submits a job, and
the job reaches `render`/`done`.

### Swap-ins (already coded, env-gated — nothing to write on launch day)
- `R2Storage` activates when all four `R2_*` vars are set (uploads become
  presigned PUTs straight to the bucket — set a CORS rule on the bucket
  allowing `PUT` from the app origin).
- `ModalWorker` activates when `MODAL_TRIGGER_URL` + `WORKER_SHARED_SECRET`
  + `APP_URL` are set.
- No Neon driver swap needed: Vercel functions run full Node.js (Fluid
  compute), so the existing `pg` Pool works against Neon's pooled connection
  string directly — and keeps real transactions, which the HTTP driver
  doesn't support.

## Phases

- **Phase A — core deploy (accounts 1–4)** → public URL, working product:
  strangers can sign up (dev-login), upload, get clips, download.
- **Phase B — real logins (account 5)** → wire Google OAuth, turn OFF `AUTH_DEV`.
- **Phase C — payments (account 6)** → Dodo checkout links on pricing + webhook
  at `/api/webhooks/billing` (handler is built + idempotent).

## Rollback

- **Web** — Vercel dashboard → previous deployment → *Promote to Production*.
- **Worker** — `modal deploy` the previous commit; in-flight jobs finish on the
  old container.
- **DB** — schema syncs are forward-only; snapshot before a destructive change.

## CI/CD

GitHub Actions run on every push to `main`: `web-ci` (build + vitest +
Playwright e2e, ~3 min) and worker `CI` (fast suite ~8 min per push; the heavy
integration suite runs nightly + on `workflow_dispatch`). Wire Vercel's Git
integration for web auto-deploys and gate on green CI.

## Housekeeping before real users

- **Rotate the Anthropic API key** (it was pasted in a chat transcript once):
  regenerate at console.anthropic.com, re-store in the gitignored env files +
  the Modal secret.
- **Google OAuth app verification** — the OAuth consent screen is in "testing"
  (100-user cap, 7-day token expiry) until verified.

## Cost reality at launch

- Modal: pay-per-second GPU/CPU; ~$0.12–0.50 of LLM + compute per video
  (measured; the Haiku-defaulted Critic cut the LLM share ~8x).
- Neon/R2/Vercel free tiers cover early usage.
- You net positive as soon as you charge more than per-video cost.
