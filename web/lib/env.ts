import { z } from "zod";

// name -> what feature/seam gates it, for GATED_VARS below.
export const GATED_VARS: Record<string, string> = {};

/**
 * Marks a var that's unused until a later task wires up the feature behind
 * it (storage/worker/auth/billing seams). Not validated today — the schema
 * accepts it as an optional string. gateDescription documents what unlocks
 * it (recorded in GATED_VARS), so nobody has to re-derive that by reading
 * the seam code.
 */
function optionalGated(name: string, gateDescription: string) {
  GATED_VARS[name] = gateDescription;
  return z.string().min(1).optional();
}

// Required var name -> where to get/set it, shown in the boot error.
const REQUIRED_VAR_HELP: Record<string, string> = {
  DATABASE_URL: "start local db: docker compose up -d db",
  AUTH_SECRET: "generate one: openssl rand -base64 32",
  AUTH_DEV: "set AUTH_DEV=1 to enable the dev credentials sign-in provider",
};

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  AUTH_DEV: z.string().min(1),

  // Storage seam: LocalStorage -> R2Storage swap-in.
  R2_ACCESS_KEY_ID: optionalGated("R2_ACCESS_KEY_ID", "storage seam: R2Storage swap-in"),
  R2_SECRET_ACCESS_KEY: optionalGated("R2_SECRET_ACCESS_KEY", "storage seam: R2Storage swap-in"),
  R2_BUCKET: optionalGated("R2_BUCKET", "storage seam: R2Storage swap-in"),
  R2_ACCOUNT_ID: optionalGated("R2_ACCOUNT_ID", "storage seam: R2Storage swap-in"),

  // Worker seam: LocalWorker -> ModalWorker swap-in.
  MODAL_TOKEN_ID: optionalGated("MODAL_TOKEN_ID", "worker seam: ModalWorker swap-in"),
  MODAL_TOKEN_SECRET: optionalGated("MODAL_TOKEN_SECRET", "worker seam: ModalWorker swap-in"),

  // Google OAuth, alongside the always-on dev credentials provider.
  GOOGLE_CLIENT_ID: optionalGated("GOOGLE_CLIENT_ID", "Google OAuth sign-in"),
  GOOGLE_CLIENT_SECRET: optionalGated("GOOGLE_CLIENT_SECRET", "Google OAuth sign-in"),

  // Merchant-of-record billing (Dodo Payments preferred, Paddle fallback).
  DODO_API_KEY: optionalGated("DODO_API_KEY", "billing checkout"),
  DODO_WEBHOOK_SECRET: optionalGated("DODO_WEBHOOK_SECRET", "billing webhook signature verification"),

  // Provider-agnostic webhook HMAC secret (W13). Dodo/Paddle map into this
  // normalized event shape at swap-in 19; until then the route verifies
  // self-signed test payloads against this secret directly.
  BILLING_WEBHOOK_SECRET: optionalGated("BILLING_WEBHOOK_SECRET", "billing webhook signature verification"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = Object.entries(z.flattenError(parsed.error).fieldErrors).map(
      ([name, issues]) => {
        const help = REQUIRED_VAR_HELP[name];
        const reason = issues?.[0] ?? "invalid";
        return help ? `  ${name} — ${reason} (${help})` : `  ${name} — ${reason}`;
      },
    );
    throw new Error(
      `Missing/invalid environment variables:\n${missing.join("\n")}\n\nSee web/.env.example and web/SETUP.md.`,
    );
  }
  return parsed.data;
}

export const env = loadEnv();
