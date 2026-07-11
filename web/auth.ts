import { eq } from "drizzle-orm";
import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";
import type {} from "next-auth/jwt";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { grantSignup } from "@/lib/credits";

/**
 * Finds a user by email or creates one (dev credentials sign-in has no real
 * password — anyone can "register" just by signing in). On first creation,
 * grants a one-time 60-minute signup credit via lib/credits, in the same tx
 * as the user-row creation — grant and row commit or roll back together.
 * Idempotency comes from credit_ledger's UNIQUE(reason, ref) (W2 schema),
 * so concurrent sign-ins can't double-grant.
 */
async function findOrCreateDevUser(email: string) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(users).where(eq(users.email, email));
    if (existing) return existing;

    const name = email.split("@")[0];
    const [created] = await tx
      .insert(users)
      .values({ email, name })
      .onConflictDoNothing({ target: users.email })
      .returning();

    // Lost the race to create the row (concurrent sign-in) — use the
    // winner's row and skip the grant below (it already ran for them).
    if (!created) {
      const [user] = await tx.select().from(users).where(eq(users.email, email));
      return user;
    }

    await grantSignup(created.id, tx);
    const [withBalance] = await tx.select().from(users).where(eq(users.id, created.id));
    return withBalance ?? created;
  });
}

const providers: Provider[] = [];

// Dev credentials provider: any email, no password check. Only ever
// registered when AUTH_DEV=1 — never in production.
// defense-in-depth: dev login can never ship — double-gate on NODE_ENV
if (env.AUTH_DEV === "1" && process.env.NODE_ENV !== "production") {
  providers.push(
    Credentials({
      id: "credentials",
      name: "Dev sign-in",
      credentials: { email: { label: "Email", type: "email" } },
      async authorize(credentials) {
        const email =
          typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
        if (!email || !email.includes("@")) return null;

        const user = await findOrCreateDevUser(email);
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  );
}

if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: env.AUTH_SECRET,
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  providers,
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.userId = user.id;
      return token;
    },
    session({ session, token }) {
      if (typeof token.userId === "string") session.user.id = token.userId;
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
  }
}
