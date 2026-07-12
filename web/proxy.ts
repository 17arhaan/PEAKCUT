import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/admin";

// Next.js 16 renamed middleware.ts -> proxy.ts (this file). It defaults to
// the Node.js runtime here (not Edge — see next/dist/docs/.../proxy.md,
// "Runtime" section, changed in v16.0.0), so wrapping the full `auth()`
// config — including the Credentials provider, which touches Postgres via
// lib/db in its `authorize` — is safe to import here. No jose/edge-JWT
// fallback needed. auth() itself only *decodes* the session cookie on each
// request (no DB read); lib/db's Pool is lazily constructed on first query,
// so importing it here doesn't open a connection per request either.
//
// /admin gate: the JWT DOES carry the email claim here (Auth.js's default
// jwt()/session() merge copies user.email onto the token/session even
// though auth.ts's own callbacks only add userId -- proved by
// dashboard/layout.tsx already rendering session.user.email today), so
// isAdmin() can run directly on req.auth in this Node-runtime proxy. A
// non-admin (signed in or not) hitting /admin gets a bare 404 -- never a
// redirect to /signin or /dashboard, so the route's existence isn't
// revealed. The admin page + every admin-data.ts query re-check isAdmin
// again server-side (defense in depth) -- this proxy check is not the only
// guard, just the cheapest one to fail fast on.
export default auth((req) => {
  if (req.nextUrl.pathname.startsWith("/admin")) {
    if (!isAdmin(req.auth)) {
      return new NextResponse("Not Found", { status: 404 });
    }
    return NextResponse.next();
  }

  if (!req.auth) {
    const signInUrl = new URL("/signin", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/jobs/:path*", "/settings/:path*", "/admin/:path*"],
};
