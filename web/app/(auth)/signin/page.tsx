import { signIn } from "@/auth";
import { env } from "@/lib/env";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function SignInPage() {
  const devEnabled = env.AUTH_DEV === "1";
  const googleEnabled = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Shorts Factory</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {devEnabled && (
            <form
              action={async (formData: FormData) => {
                "use server";
                await signIn("credentials", {
                  email: formData.get("email"),
                  redirectTo: "/dashboard",
                });
              }}
              className="flex flex-col gap-2"
            >
              <label htmlFor="email" className="text-sm text-muted-foreground">
                Email (dev sign-in)
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                placeholder="you@example.com"
                className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <Button type="submit">Continue</Button>
            </form>
          )}

          {googleEnabled && (
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: "/dashboard" });
              }}
            >
              <Button type="submit" variant="outline" className="w-full">
                Continue with Google
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
