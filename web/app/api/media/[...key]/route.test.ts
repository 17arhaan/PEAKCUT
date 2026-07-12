import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { resolveStoragePath } from "@/lib/storage";
import { GET } from "./route";

const mockAuth = vi.mocked(auth);

function makeRequest() {
  return new Request("http://localhost/api/media/x");
}

// Complements storage.test.ts's sanitizeKey-level IDOR coverage with a
// route-level check: a signed-in user hitting this route with another
// user's own (perfectly well-formed, no traversal) key must not be able to
// read it.
describe("GET /api/media/[...key] cross-user gate", () => {
  const victimId = crypto.randomUUID();
  const attackerId = crypto.randomUUID();
  const key = `u/${victimId}/job1/clip_1.mp4`;
  const filePath = resolveStoragePath(key);

  beforeAll(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "victim bytes");
  });

  afterAll(async () => {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  });

  it("404s a signed-in user reading another user's key", async () => {
    mockAuth.mockResolvedValue({ user: { id: attackerId } } as never);

    const res = await GET(makeRequest(), { params: Promise.resolve({ key: key.split("/") }) });
    expect(res.status).toBe(404);
  });

  it("200s the owner reading their own key", async () => {
    mockAuth.mockResolvedValue({ user: { id: victimId } } as never);

    const res = await GET(makeRequest(), { params: Promise.resolve({ key: key.split("/") }) });
    expect(res.status).toBe(200);
  });
});
