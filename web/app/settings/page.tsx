import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DeleteAccountDialog } from "@/components/delete-account-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getUserProfile } from "@/lib/data";

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
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

        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Row label="Email" value={user.email} />
          <Row label="Plan" value={user.plan} />
          <Row label="Minutes balance" value={String(user.minutesBalance)} />
          <Row label="Member since" value={DATE_FORMAT.format(user.createdAt)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Permanently delete your account, all jobs, clips, and files. This cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteAccountDialog />
        </CardContent>
        </Card>
      </div>
    </div>
  );
}
