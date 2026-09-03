// Proves the portability claim instead of asserting it: whatever git carries
// must be exactly enough for a second machine to serve a release AND re-derive
// it from the archived source bytes - no shared disk, no network, no copying
// by hand.
//
// Method: build a drill release through the real pipeline in a throwaway repo,
// commit it under this repo's own ignore and attribute rules, clone it the way
// another machine would, then load and verify against the clone alone.
//
// It has already earned its keep twice: it caught .gitignore hiding the
// published pointer, and git's line-ending conversion breaking every release
// hash on checkout.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { verifyReleaseChain } from "@luatvn/ingest";
import { loadPublishedRelease } from "@luatvn/manual-dataset";

const allowedHosts = ["drill.invalid"];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

const root = await mkdtemp(join(tmpdir(), "luatvn-portability-"));
const origin = join(root, "origin");
const clone = join(root, "clone");
let failed = false;

function check(label, passed, detail) {
  say(`  ${passed ? "ĐẠT " : "HỎNG"}  ${label}${detail === undefined ? "" : ` - ${detail}`}`);
  if (!passed) {
    failed = true;
  }
}

try {
  const dataDirectory = join(origin, "data", "manual");
  await mkdir(dataDirectory, { recursive: true });
  // Both files travel, because both are part of the portability contract:
  // .gitignore decides what is carried, .gitattributes decides that git does
  // not rewrite the bytes of what it carries.
  await copyFile(".gitignore", join(origin, ".gitignore"));
  await copyFile(".gitattributes", join(origin, ".gitattributes"));
  git(origin, "init", "--quiet", "--initial-branch", "main");
  git(origin, "config", "user.email", "drill@luatvn.invalid");
  git(origin, "config", "user.name", "portability drill");

  // The real pipeline, not a shortcut: extract -> link -> promote -> publish.
  execFileSync(process.execPath, [resolve("tools/ui-drill.mjs"), dataDirectory], {
    encoding: "utf8",
    stdio: "pipe",
  });

  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "portability drill release");
  const carried = git(origin, "ls-files").split("\n").filter(Boolean);

  git(root, "clone", "--quiet", origin, clone);
  const cloneData = join(clone, "data", "manual");

  say("Bài diễn tập tính di động - git mang theo:\n");
  for (const file of carried) {
    say(`  ${file}`);
  }
  say("\nKiểm tra trên bản sao chép (không đụng máy gốc):\n");

  check("file nháp không bị mang theo", !carried.some((file) => file.includes("staging")));
  check("con trỏ bản phát hành có mang theo", carried.includes("data/manual/published.json"));
  check(
    "bytes nguồn có được mang theo",
    carried.some((file) => file.includes("/archive/")),
  );
  check(
    "sổ duyệt của người review có mang theo",
    carried.some((file) => file.endsWith("review-log.json")),
  );

  const loaded = await loadPublishedRelease(cloneData, {
    allowedHosts,
    includeAttachments: true,
  });
  check(
    "bản sao chép nạp được release",
    loaded.dataset.provisionVersions.length > 0,
    `${loaded.datasetReleaseId}, ${String(loaded.dataset.provisionVersions.length)} bản ghi, ${String(loaded.files.size)} file`,
  );

  const report = await verifyReleaseChain(loaded);
  const verified = report.issues.length === 0;
  check(
    "dựng lại nguyên văn từ nguồn ngay trên bản sao chép",
    verified,
    verified
      ? `${String(report.derivedProvisions)} điều dựng lại khớp, ${String(report.vouchedProvisions)} điều có người duyệt, ${String(report.archivedSources)} nguồn lưu trữ`
      : report.issues.map((issue) => issue.code).join(", "),
  );
  for (const issue of report.issues) {
    say(`      ${issue.code}: ${issue.detail}`);
  }
} finally {
  await rm(root, { force: true, recursive: true });
}

if (failed) {
  process.exitCode = 1;
  say("\nKẾT LUẬN: chưa di động được.");
} else {
  say("\nKẾT LUẬN: một máy khác chỉ cần clone là chạy và tự kiểm chứng được.");
}
