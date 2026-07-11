import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "./index";
import { clips, jobs, users } from "./schema";

describe("db schema round-trip", () => {
  const userId = crypto.randomUUID();
  const jobId = crypto.randomUUID();

  afterAll(async () => {
    await db.delete(clips).where(eq(clips.jobId, jobId));
    await db.delete(jobs).where(eq(jobs.id, jobId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("inserts and selects a user", async () => {
    await db.insert(users).values({
      id: userId,
      email: `roundtrip-${userId}@example.com`,
      name: "Round Trip",
    });

    const [row] = await db.select().from(users).where(eq(users.id, userId));

    expect(row).toMatchObject({
      id: userId,
      name: "Round Trip",
      plan: "free",
      minutesBalance: 0,
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("round-trips a jsonb blob on clips.evidence", async () => {
    await db.insert(jobs).values({
      id: jobId,
      userId,
      sourceType: "url",
      status: "done",
    });

    const evidence = {
      transcriptSpan: [12.5, 34.1],
      quotes: ["this is the hook", "and the payoff"],
      scores: { hook: 0.91, payoff: 0.77 },
    };

    await db.insert(clips).values({
      jobId,
      clipIndex: 0,
      tStart: 12.5,
      tEnd: 34.1,
      status: "ready",
      evidence,
    });

    const [row] = await db.select().from(clips).where(eq(clips.jobId, jobId));

    expect(row.evidence).toEqual(evidence);
  });
});
