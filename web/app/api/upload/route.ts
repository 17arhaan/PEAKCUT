import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { LocalStorage, sanitizeKey } from "@/lib/storage";

// Local dev/test upload sink for the storage seam's putObjectUrl(). A real
// object-storage backend (R2Storage) wouldn't proxy uploads through the app
// server at all — the client would PUT directly to a presigned URL. This
// route exists only because LocalStorage has no such service to hand out
// presigned URLs from.
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

// ponytail: raw streamed body only, no multipart/form-data parsing — the
// client PUTs/POSTs bytes directly to this URL (matches putObjectUrl's lack
// of `fields`, which is what would signal a multipart form upload). Add
// multipart parsing if a browser-native <form> upload flow needs it.
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const key = new URL(request.url).searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "key query param required" }, { status: 400 });
  }

  let sanitized: string;
  try {
    sanitized = sanitizeKey(key);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  // No cross-user writes: every key must live under the caller's own prefix.
  if (!sanitized.startsWith(`u/${userId}/`)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!request.body) {
    return NextResponse.json({ error: "request body required" }, { status: 400 });
  }

  const localStorage = new LocalStorage();
  const destPath = await localStorage.ensureParentDir(sanitized);
  const tmpPath = `${destPath}.upload-${crypto.randomUUID()}`;

  let bytesWritten = 0;
  async function* limitSize(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_UPLOAD_BYTES) {
        throw new Error("upload exceeds size limit");
      }
      yield chunk;
    }
  }

  try {
    // Streams straight to disk (temp file, renamed on success) — never
    // buffers the whole upload in memory, so this holds up for large video
    // files.
    await pipeline(
      Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>),
      limitSize,
      createWriteStream(tmpPath),
    );
    await rename(tmpPath, destPath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    if (err instanceof Error && err.message === "upload exceeds size limit") {
      return NextResponse.json({ error: "file too large" }, { status: 413 });
    }
    throw err;
  }

  return NextResponse.json({ key: sanitized });
}
