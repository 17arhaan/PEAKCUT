import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Storage seam. `storage` is the object other app code should call — a
 * `LocalStorage` today, an `R2Storage` once R2 credentials land (see
 * lib/env.ts's R2_* gated vars). `sanitizeKey`/`resolveStoragePath` are
 * exported separately because the upload/media route handlers need raw fs
 * access to actually move bytes — something a real object-storage backend
 * wouldn't expose through this interface (it'd use presigned URLs instead).
 */
export interface Storage {
  putObjectUrl(key: string): Promise<{ url: string; fields?: Record<string, string> }>;
  getUrl(key: string): string;
  delete(prefix: string): Promise<void>;
}

// Key convention: u/<userId>/<jobId or uploadId>/<filename>
// e.g. u/3f2a.../7c91.../source.mp4 — the userId prefix is what
// app/api/upload and app/api/media check against the session to block
// cross-user reads/writes.
export const STORAGE_ROOT = path.join(process.cwd(), ".data", "storage");

/**
 * Path-traversal guard. This is the security core of the storage seam: a
 * key ultimately becomes a filesystem path, so a caller who can smuggle
 * `..` (raw, or via URL-decoded %2e%2e) or an absolute path into a key
 * could read/write outside the storage root.
 *
 * Does NOT rely on blocklisting the substring "..": that breaks on
 * legitimate filenames like "my..file.mp4". Instead it rejects any bare
 * `.`, `..`, or empty path *segment* (split on "/") — that's what a
 * traversal actually looks like, and it lets a filename that merely
 * contains ".." through untouched.
 *
 * That segment check is the primary guard, and it matters because this
 * function returns the *raw* key on success (callers key off the raw
 * string, e.g. route handlers' `startsWith('u/<userId>/')` ownership
 * check) — the containment check below only validates the *resolved*
 * path, so a returned-but-unnormalized key with a `..` segment in it
 * would still pass a lexical prefix check while resolving elsewhere.
 * The containment check stays as defense-in-depth against anything the
 * segment check doesn't anticipate.
 */
export function sanitizeKey(key: string, root: string = STORAGE_ROOT): string {
  if (!key || key.trim() === "") throw new Error("storage key must not be empty");
  if (key.includes("\0")) throw new Error("storage key must not contain null bytes");
  if (path.isAbsolute(key)) throw new Error("storage key must not be absolute");

  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("storage key must not contain '.', '..', or empty path segments");
  }

  const resolved = path.resolve(root, key);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved === root || !resolved.startsWith(rootWithSep)) {
    throw new Error("storage key resolves outside the storage root");
  }
  return key;
}

/** Resolves a key to its absolute filesystem path, sanitizing it first. */
export function resolveStoragePath(key: string, root: string = STORAGE_ROOT): string {
  sanitizeKey(key, root);
  return path.resolve(root, key);
}

export class LocalStorage implements Storage {
  constructor(private readonly root: string = STORAGE_ROOT) {}

  async putObjectUrl(key: string): Promise<{ url: string }> {
    sanitizeKey(key, this.root);
    return { url: `/api/upload?key=${encodeURIComponent(key)}` };
  }

  getUrl(key: string): string {
    sanitizeKey(key, this.root);
    return `/api/media/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async delete(prefix: string): Promise<void> {
    const resolved = resolveStoragePath(prefix, this.root);
    await rm(resolved, { recursive: true, force: true });
  }

  /** Absolute fs path for a key, creating no directories. */
  path(key: string): string {
    return resolveStoragePath(key, this.root);
  }

  async ensureParentDir(key: string): Promise<string> {
    const filePath = this.path(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    return filePath;
  }
}

// ponytail: R2Storage lands with credentials
export const storage: Storage = new LocalStorage();
