"use client";

import { useState, useTransition } from "react";
import { deleteAccount } from "@/actions/account";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const CONFIRM_TEXT = "DELETE";

/**
 * Danger-zone confirm flow for /settings. Deletion itself (DB cascade,
 * storage purge, sign-out) all lives server-side in actions/account.ts --
 * this component is just the "type DELETE to confirm" gate around calling
 * it, plus surfacing a failure instead of silently doing nothing.
 */
export function DeleteAccountDialog() {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setConfirmText("");
      setError(null);
    }
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      try {
        // On success this redirects (signOut({ redirectTo: "/" }) throws a
        // navigation signal) -- the catch below only fires on a real failure.
        await deleteAccount();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete account.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="destructive" />}>Delete account</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete account</DialogTitle>
          <DialogDescription>
            This permanently deletes your account, all jobs, clips, and files. Type DELETE to
            confirm.
          </DialogDescription>
        </DialogHeader>

        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="DELETE"
          aria-label="Type DELETE to confirm account deletion"
          autoComplete="off"
          className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button
            variant="destructive"
            disabled={confirmText !== CONFIRM_TEXT || isPending}
            onClick={handleDelete}
          >
            {isPending ? "Deleting…" : "Permanently delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
