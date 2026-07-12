import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/lib/env", () => ({ env: { ADMIN_EMAILS: undefined } }));

function sessionFor(email: string | undefined): Session {
  return { user: { email }, expires: "" } as unknown as Session;
}

describe("isAdmin", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("false for null/undefined session and for a session with no email", async () => {
    const { isAdmin } = await import("@/lib/admin");
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin(sessionFor(undefined))).toBe(false);
  });

  it("true for the default owner email when ADMIN_EMAILS is unset", async () => {
    vi.doMock("@/lib/env", () => ({ env: { ADMIN_EMAILS: undefined } }));
    const { isAdmin } = await import("@/lib/admin");
    expect(isAdmin(sessionFor("17arhaan@gmail.com"))).toBe(true);
  });

  it("is case-insensitive and trims whitespace", async () => {
    vi.doMock("@/lib/env", () => ({ env: { ADMIN_EMAILS: undefined } }));
    const { isAdmin } = await import("@/lib/admin");
    expect(isAdmin(sessionFor("  17ARHAAN@gmail.com  "))).toBe(true);
  });

  it("false for a non-admin email", async () => {
    vi.doMock("@/lib/env", () => ({ env: { ADMIN_EMAILS: undefined } }));
    const { isAdmin } = await import("@/lib/admin");
    expect(isAdmin(sessionFor("random-user@example.com"))).toBe(false);
  });

  it("ADMIN_EMAILS env overrides the default, supports comma-separated list", async () => {
    vi.doMock("@/lib/env", () => ({ env: { ADMIN_EMAILS: "a@example.com, B@Example.com " } }));
    const { isAdmin } = await import("@/lib/admin");

    expect(isAdmin(sessionFor("a@example.com"))).toBe(true);
    expect(isAdmin(sessionFor("b@example.com"))).toBe(true); // case-insensitive
    // default owner email is NOT admin once env overrides the list
    expect(isAdmin(sessionFor("17arhaan@gmail.com"))).toBe(false);
  });
});
