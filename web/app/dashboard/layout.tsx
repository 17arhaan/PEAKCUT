import Link from "next/link";
import Image from "next/image";
import { auth, signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { isAdmin } from "@/lib/admin";

// The signed-in app shell. `landing dark peakcut-app` gives it the Peakcut
// instrument-panel tokens AND retints the shadcn variables dark, so every page
// rendered inside (dashboard, new-job, jobs) shares one dark skin instead of
// sitting on the default light theme.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <div className="landing dark peakcut-app flex min-h-full flex-1 flex-col bg-[var(--ink)] font-body text-[var(--text)]">
      <header className="flex items-center justify-between border-b border-[var(--line)] px-6 py-3">
        <Link href="/dashboard" aria-label="Peakcut" className="flex items-center">
          <Image
            src="/peakcut-logo.png"
            alt="Peakcut"
            width={1481}
            height={267}
            priority
            className="h-5 w-auto"
          />
        </Link>
        <div className="flex items-center gap-1.5">
          <span className="mr-1 hidden font-mono-data text-xs text-[var(--muted)] sm:inline">
            {session?.user?.email}
          </span>
          {isAdmin(session) && (
            <Button
              size="sm"
              variant="ghost"
              render={<Link href="/admin" />}
              className="text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
            >
              Admin
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            render={<Link href="/settings" />}
            className="text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
          >
            Settings
          </Button>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
            >
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
