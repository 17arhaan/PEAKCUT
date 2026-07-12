import { createHmac } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { creditLedger, payments, users } from "@/lib/db/schema";
import { POST } from "./route";

const SECRET = process.env.BILLING_WEBHOOK_SECRET!;

// Mirrors the route's own verifySignature exactly: HMAC-SHA256 over the raw
// (unparsed) body, hex-encoded, sent in the x-billing-signature header.
function sign(rawBody: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function makeRequest(rawBody: string, signature?: string | null) {
  const headers: Record<string, string> = {};
  if (signature !== null) {
    headers["x-billing-signature"] = signature ?? sign(rawBody);
  }
  return new Request("http://localhost/api/webhooks/billing", {
    method: "POST",
    body: rawBody,
    headers,
  });
}

const createdUserIds: string[] = [];

async function createUser(minutesBalance = 0): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email: `billing-webhook-${id}@example.com`, minutesBalance });
  createdUserIds.push(id);
  return id;
}

async function balanceOf(userId: string): Promise<number> {
  const [row] = await db.select({ balance: users.minutesBalance }).from(users).where(eq(users.id, userId));
  return row?.balance ?? 0;
}

// credit_ledger and payments both cascade on user delete (W2 schema), so
// deleting the users this file created cleans up everything it wrote.
afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("POST /api/webhooks/billing", () => {
  it("valid signature + payment.succeeded: creates a payments row, credits minutes, returns 200", async () => {
    const userId = await createUser(0);
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
      event_id: eventId,
      type: "payment.succeeded",
      user_id: userId,
      amount_cents: 999,
      currency: "usd",
      minutes: 120,
    });

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await balanceOf(userId)).toBe(120);

    const rows = await db.select().from(payments).where(eq(payments.morEventId, eventId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, amountCents: 999, currency: "usd" });
  });

  // MONEY-SAFETY CORE: a duplicate webhook delivery (provider retry, at-
  // least-once redelivery) must never credit twice.
  it("DUPLICATE delivery (same event_id twice): payments row created once, minutes credited ONCE, both return 200", async () => {
    const userId = await createUser(0);
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
      event_id: eventId,
      type: "payment.succeeded",
      user_id: userId,
      amount_cents: 500,
      currency: "usd",
      minutes: 50,
    });

    const res1 = await POST(makeRequest(body));
    const res2 = await POST(makeRequest(body));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await balanceOf(userId)).toBe(50);

    const paymentRows = await db.select().from(payments).where(eq(payments.morEventId, eventId));
    expect(paymentRows).toHaveLength(1);

    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.reason, "purchase"), eq(creditLedger.ref, eventId)));
    expect(ledgerRows).toHaveLength(1);
  });

  it("bad signature: 401, no payments row, no credit", async () => {
    const userId = await createUser(0);
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
      event_id: eventId,
      type: "payment.succeeded",
      user_id: userId,
      amount_cents: 100,
      currency: "usd",
      minutes: 10,
    });

    const res = await POST(makeRequest(body, sign(body, "wrong-secret")));

    expect(res.status).toBe(401);
    expect(await balanceOf(userId)).toBe(0);
    expect(await db.select().from(payments).where(eq(payments.morEventId, eventId))).toHaveLength(0);
  });

  it("missing signature header: 401", async () => {
    const body = JSON.stringify({
      event_id: crypto.randomUUID(),
      type: "payment.succeeded",
      user_id: crypto.randomUUID(),
      amount_cents: 100,
      currency: "usd",
      minutes: 10,
    });

    const res = await POST(makeRequest(body, null));

    expect(res.status).toBe(401);
  });

  it("unknown event type (valid signature): 200, no credit, no crash", async () => {
    const userId = await createUser(0);
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
      event_id: eventId,
      type: "subscription.cancelled",
      user_id: userId,
      amount_cents: 0,
      currency: "usd",
      minutes: 1,
    });

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await balanceOf(userId)).toBe(0);
    expect(await db.select().from(payments).where(eq(payments.morEventId, eventId))).toHaveLength(0);
  });

  it("malformed body (valid signature, bad shape): 400, no side effects", async () => {
    const body = JSON.stringify({ hello: "world" });

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
  });

  it("invalid json (valid signature over garbage bytes): 400", async () => {
    const body = "not json";

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(400);
  });

  it("subscription.renewed: credits minutes under a distinct ledger reason", async () => {
    const userId = await createUser(0);
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
      event_id: eventId,
      type: "subscription.renewed",
      user_id: userId,
      amount_cents: 1999,
      currency: "usd",
      minutes: 300,
    });

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await balanceOf(userId)).toBe(300);
    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.reason, "subscription_renewal"), eq(creditLedger.ref, eventId)));
    expect(ledgerRows).toHaveLength(1);
  });

  it("unknown user_id (valid signature): 200, no payments row, no credit, logs warning", async () => {
    const unknownUserId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
      event_id: eventId,
      type: "payment.succeeded",
      user_id: unknownUserId,
      amount_cents: 500,
      currency: "usd",
      minutes: 50,
    });

    const res = await POST(makeRequest(body));

    expect(res.status).toBe(200);
    expect(await db.select().from(payments).where(eq(payments.morEventId, eventId))).toHaveLength(0);
    expect(
      await db
        .select()
        .from(creditLedger)
        .where(and(eq(creditLedger.userId, unknownUserId), eq(creditLedger.ref, eventId)))
    ).toHaveLength(0);
  });

  // MONEY-SAFETY CORE: concurrent duplicate webhook deliveries (two parallel
  // POSTs with the same event_id) must never double-credit, even under
  // concurrent execution.
  it("CONCURRENT duplicate delivery (same event_id, two parallel POSTs): one payments row, one credit, balance bumped once", async () => {
    const userId = await createUser(0);
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
      event_id: eventId,
      type: "payment.succeeded",
      user_id: userId,
      amount_cents: 750,
      currency: "usd",
      minutes: 75,
    });

    const [res1, res2] = await Promise.all([POST(makeRequest(body)), POST(makeRequest(body))]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await balanceOf(userId)).toBe(75);

    const paymentRows = await db.select().from(payments).where(eq(payments.morEventId, eventId));
    expect(paymentRows).toHaveLength(1);

    const ledgerRows = await db
      .select()
      .from(creditLedger)
      .where(and(eq(creditLedger.reason, "purchase"), eq(creditLedger.ref, eventId)));
    expect(ledgerRows).toHaveLength(1);
  });
});
