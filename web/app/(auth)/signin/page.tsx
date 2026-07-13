import Link from "next/link";
import { signIn } from "@/auth";
import { env } from "@/lib/env";
import { Button } from "@/components/ui/button";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl: callbackUrlParam } = await searchParams;
  const devEnabled = env.AUTH_DEV === "1";
  const googleEnabled = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

  // open-redirect guard: relative same-origin paths only
  const raw = callbackUrlParam ?? "";
  const callbackUrl =
    typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")
      ? raw
      : "/dashboard";

  return (
    <div className="landing relative flex min-h-full flex-1 flex-col items-center justify-center overflow-hidden bg-[var(--ink)] px-6 py-16 font-body text-[var(--text)]">
      {/* ambient signal glow — quiet, matches the hero */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-[-12%] h-[440px] w-[600px] -translate-x-1/2 rounded-full bg-[var(--signal)] opacity-[0.10] blur-[130px]" />
        <div className="absolute bottom-[-18%] right-[8%] h-[380px] w-[440px] rounded-full bg-[var(--pulse)] opacity-[0.10] blur-[130px]" />
      </div>

      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center">
          <span className="font-display text-lg font-extrabold tracking-tight text-[var(--text)]">
            Peakcut
          </span>
        </Link>

        <div className="signal-glow rounded-2xl border border-[var(--line)] bg-[color-mix(in_oklab,var(--panel)_88%,transparent)] p-7 backdrop-blur-sm">
          <div className="mb-6 text-center">
            <span className="font-mono-data text-[11px] tracking-[0.15em] text-[var(--signal)]">
              SIGN IN
            </span>
            <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">
              Welcome back
            </h1>
            <p className="mt-1.5 text-sm text-[var(--muted)]">
              Turn long videos into clips that prove themselves.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            {googleEnabled && (
              <form
                action={async () => {
                  "use server";
                  await signIn("google", { redirectTo: callbackUrl });
                }}
              >
                <Button
                  type="submit"
                  size="lg"
                  className="w-full gap-2.5 border border-[var(--line)] bg-[var(--panel-raised)] font-medium text-[var(--text)] transition-colors hover:bg-[color-mix(in_oklab,var(--panel-raised)_80%,var(--text))]"
                >
                  <GoogleMark />
                  Continue with Google
                </Button>
              </form>
            )}

            {googleEnabled && devEnabled && (
              <div className="flex items-center gap-3 font-mono-data text-[11px] tracking-wide text-[var(--muted)]">
                <span className="h-px flex-1 bg-[var(--line)]" />
                OR
                <span className="h-px flex-1 bg-[var(--line)]" />
              </div>
            )}

            {devEnabled && (
              <form
                action={async (formData: FormData) => {
                  "use server";
                  await signIn("credentials", {
                    email: formData.get("email"),
                    redirectTo: callbackUrl,
                  });
                }}
                className="flex flex-col gap-2.5"
              >
                <label
                  htmlFor="email"
                  className="font-mono-data text-[11px] tracking-wide text-[var(--muted)] uppercase"
                >
                  Email {!googleEnabled && "· dev sign-in"}
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  placeholder="you@example.com"
                  className="h-10 rounded-lg border border-[var(--line)] bg-[color-mix(in_oklab,var(--ink)_70%,transparent)] px-3 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[color-mix(in_oklab,var(--muted)_70%,transparent)] focus-visible:border-[color-mix(in_oklab,var(--signal)_60%,transparent)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--signal)_25%,transparent)]"
                />
                <Button
                  type="submit"
                  size="lg"
                  className="signal-glow mt-1 w-full bg-[var(--signal)] font-semibold text-[var(--ink)] transition-all hover:-translate-y-0.5 hover:bg-[color-mix(in_oklab,var(--signal)_92%,var(--text))]"
                >
                  Continue
                </Button>
              </form>
            )}
          </div>
        </div>

        <p className="mt-6 text-center font-mono-data text-xs text-[var(--muted)]">
          No card required · 60 free minutes
        </p>
      </div>
    </div>
  );
}
