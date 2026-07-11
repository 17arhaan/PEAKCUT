import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { creditLedger, users } from "@/lib/db/schema";
import { env } from "@/lib/env";

// ponytail: test-only introspection endpoint for e2e assertions (user row +
// credit grant after sign-in). Gated behind the same AUTH_DEV flag that
// enables the dev credentials provider, so it's never reachable unless
// AUTH_DEV=1 — never in production.
export async function GET(request: Request) {
  if (env.AUTH_DEV !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const email = new URL(request.url).searchParams.get("email");
  if (!email) {
    return NextResponse.json({ error: "email query param required" }, { status: 400 });
  }

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) return NextResponse.json({ user: null, grants: [] });

  const grants = await db.select().from(creditLedger).where(eq(creditLedger.userId, user.id));
  return NextResponse.json({ user, grants });
}
