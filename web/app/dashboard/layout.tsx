import { auth, signOut } from "@/auth";
import { Button } from "@/components/ui/button";

// Guarded-page header (email + sign out). jobs/settings arrive in later
// tasks and can adopt this same shape then — not scaffolding it early.
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
