import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { topUp } from "@/lib/credits";
import { db } from "@/lib/db";
import { payments, users } from "@/lib/db/schema";
import { env } from "@/lib/env";

// No session on this route -- the caller is an external billing provider,
// not a signed-in user. The HMAC signature IS the auth: user_id comes from
// the verified payload, trusted only because the signature over the whole
// raw body (including user_id) is trusted. Never read a session here.
export const runtime = "nodejs";

// Provider-agnostic normalized event shape (spec: plan Task 13). Dodo/Paddle
// map their own webhook payloads into this shape at swap-in 19; today the
// test suite (and any local sender) posts this shape directly, self-signed
// against BILLING_WEBHOOK_SECRET.
const eventSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  user_id: z.string().min(1),
  amount_cents: z.number().int().nonnegative(),
  currency: z.string().min(1),
  minutes: z.number().positive(),
});

// event type -> credit_ledger reason. Anything not listed here is acked
// (200) and logged, but never written to the db -- forward-compatible with
// event types this deployment doesn't yet handle.
const REASON_BY_TYPE: Record<string, string> = {
  "payment.succeeded": "purchase",
  "subscription.renewed": "subscription_renewal",
};

const SIGNATURE_HEADER = "x-billing-signature";

/** HMAC-SHA256(rawBody, secret) as lowercase hex -- matches the header format the test signer produces. */
function computeSignature(rawBody: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(rawBody).digest();
}

function verifySignature(rawBody: string, header: string | null, secret: string | undefined): boolean {
  if (!header || !secret) return false;

  let provided: Buffer;
  try {
    provided = Buffer.from(header, "hex");
  } catch {
    return false;
  }

  const expected = computeSignature(rawBody, secret);
  // timingSafeEqual throws on unequal-length buffers -- guard first instead
  // of letting a length mismatch (e.g. a garbage/non-hex header) crash the
  // route. A malformed or wrong-length signature is just another way to
  // fail closed (401), never a 500.
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
}

export async function POST(request: Request) {
  // MANDATORY: read the raw body BEFORE any parsing. request.json() then
  // re-stringifying would reorder/reformat keys and break the HMAC, since
  // the signature was computed over the provider's exact byte stream.
  const rawBody = await request.text();

  const signatureHeader = request.headers.get(SIGNATURE_HEADER);

  // Unset secret is a deploy misconfiguration, not "no auth required" --
  // fail closed (401) rather than accept unverifiable events.
  if (!verifySignature(rawBody, signatureHeader, env.BILLING_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // Optional replay guard (not implemented in v1): providers that send a
  // timestamp header alongside the signature (e.g. Stripe's `t=` prefix)
  // let you reject requests older than a few minutes, closing the replay
  // window even for a leaked-but-valid signature. Skipped here since the
  // idempotency latch below already makes replay financially harmless
  // (no double-credit) -- add if replay-driven log/notification spam
  // becomes a problem.

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const result = eventSchema.safeParse(parsedJson);
  if (!result.success) {
    return NextResponse.json({ error: "invalid event shape" }, { status: 400 });
  }

  const event = result.data;
  const reason = REASON_BY_TYPE[event.type];

  if (!reason) {
    console.log(`[billing webhook] unhandled event type "${event.type}" (event_id=${event.event_id}) -- acked, no-op`);
    return NextResponse.json({ ok: true });
  }

  // Pre-check: user must exist before we attempt the transaction. FK violation
  // on a non-existent user would crash the transaction and cause a retry-storm
  // (the event would never succeed, triggering infinite provider retries).
  // If absent, ack the event (200) so the provider stops retrying, but don't
  // credit anything -- this matches the "unknown event type" pattern above.
  const [userExists] = await db.select().from(users).where(eq(users.id, event.user_id));
  if (!userExists) {
    console.warn(`[billing webhook] unknown user_id "${event.user_id}" (event_id=${event.event_id}) -- acked, no credit`);
    return NextResponse.json({ ok: true });
  }

  // IDEMPOTENT core: the payments row insert is keyed on UNIQUE(mor_event_id)
  // and is the money-safety gate. A duplicate delivery of the same event_id
  // hits onConflictDoNothing and returns no row -- topUp is only called when
  // the insert actually landed a NEW row (checked via .returning() length,
  // never assumed), so a duplicate delivery can never double-credit. Both
  // writes share one transaction so a topUp failure rolls back the payments
  // row too (never "payment recorded, credit lost").
  await db.transaction(async (tx) => {
    const [paymentRow] = await tx
      .insert(payments)
      .values({
        userId: event.user_id,
        morEventId: event.event_id,
        amountCents: event.amount_cents,
        currency: event.currency,
        raw: event,
      })
      .onConflictDoNothing({ target: payments.morEventId })
      .returning();

    if (paymentRow) {
      await topUp(event.user_id, event.minutes, event.event_id, reason, tx);
    }
  });

  return NextResponse.json({ ok: true });
}
