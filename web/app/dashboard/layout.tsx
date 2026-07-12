import Link from "next/link";
import { auth, signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { isAdmin } from "@/lib/admin";

// Guarded-page header (email + settings + sign out). jobs arrives in a
// later task and can adopt this same shape then — not scaffolding it early.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="text-sm font-semibold tracking-tight">Shorts Factory</span>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{session?.user?.email}</span>
          {/* Admin nav link: isAdmin-gated so non-admins never see it exists.
              Purely a convenience link -- proxy.ts + the page itself both
              re-check isAdmin regardless of how /admin is reached. */}
          {isAdmin(session) && (
            <Button size="sm" variant="ghost" render={<Link href="/admin" />}>
              Admin
            </Button>
          )}
          <Button size="sm" variant="ghost" render={<Link href="/settings" />}>
            Settings
          </Button>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
