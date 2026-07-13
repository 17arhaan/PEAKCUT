"use client";

import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Link2, Loader2, UploadCloud, X } from "lucide-react";
import { createJob } from "@/actions/jobs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ponytail: mirrors ESTIMATE_MINUTES in actions/jobs.ts -- a flat estimate
// shown before the real duration is known (createJob debits the same
// number). Not worth a shared module for one number across the
// client/server boundary; keep the two in sync by hand.
const ESTIMATE_MINUTES = 30;
// ponytail: mirrors MAX_UPLOAD_BYTES in app/api/upload/route.ts -- same
// reasoning as above, checked client-side too so a huge file fails fast
// instead of streaming 2GB before the server rejects it.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function sourceReadout(url: string, file: File | null): { label: string; meta: string | null } | null {
  if (file) return { label: file.name, meta: formatBytes(file.size) };
  const trimmed = url.trim();
  if (!trimmed || !isHttpUrl(trimmed)) return null;
  try {
    return { label: new URL(trimmed).hostname.replace(/^www\./, ""), meta: null };
  } catch {
    return null;
  }
}

export function NewJobForm({ userId, balance }: { userId: string; balance: number }) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const urlInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = sourceReadout(url, file);
  const lowBalance = balance < ESTIMATE_MINUTES;

  function chooseFile(next: File | null) {
    setError(null);
    if (next && next.size > MAX_UPLOAD_BYTES) {
      setError("That file's over 2GB — trim it or paste a link instead.");
      return;
    }
    setFile(next);
    if (next) setUrl("");
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (pending) return;
    chooseFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const trimmedUrl = url.trim();
    if (!file && !trimmedUrl) {
      setError("Paste a video link or drop a file to get started.");
      return;
    }
    if (!file && !isHttpUrl(trimmedUrl)) {
      setError("That doesn't look like a valid link — check the URL and try again.");
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
        if (!uploadRes.ok) {
          throw new Error("The upload didn't make it. Check your connection and try again.");
        }
        ({ jobId } = await createJob({ source: key, sourceType: "upload" }));
      } else {
        ({ jobId } = await createJob({ source: trimmedUrl, sourceType: "url" }));
      }
      router.push(`/jobs/${jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPending(false);
    }
  }

  return (
    <motion.div
      initial={reduceMotion ? undefined : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? undefined : { duration: 0.45, ease: EASE_OUT }}
      className="signal-glow relative w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6 text-left sm:p-8"
    >
      {/* Submit-in-flight cue: a signal-colored bar sweeps the top edge.
          Static (no loop) under prefers-reduced-motion. */}
      {pending && (
        <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden">
          {reduceMotion ? (
            <div className="h-full w-full bg-[var(--signal)]" />
          ) : (
            <motion.div
              className="h-full w-1/3 bg-[var(--signal)]"
              animate={{ x: ["-100%", "300%"] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={urlInputId}
            className="font-mono-data text-xs font-medium tracking-[0.1em] text-[var(--muted)] uppercase"
          >
            YouTube URL or video link
          </label>
          <div className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-black/20 px-3 focus-within:border-[var(--signal)] focus-within:ring-1 focus-within:ring-[var(--signal)]/40">
            <Link2 className="size-4 shrink-0 text-[var(--muted)]" aria-hidden />
            <input
              id={urlInputId}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(event) => {
                setError(null);
                setUrl(event.target.value);
                if (event.target.value) setFile(null);
              }}
              placeholder="https://youtube.com/watch?v=..."
              className="h-11 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]/70"
              disabled={pending}
            />
          </div>
        </div>

        <div className="flex items-center gap-3 font-mono-data text-xs text-[var(--muted)]">
          <div className="h-px flex-1 bg-[var(--line)]" />
          or
          <div className="h-px flex-1 bg-[var(--line)]" />
        </div>

        <motion.div
          role="button"
          tabIndex={0}
          aria-label="Upload a video file"
          onClick={() => !pending && fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (pending) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!pending) setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          animate={reduceMotion ? undefined : { scale: isDragging ? 1.01 : 1 }}
          transition={{ duration: 0.15 }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center transition-colors outline-none",
            "focus-visible:ring-2 focus-visible:ring-[var(--signal)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]",
            isDragging
              ? "border-[var(--signal)] bg-[var(--signal)]/10"
              : "border-[var(--line)] bg-black/10 hover:border-[var(--signal)]/50 hover:bg-black/20",
            pending && "pointer-events-none opacity-50",
          )}
        >
          {file ? (
            <>
              <p className="max-w-full truncate text-sm text-[var(--text)]">{file.name}</p>
              <p className="font-mono-data text-[11px] text-[var(--muted)]">{formatBytes(file.size)}</p>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  chooseFile(null);
                }}
                className="mt-1 inline-flex items-center gap-1 font-mono-data text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
              >
                <X className="size-3" aria-hidden />
                Remove
              </button>
            </>
          ) : (
            <>
              <UploadCloud className="size-5 text-[var(--muted)]" aria-hidden />
              <p className="text-sm text-[var(--text)]">Drag a video here, or click to browse</p>
              <p className="font-mono-data text-[11px] text-[var(--muted)]">
                MP4, MOV, WEBM · up to 2GB
              </p>
            </>
          )}
          <input
            ref={fileInputRef}
            tabIndex={-1}
            type="file"
            accept="video/*"
            className="sr-only"
            disabled={pending}
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          />
        </motion.div>

        <AnimatePresence mode="wait">
          {source && (
            <motion.div
              key={`${source.label}-${source.meta ?? ""}`}
              initial={reduceMotion ? undefined : { opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={reduceMotion ? undefined : { duration: 0.25, ease: EASE_OUT }}
              className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-black/20 px-3 py-2 font-mono-data text-xs"
            >
              <span className="text-[var(--signal)]">▸</span>
              <span className="text-[var(--muted)]">SOURCE</span>
              <span className="truncate text-[var(--text)]">{source.label}</span>
              {source.meta && <span className="ml-auto shrink-0 text-[var(--muted)]">{source.meta}</span>}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {error && (
            <motion.p
              role="alert"
              initial={reduceMotion ? undefined : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={reduceMotion ? undefined : { duration: 0.2 }}
              className="text-sm text-red-400"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        <div className="flex flex-col gap-3">
          <Button
            type="submit"
            size="lg"
            disabled={pending}
            className="signal-glow bg-[var(--signal)] font-semibold text-[var(--ink)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[var(--signal)]/90 hover:shadow-[0_16px_40px_-10px_rgba(245,179,1,0.55)] disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-60 disabled:shadow-none"
          >
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Starting…
              </>
            ) : (
              "Start processing"
            )}
          </Button>
          <p
            className={cn(
              "text-center font-mono-data text-[11px]",
              lowBalance ? "text-[var(--signal)]" : "text-[var(--muted)]",
            )}
          >
            Uses ~{ESTIMATE_MINUTES} min from your balance · {balance} min available
          </p>
        </div>
      </form>
    </motion.div>
  );
}
