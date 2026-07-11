"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createJob } from "@/actions/jobs";
import { Button } from "@/components/ui/button";

// Native <input> elements, not a shadcn Input component — this repo doesn't
// have one installed yet and this is the only form that needs it so far.
const inputClassName =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function NewJobForm({ userId }: { userId: string }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!file && !url.trim()) {
      setError("Enter a YouTube URL or choose a file to upload.");
      return;
    }

    setPending(true);
    try {
      let jobId: string;
      if (file) {
        const key = `u/${userId}/${crypto.randomUUID()}/${file.name}`;
        const uploadRes = await fetch(`/api/upload?key=${encodeURIComponent(key)}`, {
          method: "POST",
          body: file,
        });
        if (!uploadRes.ok) throw new Error("upload failed");
        ({ jobId } = await createJob({ source: key, sourceType: "upload" }));
      } else {
        ({ jobId } = await createJob({ source: url.trim(), sourceType: "url" }));
      }
      router.push(`/jobs/${jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="url" className="text-sm font-medium">
          YouTube URL
        </label>
        <input
          id="url"
          type="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            if (event.target.value) setFile(null);
          }}
          placeholder="https://youtube.com/watch?v=..."
          className={inputClassName}
          disabled={pending}
        />
      </div>

      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        or
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="file" className="text-sm font-medium">
          Upload a video file
        </label>
        <input
          id="file"
          type="file"
          accept="video/*"
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            if (chosen) setUrl("");
          }}
          className="text-sm"
          disabled={pending}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create job"}
      </Button>
    </form>
  );
}
