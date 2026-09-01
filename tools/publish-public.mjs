// Builds the public mirror from an allowlist, never a denylist.
//
// A denylist fails open: every new private document is published by default
// until someone remembers to add it. This fails closed instead - a file that
// matches neither list stops the whole run and has to be classified by a human.
// Publishing is one-way, so the cost of the two mistakes is not symmetric.
//
// Default is a dry run. Pass --apply to write into the mirror directory; git
// operations there stay manual, so nothing reaches GitHub without a person
// reading the diff first.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const mirror = process.env["LUATVN_PUBLIC_DIR"] ?? join(root, "..", "luatvn-public");
const apply = process.argv.includes("--apply");

// Written for the public repo and kept there. The private README and
// CONTRIBUTING address whoever works on the private repo and point at phase
// documents that do not exist publicly; copying them over would replace a
// product front page with internal instructions full of dead links.
const mirrorOwned = new Set(["README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md"]);

// Owner decision 2026-09-01: publish code, tests, tooling and technical docs.
// Anything describing strategy, the plan of record, or the legal-data pipeline's
// internal governance stays private.
const publish = [
  {
    reason: "cấu hình dự án và toolchain",
    test: (p) =>
      /^(\.editorconfig|\.gitattributes|\.gitignore|\.oxlintrc\.json|\.prettierignore|\.prettierrc\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|vitest\.config\.ts)$/u.test(
        p,
      ),
  },
  { reason: "mã nguồn", test: (p) => p.startsWith("packages/") || p.startsWith("apps/") },
  { reason: "test", test: (p) => p.startsWith("tests/") },
  { reason: "quy trình CI", test: (p) => p.startsWith(".github/") },
  {
    reason: "công cụ vận hành",
    test: (p) => p.startsWith("tools/") && p !== "tools/build_architecture_pdf.py",
  },
  {
    reason: "tài liệu kỹ thuật",
    test: (p) =>
      [
        "docs/01-architecture.md",
        "docs/02-domain-invariants.md",
        "docs/04-quality-gates.md",
        "docs/08-operator-runbook.md",
      ].includes(p),
  },
  {
    reason: "quyết định kiến trúc (ADR)",
    test: (p) => p.startsWith("docs/decisions/") && p !== "docs/decisions/0002-prototype-first.md",
  },
  // Only these two files under data/. Everything else there is legal data or a
  // manifest of it, and whether archived sources may be served publicly is an
  // open owner decision (P-025 VER-005) - so it must never leak by default.
  {
    reason: "hướng dẫn thư mục dữ liệu",
    test: (p) => p === "data/manual/README.md" || p === "data/manual/sources/README.md",
  },
];

const withhold = [
  { reason: "bản public tự giữ (không đồng bộ đè)", test: (path) => mirrorOwned.has(path) },
  { reason: "hiến pháp làm việc nội bộ", test: (p) => p === "AGENTS.md" },
  {
    reason: "chiến lược và kế hoạch của chủ dự án",
    test: (p) =>
      [
        "docs/00-project-charter.md",
        "docs/03-ai-engineering-contract.md",
        "docs/05-roadmap.md",
        "docs/06-source-register.md",
        "docs/07-spec-traceability.md",
        "docs/decisions/0002-prototype-first.md",
      ].includes(p),
  },
  { reason: "hồ sơ điều hành phase", test: (p) => p.startsWith("docs/phases/") },
  { reason: "tài liệu tham chiếu nội bộ", test: (p) => p.startsWith("docs/reference/") },
  { reason: "công cụ dựng tài liệu nội bộ", test: (p) => p === "tools/build_architecture_pdf.py" },
  {
    reason: "dữ liệu pháp luật và manifest (VER-005 chưa quyết)",
    test: (p) => p.startsWith("data/"),
  },
];

function classify(path) {
  for (const rule of publish) {
    if (rule.test(path)) return { rule, verdict: "publish" };
  }
  for (const rule of withhold) {
    if (rule.test(path)) return { rule, verdict: "withhold" };
  }
  return { verdict: "unclassified" };
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);

