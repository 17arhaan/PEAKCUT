import type { Session } from "next-auth";
import { env } from "@/lib/env";

// Default owner email if ADMIN_EMAILS is unset -- env wins when set.
const DEFAULT_ADMIN_EMAILS = "17arhaan@gmail.com";

function adminEmails(): Set<string> {
  const raw = env.ADMIN_EMAILS?.trim() || DEFAULT_ADMIN_EMAILS;
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The security core: true iff session.user.email (case-insensitive,
 * trimmed) is in ADMIN_EMAILS. Used in THREE places that must all agree --
 * proxy.ts (first line of defense, path-based), every admin server
 * component, and every admin-data.ts query (defense in depth, never trust
 * proxy alone). A non-admin failing this check gets notFound()/404, never a
 * redirect -- the route's existence is not revealed.
 */
export function isAdmin(session: Session | null | undefined): boolean {
  const email = session?.user?.email;
  if (!email) return false;
  return adminEmails().has(email.trim().toLowerCase());
}
