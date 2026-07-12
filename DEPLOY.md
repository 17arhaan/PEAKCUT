# Going Live — Deployment Guide

The app is fully built and runs locally. Going public = creating a few hosted
accounts and pasting their credentials. This guide is the exact checklist.

The worker (video pipeline) is ALREADY deployed on Modal. This guide is about
putting the **web app** on the internet and pointing it at hosted services
instead of your laptop.

---

## What you create (accounts — all have free tiers)

Do these in order. Each row lists exactly what value I need back from you.

| # | Account | Free? | What to create | Value(s) I need |
|---|---------|-------|----------------|-----------------|
| 1 | **Neon** (neon.tech) | Yes | A project → a Postgres database | The **pooled connection string** (`postgresql://...-pooler...`) |
| 2 | **Cloudflare R2** (dash.cloudflare.com → R2) | Yes (10GB) | A bucket named `shorts-factory` + an API token | Account ID, Access Key ID, Secret Access Key, bucket name |
| 3 | **Vercel** (vercel.com) | Yes | Connect your GitHub `shorts-factory` repo | Just sign in with GitHub — I do the rest via `vercel` CLI or you click "Import" |
| 4 | **Google Cloud** (console.cloud.google.com) | Yes | OAuth 2.0 credentials (later — for real logins) | Client ID + Client Secret |
| 5 | **Dodo Payments** (dodopayments.com) | Yes | Merchant account (last — for charging money) | API key + webhook secret |

**You can launch with just 1–3.** Google OAuth (4) and Dodo (5) layer on after —
the app works with dev-login and no billing until then.

---

## The sequence (what happens after you create accounts)

### Phase A — core deploy (accounts 1–3) → public URL, working product
1. You give me the Neon connection string + R2 credentials.
2. I set them as Vercel environment variables (`AUTH_SECRET`, `DATABASE_URL`,
   R2 vars, `MODAL_TRIGGER_URL`, `CRON_SECRET`, `BILLING_WEBHOOK_SECRET`,
   `ANTHROPIC_API_KEY`, and the Modal secret is already set worker-side).
3. I run the swap-in tasks: `R2Storage` (replaces LocalStorage), `ModalWorker`
   (replaces the local subprocess — triggers the deployed Modal pipeline),
   Neon driver (`neon-http` instead of node-postgres), and push the DB schema
   to Neon.
4. `vercel deploy --prod` → you get a real URL.
5. Landing-page placeholder pricing → your real numbers.
   **Result: strangers can sign up (dev-login or magic-link), upload, get clips, download.**

### Phase B — real logins (account 4)
6. Wire Google OAuth + Resend magic-link (the Auth.js providers are already
   env-gated — just add the credentials). Turn OFF `AUTH_DEV`.

### Phase C — payments (account 5)
7. Dodo checkout links on the pricing page + point the webhook at
   `/api/webhooks/billing` (the handler is built + idempotent). Now you charge.

---

## Housekeeping (independent of accounts)
- **Rotate the Anthropic API key** (it was pasted in a chat transcript):
  regenerate at console.anthropic.com → I re-store it in the gitignored env
  files + Modal secret.
- **Grant CI push**: `gh auth refresh -h github.com -s workflow` → I push the
  two parked CI workflows (worker + web) so tests run on every commit.
- **Merge** `build/worker-pipeline → main` when you're ready to make it canonical.

---

## Cost reality at launch
- Modal: pay-per-second GPU/CPU; ~$0.12–0.50 of LLM + compute per video (measured).
- Neon/R2/Vercel free tiers cover early usage.
- You net positive as soon as you charge more than per-video cost.