const chosen = [];
const held = [];
const unknown = [];
for (const path of tracked) {
  const { rule, verdict } = classify(path);
  if (verdict === "publish") chosen.push({ path, reason: rule.reason });
  else if (verdict === "withhold") held.push({ path, reason: rule.reason });
  else unknown.push(path);
}

say(`Bản public dựng từ ${String(tracked.length)} file đang theo dõi trong repo riêng.\n`);

const byReason = new Map();
for (const entry of chosen) {
  byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
}
say("ĐƯA LÊN:");
for (const [reason, count] of byReason) {
  say(`  ${String(count).padStart(3)} file  ${reason}`);
}

const heldByReason = new Map();
for (const entry of held) {
  heldByReason.set(entry.reason, (heldByReason.get(entry.reason) ?? 0) + 1);
}
say("\nGIỮ RIÊNG:");
for (const [reason, count] of heldByReason) {
  say(`  ${String(count).padStart(3)} file  ${reason}`);
}
for (const entry of held) {
  say(`      ${entry.path}`);
}

if (unknown.length > 0) {
  say("\nCHƯA PHÂN LOẠI - dừng lại, phải quyết từng file:");
  for (const path of unknown) {
    say(`  ${path}`);
  }
  say(
    "\nKhông đẩy gì cả. Thêm file vào danh sách publish hoặc withhold trong tools/publish-public.mjs rồi chạy lại.",
  );
  process.exit(1);
}

// Second layer: a published file must not point readers at something withheld.
// Not fatal - a passing mention is fine - but it must be seen, not discovered
// by a stranger following a dead link into the shape of the private repo.
const withheldPaths = new Set(held.map((entry) => entry.path));
const leaks = [];
await Promise.all(
  chosen.map(async (entry) => {
    if (!/\.(md|ts|tsx|mjs|json)$/u.test(entry.path)) return;
    const text = await readFile(join(root, entry.path), "utf8");
    for (const path of withheldPaths) {
      if (text.includes(path)) {
        leaks.push(`${entry.path} nhắc tới ${path}`);
      }
    }
  }),
);
if (leaks.length > 0) {
  say("\nCẢNH BÁO - file public đang trỏ tới tài liệu giữ riêng:");
  for (const leak of leaks.toSorted()) {
    say(`  ${leak}`);
  }
}

if (!apply) {
  say(
    `\nĐây là chạy thử. Thêm --apply để ghi vào ${relative(root, mirror)}. Lệnh git ở đó vẫn làm tay.`,
  );
  process.exit(0);
}

const mirrorExists = await stat(mirror).then(
  () => true,
  () => false,
);
if (!mirrorExists) {
  say(`\nKhông thấy thư mục ${mirror}. Clone repo public về đó trước.`);
  process.exit(1);
}

// Remove anything the mirror carries that the allowlist no longer chooses, so a
// file that becomes private stops being published rather than lingering.
const mirrorTracked = execFileSync("git", ["ls-files"], { cwd: mirror, encoding: "utf8" })
  .split(/\r?\n/u)
  .filter(Boolean);
const keep = new Set(chosen.map((entry) => entry.path));
for (const path of mirrorOwned) {
  keep.add(path);
}
const stale = mirrorTracked.filter((path) => !keep.has(path));
await Promise.all(stale.map(async (path) => rm(join(mirror, path), { force: true })));
const removed = stale.length;

await Promise.all(
  chosen.map(async (entry) => {
    const target = join(mirror, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, entry.path), target);
  }),
);
const copied = chosen.length;

// The mirror must not carry the private repo's ignore rules for legal data,
// because the mirror has none of it - but it must keep the byte-preserving
// rules, or a release published there would fail its own hash.
await writeFile(
  join(mirror, ".gitattributes"),
  await readFile(join(root, ".gitattributes"), "utf8"),
  "utf8",
);

say(
  `\nĐã ghi vào ${mirror}: ${String(copied)} file chép sang, ${String(removed)} file gỡ khỏi bản public.`,
);
say("Xem `git status` và `git diff` ở thư mục đó trước khi commit và push.");
