import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { agentEvents, clips, jobs, users } from "@/lib/db/schema";
import { GET } from "./route";

const mockAuth = vi.mocked(auth);

function makeRequest() {
  return new Request("http://localhost/api/jobs/x/status");
}

describe("GET /api/jobs/[jobId]/status", () => {
  const ownerId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  let jobId: string;

  beforeAll(async () => {
    await db.insert(users).values([
      { id: ownerId, email: `status-route-${ownerId}@example.com` },
      { id: otherId, email: `status-route-${otherId}@example.com` },
    ]);
  });

  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.userId, ownerId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, otherId));
  });

  beforeEach(async () => {
    mockAuth.mockReset();
    const [job] = await db
      .insert(jobs)
      .values({ userId: ownerId, sourceType: "url", status: "processing", stage: "signals", progress: 0.4 })
      .returning();
    jobId = job.id;

    await db.insert(clips).values([
      {
        jobId,
        clipIndex: 1,
        tStart: 0,
        tEnd: 5,
        score: 88,
        hook: "A great hook",
        r2Key: `u/${ownerId}/${jobId}/clip_1.mp4`,
        thumbKey: `u/${ownerId}/${jobId}/clip_1_thumb.jpg`,
        status: "ready",
        evidence: {
          score: {
            total: 88,
            verdict: "keep",
            components: { hook_strength: { score: 22, evidence: [{ kind: "laughter", t: 3, value: null }] } },
          },
          candidate: { t0: 0, t1: 5, source: "llm", notes: "", evidence: [] },
          repairs: [],
        },
        qa: { passed: true, failures: [] },
      },
      {
        jobId,
        clipIndex: 2,
        tStart: 6,
        tEnd: 10,
        status: "dropped",
        droppedReason: "BLACK",
      },
    ]);
    await db.insert(agentEvents).values({ jobId, agent: "scout", action: "found", payload: { count: 3 } });
  });

  it("401s when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null as never);

    const res = await GET(makeRequest(), { params: Promise.resolve({ jobId }) });
    expect(res.status).toBe(401);
  });

  it("404s when the job belongs to someone else", async () => {
    mockAuth.mockResolvedValue({ user: { id: otherId } } as never);

    const res = await GET(makeRequest(), { params: Promise.resolve({ jobId }) });
    expect(res.status).toBe(404);
  });

  it("404s for a nonexistent job id", async () => {
    mockAuth.mockResolvedValue({ user: { id: ownerId } } as never);

    const res = await GET(makeRequest(), { params: Promise.resolve({ jobId: crypto.randomUUID() }) });
    expect(res.status).toBe(404);
  });

  it("returns the owner's job shape with media urls only for ready clips", async () => {
    mockAuth.mockResolvedValue({ user: { id: ownerId } } as never);

    const res = await GET(makeRequest(), { params: Promise.resolve({ jobId }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      status: "processing",
      stage: "signals",
      progress: 0.4,
      error: null,
    });

    expect(body.clips).toHaveLength(2);
    const [ready, dropped] = body.clips;
    expect(ready).toMatchObject({ index: 1, status: "ready", score: 88, hook: "A great hook" });
    expect(ready.mp4_url).toBe(`/api/media/u/${ownerId}/${jobId}/clip_1.mp4`);
    expect(ready.thumb_url).toBe(`/api/media/u/${ownerId}/${jobId}/clip_1_thumb.jpg`);
    expect(ready.evidence).toMatchObject({ score: { total: 88, verdict: "keep" } });
    expect(ready.qa).toEqual({ passed: true, failures: [] });

    expect(dropped).toMatchObject({ index: 2, status: "dropped", dropped_reason: "BLACK" });
    expect(dropped.mp4_url).toBeNull();
    expect(dropped.thumb_url).toBeNull();
    // no evidence/qa seeded for this clip -- the route must null-coalesce, not crash on the missing jsonb.
    expect(dropped.evidence).toBeNull();
    expect(dropped.qa).toBeNull();

    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ agent: "scout", action: "found" });
    expect(typeof body.events[0].created_at).toBe("string");

    // no raw storage paths leak into the response — everything media-shaped
    // is an /api/media/ url from storage.getUrl, never a bare r2Key/thumbKey.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(".data/storage");
  });
});
