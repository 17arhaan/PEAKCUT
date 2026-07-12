import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "@auth/core/adapters";

// --- App tables (spec §6) ---

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name"),
  // Required by Auth.js drizzle adapter; future-proofing for OAuth integration
  emailVerified: timestamp("email_verified"),
  image: text("image"),
  plan: text("plan").notNull().default("free"),
  minutesBalance: integer("minutes_balance").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const jobs = pgTable("jobs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sourceType: text("source_type").$type<"url" | "upload">().notNull(),
  sourceUrl: text("source_url"),
  r2Key: text("r2_key"),
  status: text("status").$type<"queued" | "processing" | "done" | "failed">().notNull(),
  stage: text("stage"),
  progress: real("progress").notNull().default(0),
  error: text("error"),
  durationMin: real("duration_min"),
  costCents: integer("cost_cents"),
  // W11 caption-style switcher: which of the 3 karaoke presets (s1/s2/s3)
  // the clip grid is currently showing. Null until the first restyle --
  // the original render's caption style isn't tracked as one of s1/s2/s3.
  // SIMPLEST honest v1 (see web-task-11-brief.md): media keys are swapped
  // in place (lib/run-import.ts's importStyleRun), no separate style-variant
  // rows -- this column is just "which style is the media currently in".
  activeStyle: text("active_style").$type<"s1" | "s2" | "s3">(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const clips = pgTable(
  "clips",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    clipIndex: integer("clip_index").notNull(),
    tStart: real("t_start").notNull(),
    tEnd: real("t_end").notNull(),
    score: integer("score"),
    hook: text("hook"),
    captions: jsonb("captions"),
    evidence: jsonb("evidence"),
    qa: jsonb("qa"),
    r2Key: text("r2_key"),
    thumbKey: text("thumb_key"),
    status: text("status").$type<"ready" | "dropped">().notNull(),
    droppedReason: text("dropped_reason"),
  },
  // run.json import (W7) is replayable: re-importing the same job upserts
  // by (job_id, clip_index) instead of duplicating rows.
  (table) => [unique().on(table.jobId, table.clipIndex)],
);

export const agentEvents = pgTable("agent_events", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  clipId: text("clip_id").references(() => clips.id, { onDelete: "cascade" }),
  agent: text("agent").notNull(),
  action: text("action").notNull(),
  payload: jsonb("payload"),
  verdict: text("verdict"),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deltaMinutes: real("delta_minutes").notNull(),
    reason: text("reason").notNull(),
    ref: text("ref").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique().on(table.reason, table.ref)],
);

export const payments = pgTable("payments", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  morEventId: text("mor_event_id").notNull().unique(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --- Auth.js v5 adapter tables (@auth/drizzle-adapter documented postgres
// schema, node_modules/@auth/drizzle-adapter/src/lib/pg.ts, verbatim column
// shapes) — adapter wired in a later task. `users` above stands in for the
// adapter's own users table since it already carries id/email/name. ---

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (verificationToken) => [
    primaryKey({
      columns: [verificationToken.identifier, verificationToken.token],
    }),
  ],
);
