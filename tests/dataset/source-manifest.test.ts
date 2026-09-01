import {
  buildSourceStoreManifest,
  decodeSourceStoreManifest,
  verifySourceStoreManifest,
  type SourceFileEntry,
  type SourceStoreManifest,
} from "@luatvn/manual-dataset";
import { describe, expect, it } from "vitest";

const generatedAt = "2026-09-01T00:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const secondFile: SourceFileEntry = { byteLength: 20, path: "rel_x/second.rsc.txt", sha256: hashB };
const firstFile: SourceFileEntry = { byteLength: 10, path: "rel_x/first.html", sha256: hashA };
const files: SourceFileEntry[] = [secondFile, firstFile];

function manifestOf(entries: SourceFileEntry[]): SourceStoreManifest {
  const built = buildSourceStoreManifest(entries, generatedAt);
  if (!built.ok) {
    throw new Error(`fixture manifest invalid: ${built.issues[0].path}`);
  }
  return built.value;
}

describe("buildSourceStoreManifest", () => {
  it("orders entries by path so the committed manifest is stable", () => {
    const manifest = manifestOf(files);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "rel_x/first.html",
      "rel_x/second.rsc.txt",
    ]);
    expect(manifest.generatedAt).toBe(generatedAt);
  });

  it("rejects a path that escapes the source store", () => {
    const built = buildSourceStoreManifest(
      [{ byteLength: 1, path: "../outside.html", sha256: hashA }],
      generatedAt,
    );
    expect(built.ok).toBe(false);
  });

  it("rejects duplicate paths", () => {
    const built = buildSourceStoreManifest(
      [
        { byteLength: 1, path: "same.html", sha256: hashA },
        { byteLength: 1, path: "same.html", sha256: hashB },
      ],
      generatedAt,
    );
    expect(built.ok).toBe(false);
  });

  it("rejects a manifest whose instant is not canonical", () => {
    expect(
      decodeSourceStoreManifest({ files: [], generatedAt: "2026-09-01", schemaVersion: 1 }).ok,
    ).toBe(false);
  });
});

describe("verifySourceStoreManifest", () => {
  it("passes when the store matches the manifest", () => {
    expect(verifySourceStoreManifest(manifestOf(files), files)).toEqual([]);
  });

  it("reports a file that disappeared from the store", () => {
    const issues = verifySourceStoreManifest(manifestOf(files), [firstFile]);
    expect(issues).toEqual([
      {
        code: "MISSING",
        message: "File listed in the manifest is not on disk",
        path: "rel_x/second.rsc.txt",
      },
    ]);
  });

  it("reports content that no longer matches its hash", () => {
    const tampered = files.map((file) =>
      file.path === "rel_x/first.html" ? { ...file, sha256: hashB } : file,
    );
    const issues = verifySourceStoreManifest(manifestOf(files), tampered);
    expect(issues.map((issue) => issue.code)).toEqual(["HASH_MISMATCH"]);
  });

  it("reports a size drift even when the hash was recorded for it", () => {
    const resized = manifestOf(files);
    const issues = verifySourceStoreManifest(
      resized,
      files.map((file) => (file.path === "rel_x/first.html" ? { ...file, byteLength: 99 } : file)),
    );
    expect(issues.map((issue) => issue.code)).toEqual(["SIZE_MISMATCH"]);
  });

  it("reports files on disk that the manifest does not list", () => {
    const issues = verifySourceStoreManifest(manifestOf([firstFile]), files);
    expect(issues.map((issue) => issue.code)).toEqual(["UNREGISTERED"]);
  });
});
