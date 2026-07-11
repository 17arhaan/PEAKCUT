import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorage, resolveStoragePath, sanitizeKey } from "./storage";

describe("sanitizeKey", () => {
  it("accepts a well-formed key", () => {
    expect(sanitizeKey("u/user1/job1/clip.mp4")).toBe("u/user1/job1/clip.mp4");
  });

  it("rejects an empty or blank key", () => {
    expect(() => sanitizeKey("")).toThrow();
    expect(() => sanitizeKey("   ")).toThrow();
  });

  it("rejects parent-directory traversal that escapes the root", () => {
    expect(() => sanitizeKey("../evil")).toThrow();
    expect(() => sanitizeKey("u/user1/job1/../../../../etc/passwd")).toThrow();
    expect(() => sanitizeKey("..")).toThrow();
  });

  it("collapses in-root '..' segments without throwing (still contained)", () => {
    // "user1/.." cancels out, landing back inside root — not a traversal.
    expect(sanitizeKey("u/user1/../user1/job1/clip.mp4")).toBe(
      "u/user1/../user1/job1/clip.mp4",
    );
  });

  it("rejects absolute paths", () => {
    expect(() => sanitizeKey("/etc/passwd")).toThrow();
    expect(() => sanitizeKey("//etc/passwd")).toThrow();
  });

  it("rejects a key that resolves to the storage root itself", () => {
    expect(() => sanitizeKey(".")).toThrow();
  });

  it("rejects null bytes", () => {
    expect(() => sanitizeKey("u/user1/evil\0.mp4")).toThrow();
  });

  it("accepts keys that merely contain '..' as part of a filename", () => {
    // not a traversal: ".." is a substring of the segment, not the whole segment
    expect(sanitizeKey("u/user1/job1/my..file.mp4")).toBe("u/user1/job1/my..file.mp4");
  });
});

describe("LocalStorage", () => {
  let root: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "storage-test-"));
    storage = new LocalStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("putObjectUrl points at the upload route with the encoded key", async () => {
    const { url } = await storage.putObjectUrl("u/user1/job1/clip.mp4");
    expect(url).toBe("/api/upload?key=u%2Fuser1%2Fjob1%2Fclip.mp4");
  });

  it("putObjectUrl rejects a malicious key", async () => {
    await expect(storage.putObjectUrl("../evil")).rejects.toThrow();
  });

  it("getUrl points at the media route with each segment encoded", () => {
    expect(storage.getUrl("u/user1/job1/clip.mp4")).toBe("/api/media/u/user1/job1/clip.mp4");
  });

  it("round-trips a file written to and read from the resolved path", async () => {
    const key = "u/user1/job1/clip.mp4";
    const filePath = resolveStoragePath(key, root);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "hello world");

    expect(await readFile(filePath, "utf8")).toBe("hello world");
  });

  it("delete removes the whole subtree under a prefix", async () => {
    const filePath = resolveStoragePath("u/user1/job1/clip.mp4", root);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "data");

    await storage.delete("u/user1/job1");

    await expect(readFile(filePath)).rejects.toThrow();
  });

  it("delete rejects a prefix that escapes the storage root", async () => {
    await expect(storage.delete("../outside")).rejects.toThrow();
    await expect(storage.delete("/etc")).rejects.toThrow();
  });
});
