import { copyFile, mkdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Storage seam. `storage` is the object other app code should call — a
 * `LocalStorage` in dev, an `R2Storage` when all four R2_* env vars are set
 * (see lib/env.ts). `sanitizeKey`/`resolveStoragePath` are exported
 * separately because the local upload/media route handlers need raw fs
 * access to actually move bytes — R2 never proxies bytes through the app:
 * uploads go straight to the bucket via a presigned PUT, downloads via a
 * presigned GET.
 */
export interface Storage {
  /** Where the client should send the file's bytes. `direct: true` means PUT
   * the body straight at `url` (a presigned R2 URL); false means POST to the
   * app's own /api/upload proxy route (local dev). */
  putObjectUrl(key: string): Promise<{ url: string; direct: boolean }>;
  /** A URL the browser can fetch the object from (app media route locally,
   * time-limited presigned URL on R2 — hence async). */
  getUrl(key: string): Promise<string>;
  /** Server-side copy of a worker-produced local file into storage. */
  putObjectFromFile(key: string, filePath: string): Promise<void>;
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

/**
 * The ownership check app/api/upload and app/api/media each inline
 * (sanitize, then require the key live under the caller's own u/<userId>/
 * prefix, checked on both the raw string and the resolved path per
 * sanitizeKey's docstring). Pulled out here so a third caller (createJob's
 * upload-key validation) doesn't re-copy it a third time. Throws on any
 * violation; returns the sanitized key on success.
 */
export function assertOwnedKey(key: string, userId: string, root: string = STORAGE_ROOT): string {
  const sanitized = sanitizeKey(key, root);
  const userRoot = path.resolve(root, "u", userId) + path.sep;
  if (!sanitized.startsWith(`u/${userId}/`) || !path.resolve(root, sanitized).startsWith(userRoot)) {
    throw new Error("storage key is not owned by this user");
  }
  return sanitized;
}

export class LocalStorage implements Storage {
  constructor(private readonly root: string = STORAGE_ROOT) {}

  async putObjectUrl(key: string): Promise<{ url: string; direct: boolean }> {
    sanitizeKey(key, this.root);
    return { url: `/api/upload?key=${encodeURIComponent(key)}`, direct: false };
  }

  async getUrl(key: string): Promise<string> {
    sanitizeKey(key, this.root);
    return `/api/media/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async putObjectFromFile(key: string, filePath: string): Promise<void> {
    const dest = await this.ensureParentDir(key);
    await copyFile(filePath, dest);
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

const PRESIGN_TTL_S = 3600; // 1h: outlives any realistic upload/playback session

/**
 * Cloudflare R2 via the S3-compatible API. Keys are sanitized with the same
 * guard as LocalStorage — an object key can't traverse anything, but every
 * ownership check in the app reasons about the raw `u/<userId>/...` string,
 * so a key with `..`/absolute segments must never get this far either.
 *
 * The SDK client is lazy: constructing it validates credentials, and this
 * module is imported by code paths (tests, local dev) that never touch R2.
 */
export class R2Storage implements Storage {
  private client: import("@aws-sdk/client-s3").S3Client | null = null;

  constructor(
    private readonly cfg: {
      accountId: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
    },
  ) {}

  private async s3() {
    if (!this.client) {
      const { S3Client } = await import("@aws-sdk/client-s3");
      this.client = new S3Client({
        region: "auto",
        endpoint: `https://${this.cfg.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.cfg.accessKeyId,
          secretAccessKey: this.cfg.secretAccessKey,
        },
      });
    }
    return this.client;
  }

  async putObjectUrl(key: string): Promise<{ url: string; direct: boolean }> {
    sanitizeKey(key);
    const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/s3-request-presigner"),
    ]);
    const url = await getSignedUrl(
      await this.s3(),
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn: PRESIGN_TTL_S },
    );
    return { url, direct: true };
  }

  async getUrl(key: string): Promise<string> {
    sanitizeKey(key);
    const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/s3-request-presigner"),
    ]);
    return getSignedUrl(
      await this.s3(),
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn: PRESIGN_TTL_S },
    );
  }

  async putObjectFromFile(key: string, filePath: string): Promise<void> {
    sanitizeKey(key);
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.s3()).send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: createReadStream(filePath),
      }),
    );
  }

  async delete(prefix: string): Promise<void> {
    sanitizeKey(prefix);
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3();
    // paginate: a user prefix can hold more than one LIST page of clips
    let token: string | undefined;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: prefix.endsWith("/") ? prefix : `${prefix}/`,
          ContinuationToken: token,
        }),
      );
      const keys = (listed.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys } }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
}

/** All four R2 vars present -> R2; anything less -> local disk. */
function selectStorage(): Storage {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET) {
    return new R2Storage({
      accountId: R2_ACCOUNT_ID,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      bucket: R2_BUCKET,
    });
  }
  return new LocalStorage();
}

export const storage: Storage = selectStorage();
