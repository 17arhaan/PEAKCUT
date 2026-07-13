import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DeleteAccountDialog } from "@/components/delete-account-dialog";
import { getUserProfile } from "@/lib/data";

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-[var(--line)] py-3 first:border-t-0">
      <span className="font-mono-data text-[11px] tracking-wide text-[var(--muted)] uppercase">
        {label}
      </span>
      <span className="font-mono-data text-sm tabular-nums text-[var(--text)]">{value}</span>
    </div>
  );
}

// Auth-guarded by proxy.ts's matcher already covering /settings/:path* --
// the redirect below is just defense-in-depth for a direct render.
export default async function SettingsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/signin");

  const user = await getUserProfile(userId);
  // Session cookie outlived the user row (e.g. deleted from another tab) --
  // signOut() clears it properly rather than rendering a blank profile.
  if (!user) redirect("/signin");

  return (
    <div className="landing dark peakcut-app flex min-h-full flex-1 flex-col bg-[var(--ink)] font-body text-[var(--text)]">
      <header className="border-b border-[var(--line)]">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-6 py-3">
          <Link href="/dashboard" aria-label="Peakcut" className="flex items-center">
            <Image src="/peakcut-logo.png" alt="Peakcut" width={1481} height={267} priority className="h-5 w-auto" />
          </Link>
          <Link
            href="/dashboard"
            className="font-mono-data text-xs text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          >
            ← Dashboard
          </Link>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6 sm:py-10">
        <div className="flex flex-col gap-1">
          <span className="font-mono-data text-[11px] tracking-[0.15em] text-[var(--signal)]">
            SETTINGS
          </span>
          <h1 className="font-display text-2xl font-extrabold tracking-tight">Your account</h1>
        </div>

        <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)]/50 p-6">
          <div className="flex items-center gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--signal)]/12 font-display text-lg font-bold text-[var(--signal)] uppercase">
              {user.email.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="truncate font-mono-data text-sm text-[var(--text)]">{user.email}</p>
              <span className="mt-1 inline-flex items-center rounded-full border border-[var(--line)] bg-[var(--ink)]/40 px-2 py-0.5 font-mono-data text-[10px] tracking-[0.12em] text-[var(--signal)] uppercase">
                {user.plan}
              </span>
            </div>
          </div>

          <div className="mt-5">
            <Readout label="Minutes balance" value={`${user.minutesBalance} min`} />
            <Readout label="Member since" value={DATE_FORMAT.format(user.createdAt)} />
          </div>
        </div>

        <div className="rounded-2xl border border-destructive/30 bg-destructive/[0.06] p-6">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono-data text-[11px] tracking-[0.15em] text-destructive">
              DANGER ZONE
            </span>
            <p className="text-sm text-[var(--muted)]">
              Permanently delete your account, all jobs, clips, and files. This cannot be undone.
            </p>
          </div>
          <div className="mt-4">
            <DeleteAccountDialog />
          </div>
        </div>
      </div>
    </div>
  );
}
