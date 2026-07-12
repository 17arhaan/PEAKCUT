import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { STORAGE_ROOT } from "@/lib/storage";
import { POST } from "./route";

const mockAuth = vi.mocked(auth);

function makeRequest(key: string) {
  return new Request(`http://localhost/api/upload?key=${encodeURIComponent(key)}`, {
    method: "POST",
    body: "hello",
  });
}

// Complements storage.test.ts's sanitizeKey-level IDOR coverage with a
// route-level check: a signed-in user can't write into another user's own
// (well-formed, no traversal) key prefix.
describe("POST /api/upload cross-user gate", () => {
  const attackerId = crypto.randomUUID();
  const victimId = crypto.randomUUID();

  afterAll(async () => {
    await rm(path.join(STORAGE_ROOT, "u", attackerId), { recursive: true, force: true });
    await rm(path.join(STORAGE_ROOT, "u", victimId), { recursive: true, force: true });
  });

  it("403s a signed-in user writing to another user's key prefix", async () => {
    mockAuth.mockResolvedValue({ user: { id: attackerId } } as never);

    const res = await POST(makeRequest(`u/${victimId}/upload1/evil.mp4`));
    expect(res.status).toBe(403);
  });

  it("200s a signed-in user writing to their own key prefix", async () => {
    mockAuth.mockResolvedValue({ user: { id: attackerId } } as never);

    const res = await POST(makeRequest(`u/${attackerId}/upload1/source.mp4`));
    expect(res.status).toBe(200);
  });
});
