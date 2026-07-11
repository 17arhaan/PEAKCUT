import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Next.js 16 renamed middleware.ts -> proxy.ts (this file). It defaults to
// the Node.js runtime here (not Edge — see next/dist/docs/.../proxy.md,
// "Runtime" section, changed in v16.0.0), so wrapping the full `auth()`
// config — including the Credentials provider, which touches Postgres via
// lib/db in its `authorize` — is safe to import here. No jose/edge-JWT
// fallback needed. auth() itself only *decodes* the session cookie on each
// request (no DB read); lib/db's Pool is lazily constructed on first query,
// so importing it here doesn't open a connection per request either.
export default auth((req) => {
  if (!req.auth) {
    const signInUrl = new URL("/signin", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.href);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/jobs/:path*", "/settings/:path*"],
};
