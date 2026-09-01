import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Two kinds of rule live here. The code rules apply to any checkout, including
// the public mirror. The governance rules only mean anything where the phase
// documents exist, and this script must not carry a copy of the private phase
// registry - that would both duplicate the registry and publish it.
const codeRequiredFiles = [
  "docs/01-architecture.md",
  "docs/02-domain-invariants.md",
  "docs/08-operator-runbook.md",
];
const governanceRequiredFiles = [
  "AGENTS.md",
  "docs/00-project-charter.md",
  "docs/07-spec-traceability.md",
  "docs/phases/README.md",
  "docs/phases/_template.md",
];
const scanRoots = ["apps", "packages", "tests"];
const productionRoots = ["apps", "packages", "data/manual"];
const architecturePdf = "docs/reference/LuatVN-Kien-truc-v3.1-full.pdf";
const architecturePdfSha256 = "28c6fee2f5c61b58de37f519525f9ef74376013a5bf73749595518c262c74917";
const allowedPhaseStatuses = new Set([
  "Draft",
  "Planned",
  "Ready",
  "In progress",
  "Blocked",
  "Acceptance",
  "Complete",
  "Backlog",
]);
const requiredPhaseSections = [
  "## Fact sheet",
  "## Entry criteria",
  "## Work items",
  "## Outputs and quality",
  "## Acceptance",
  "### Completion declaration",
  "## Risks and rollback",
  "## Acceptance log",
];
const completedPhaseChecks = [
  "- [x] All required outputs exist.",
  "- [x] All acceptance scenarios pass.",
  "- [x] All quality gates pass.",
  "- [x] No open P0/P1 remains in phase scope.",
  "- [x] Acceptance log contains an `Accepted` outcome and reproducible evidence.",
];
const forbidden = [
  { pattern: /@ts-ignore/u, reason: "@ts-ignore weakens type safety" },
  { pattern: /@ts-nocheck/u, reason: "@ts-nocheck disables verification" },
  { pattern: /\bany\b/u, reason: "explicit any is forbidden" },
  { pattern: /\bTODO\b|\bFIXME\b/u, reason: "untracked TODO/FIXME is forbidden" },
];

const skippedDirectories = new Set(["node_modules", "dist", ".git"]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        return skippedDirectories.has(entry.name) ? [] : walk(join(directory, entry.name));
      }
      return [join(directory, entry.name)];
    }),
  );
  return nestedFiles.flat();
}

const failures = [];

const governed = await readFile(join(root, "docs/phases/README.md"), "utf8").then(
  (text) => text,
  () => undefined,
);
if (governed === undefined) {
  // Say so out loud. A check that quietly turns into a pass is worse than no
  // check, because it reads like one that ran.
  process.stdout.write(
    "Phase documents are not present in this checkout; governance checks skipped, code guardrails still enforced.\n",
  );
}

await Promise.all(
  [...codeRequiredFiles, ...(governed === undefined ? [] : governanceRequiredFiles)].map(
    async (required) => {
      try {
        await readFile(join(root, required));
      } catch {
        failures.push(`Missing required file: ${required}`);
      }
    },
  ),
);

// The registry is the single source of truth for which phases exist. Read it
// rather than restating it, so the two can never disagree.
const phaseDocuments = [];
if (governed !== undefined) {
  const registryRows = governed.matchAll(
    /^\|\s*([A-Z]+-\d+)\s*\|[^|]*\|[^|]*\|[^|]*\|\s*\[[^\]]*\]\(\.\/([^)]+)\)/gmu,
  );
  for (const row of registryRows) {
    phaseDocuments.push({ id: row[1], path: `docs/phases/${row[2]}` });
  }
  if (phaseDocuments.length === 0) {
    failures.push("docs/phases/README.md: registry table parsed to zero phases");
  }
  const registered = new Set(phaseDocuments.map((phase) => phase.path));
  const present = await readdir(join(root, "docs/phases"));
  for (const entry of present) {
    const path = `docs/phases/${entry}`;
    if (extname(entry) === ".md" && entry !== "README.md" && entry !== "_template.md") {
      if (!registered.has(path)) {
        failures.push(`${path}: phase document is not registered in docs/phases/README.md`);
      }
    }
  }
}

const roadmap =
  governed === undefined ? "" : await readFile(join(root, "docs/05-roadmap.md"), "utf8");
const phaseRegistry = governed ?? "";

