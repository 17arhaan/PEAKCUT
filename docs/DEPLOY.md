# Deploying Peakcut

Two deployables: the **web app** (Vercel) and the **worker** (Modal, GPU). They
meet at the worker seam (`web/lib/worker.ts`) — set `MODAL_TOKEN_*` on the web app
and it dispatches to Modal; leave them unset and it runs the pipeline as a local
subprocess. Deploy them independently.

> Local dev needs none of this: `docker compose up -d db` + `npm run dev` runs the
> whole product with a stub worker and dev sign-in. See `web/SETUP.md`.

## Prerequisites
- A Postgres database (any provider — the app uses a plain connection string).
- A Vercel project pointed at `web/`.
- A Modal account (`pip install modal && modal token new`) for the worker.
- An Anthropic API key (live agent crew).

## 1. Database
The schema lives in `web/lib/db/schema.ts` and is synced with drizzle-kit. The repo
has no committed SQL migrations — dev syncs directly with `push`:

```bash
cd web
DATABASE_URL=<prod-url> npx drizzle-kit push      # sync schema to the DB
```

For a first deploy against an empty prod DB this is fine. Before going live for
real, switch to versioned migrations — `drizzle-kit generate` to write SQL into
`./drizzle`, commit it, then `drizzle-kit migrate` on deploy — so schema changes
replay deterministically instead of being diffed against live tables.

## 2. Worker (Modal)
The pipeline is one Modal function (`worker/src/shorts/modal_app.py`, app
`shorts-factory`).

```bash
cd worker
modal secret create anthropic ANTHROPIC_API_KEY=<key>   # once
modal deploy src/shorts/modal_app.py                    # deploy / redeploy
modal run src/shorts/modal_app.py --source <url>         # smoke-test one run
```

Live crew vs stub is controlled by `SHORTS_LLM` inside the function (see the
header comment in `modal_app.py`) — stub runs network-free, live uses the crew.

## 3. Web (Vercel)
Set env vars in the Vercel project (Production scope), then deploy. Required and
optional keys mirror `web/.env.example`:

| Var | Required | Notes |
|-----|----------|-------|
| `DATABASE_URL` | ✅ | Prod Postgres connection string. |
| `AUTH_SECRET` | ✅ | `openssl rand -base64 32`. |
| `AUTH_DEV` | — | **Must be unset in prod** — `1` enables passwordless login. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✅ (prod auth) | Real sign-in once the dev provider is off. |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | ✅ (real jobs) | Unset → local-subprocess worker. |
| `R2_*` | ✅ (clip storage) | Object storage for rendered clips; unset → local disk. |
| `DODO_API_KEY` / `DODO_WEBHOOK_SECRET` | — | Billing; unset → credits are manual. |
| `CRON_SECRET` | — | Bearer token for the stuck-job sweeper (`app/api/cron/sweep`). |

```bash
cd web
vercel --prod        # or push to the connected branch
```

After deploy, sanity-check: sign in works, `/dashboard/new` submits a job, and the
job reaches `render`/`done`.

## Rollback
- **Web** — Vercel dashboard → previous deployment → *Promote to Production*.
- **Worker** — `modal deploy` the previous commit; in-flight jobs finish on the old
  container.
- **DB** — migrations are forward-only; keep a snapshot before applying a
  destructive one.

## CI/CD
`.github/workflows/ci.yml` runs web (lint + vitest + Playwright e2e) and worker
(pytest, `SHORTS_LLM=stub`) on every push. Wire Vercel's Git integration for web
auto-deploys and a Modal deploy step (or `modal deploy` in a job) for the worker;
gate both on green CI.
