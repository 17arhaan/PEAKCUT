# Shorts Factory — web app setup

Local-first: everything through the full task list runs with zero external
accounts. `docker compose up -d db` + `npm run dev` is the whole story.

## Quickstart

```bash
cd web
npm i
cp .env.example .env.local     # fill in DATABASE_URL / AUTH_SECRET / AUTH_DEV
docker compose up -d db        # arrives in Task 2 — not needed yet for the landing page
npm run dev                    # http://localhost:3000
```

## Env

All env access goes through `lib/env.ts` (zod-validated, fails loudly at boot
naming the missing var and where to get it). See `.env.example` for the full
list and comments. Required in dev: `DATABASE_URL`, `AUTH_SECRET`, `AUTH_DEV`.
Everything else is optional and gated behind a feature that arrives in a
later task (storage seam, worker seam, OAuth, billing) — leave those unset
until you need them.

## Tests

```bash
npm run build        # TS strict, must be clean
npm run test         # Unit tests (vitest) — auto-provisions test DB
npx playwright install chromium   # one-time
npm run test:e2e     # Playwright, chromium only
```

## Later account-gated swap-ins (placeholders — filled in as tasks land)

- **Database:** local Postgres via `docker compose up -d db` (Task 2). No
  Neon account needed locally.
- **Auth:** dev credentials provider, any email (Task 3). Google OAuth is
  optional and gated on `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- **Storage:** local disk under `web/.data/storage` (Task 5). R2 swap-in is
  gated on `R2_*` vars, not needed for local dev.
- **Worker:** local subprocess running `worker/` via `uv run shorts` (Task
  6). Modal swap-in is gated on `MODAL_TOKEN_*`, not needed for local dev.
- **Billing:** no-op until wired; Dodo Payments swap-in is gated on
  `DODO_API_KEY` / `DODO_WEBHOOK_SECRET`.
