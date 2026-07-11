import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveStoragePath, sanitizeKey } from "@/lib/storage";

export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  json: "application/json",
};

function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// bytes=<start>-<end>, bytes=<start>-, or bytes=-<suffixLength>
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = RANGE_RE.exec(header.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    // suffix range: last N bytes
    const suffixLength = Number(endStr);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Math.min(Number(endStr), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null;
  }
  return { start, end };
}

export async function GET(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { key: segments } = await params;
  const key = segments.join("/");

  let sanitized: string;
  let filePath: string;
  try {
    sanitized = sanitizeKey(key);
    filePath = resolveStoragePath(sanitized);
  } catch {
    // Malformed/traversal key: same "not found" as a nonexistent key, so
    // this doesn't confirm to a caller whether a path escaped the root.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // No cross-user reads: every key must live under the caller's own prefix.
  // 404 (not 403) so existence of other users' keys isn't leaked either.
  if (!sanitized.startsWith(`u/${userId}/`)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(filePath);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!fileStat.isFile()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const contentType = contentTypeFor(sanitized);
  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    const range = parseRange(rangeHeader, fileStat.size);
    if (!range) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${fileStat.size}` },
      });
    }

    const nodeStream = createReadStream(filePath, { start: range.start, end: range.end });
    const webStream = Readable.toWeb(nodeStream) as unknown as NodeWebReadableStream<Uint8Array>;

    return new NextResponse(webStream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${fileStat.size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const nodeStream = createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream) as unknown as NodeWebReadableStream<Uint8Array>;

  return new NextResponse(webStream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(fileStat.size),
      "Accept-Ranges": "bytes",
    },
  });
}
