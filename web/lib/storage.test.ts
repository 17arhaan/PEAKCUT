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

  it("rejects '..' segments even when they resolve back under root", () => {
    // Fix for cross-user IDOR: "u/user1/.." lexically starts with
    // "u/user1/" (the ownership-check prefix route handlers use) but
    // resolves into a sibling user's tree. Any bare '..' segment is
    // rejected outright, regardless of where it resolves.
    expect(() => sanitizeKey("u/user1/../user1/job1/clip.mp4")).toThrow();
    expect(() => sanitizeKey("u/user1/../user2/x")).toThrow();
  });

  it("rejects a bare '.' segment", () => {
    expect(() => sanitizeKey("u/user1/./job1/clip.mp4")).toThrow();
  });

  it("rejects empty path segments", () => {
    expect(() => sanitizeKey("u//user1/job1/clip.mp4")).toThrow();
    expect(() => sanitizeKey("u/user1/job1/clip.mp4/")).toThrow();
  });

  it("rejects the cross-user IDOR keys", () => {
    expect(() => sanitizeKey("u/attacker/../victim/job1/f.txt")).toThrow();
    expect(() => sanitizeKey("u/attacker/../../evil.txt")).toThrow();
    expect(() => sanitizeKey("../etc/passwd")).toThrow();
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

  it("getUrl points at the media route with each segment encoded", async () => {
    await expect(storage.getUrl("u/user1/job1/clip.mp4")).resolves.toBe(
      "/api/media/u/user1/job1/clip.mp4",
    );
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