await Promise.all(
  phaseDocuments.map(async (phase) => {
    const source = await readFile(join(root, phase.path), "utf8");
    if (!source.includes(`- **ID:** \`${phase.id}\``)) {
      failures.push(`${phase.path}: missing or mismatched phase ID ${phase.id}`);
    }

    const statusMatch = /^- \*\*Status:\*\* (.+)$/mu.exec(source);
    const status = statusMatch?.[1];
    if (status === undefined || !allowedPhaseStatuses.has(status)) {
      failures.push(`${phase.path}: missing or unsupported phase status`);
      return;
    }

    for (const section of requiredPhaseSections) {
      if (!source.includes(section)) {
        failures.push(`${phase.path}: missing required section "${section}"`);
      }
    }

    const registryRow = new RegExp(`^\\|\\s*${phase.id}\\s*\\|.*\\|\\s*${status}\\s*\\|`, "mu");
    if (!registryRow.test(phaseRegistry)) {
      failures.push(`${phase.path}: status differs from docs/phases/README.md`);
    }
    if (!registryRow.test(roadmap)) {
      failures.push(`${phase.path}: status differs from docs/05-roadmap.md`);
    }

    if (status === "Complete") {
      for (const completedCheck of completedPhaseChecks) {
        if (!source.includes(completedCheck)) {
          failures.push(`${phase.path}: Complete phase has an unchecked completion declaration`);
        }
      }
      if (!/^\| \d{4}-\d{2}-\d{2} \| Accepted\s+\|/mu.test(source)) {
        failures.push(`${phase.path}: Complete phase has no Accepted outcome in its log`);
      }
    }
  }),
);

if (governed !== undefined) {
  try {
    const pdf = await readFile(join(root, architecturePdf));
    const actualHash = createHash("sha256").update(pdf).digest("hex");
    if (actualHash !== architecturePdfSha256) {
      failures.push(`${architecturePdf}: SHA-256 differs from the registered source`);
    }
  } catch {
    failures.push(`Missing registered architecture source: ${architecturePdf}`);
  }
}

const scanResults = await Promise.all(
  scanRoots.map(async (scanRoot) => {
    try {
      return await walk(join(root, scanRoot));
    } catch {
      return [];
    }
  }),
);

await Promise.all(
  scanResults.flat().map(async (file) => {
    if (![".ts", ".tsx", ".js", ".mjs", ".json"].includes(extname(file))) return;
    const text = await readFile(file, "utf8");
    for (const rule of forbidden) {
      if (rule.pattern.test(text)) {
        failures.push(`${relative(root, file)}: ${rule.reason}`);
      }
    }
  }),
);

const productionResults = await Promise.all(
  productionRoots.map(async (productionRoot) => {
    try {
      return await walk(join(root, productionRoot));
    } catch {
      return [];
    }
  }),
);

await Promise.all(
  productionResults.flat().map(async (file) => {
    if (![".ts", ".tsx", ".js", ".mjs", ".json"].includes(extname(file))) return;
    const source = await readFile(file, "utf8");
    if (/synthetic|example\.invalid/iu.test(source)) {
      failures.push(`${relative(root, file)}: synthetic legal data is forbidden in runtime code`);
    }
  }),
);

const domainFiles = await walk(join(root, "packages/domain/src"));
await Promise.all(
  domainFiles.map(async (file) => {
    if (extname(file) !== ".ts") return;
    const source = await readFile(file, "utf8");
    const imports = source.matchAll(/from\s+["']([^"']+)["']/gu);
    for (const match of imports) {
      const specifier = match[1];
      if (specifier !== undefined && !specifier.startsWith(".")) {
        failures.push(`${relative(root, file)}: domain imports external module "${specifier}"`);
      }
    }
  }),
);

// Nothing in this repository may need Git LFS to read. A clone on a machine
// without git-lfs installed gets the pointer text instead of the file, and a
// release whose bytes are a pointer fails its own hash - the same class of
// break as line-ending rewriting (ADR-0007).
try {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
  await Promise.all(
    tracked.map(async (file) => {
      let stored;
      try {
        stored = execFileSync("git", ["cat-file", "-p", `:${file}`], {
          cwd: root,
          encoding: "latin1",
          maxBuffer: 1024 * 1024,
        });
      } catch {
        return; // Too large to inspect cheaply, or unreadable; not an LFS pointer.
      }
      if (stored.startsWith("version https://git-lfs.github.com/spec/")) {
        failures.push(`${file}: stored as a Git LFS pointer; the repo must clone without git-lfs`);
      }
    }),
  );
} catch {
  // Not a git checkout (a tarball, say). Nothing to check.
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("AI/code guardrails passed.\n");
}
