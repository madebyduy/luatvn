import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const scanRoots = ["apps", "packages", "tests"];
const productionRoots = ["apps", "packages", "data/manual"];
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

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Code guardrails passed.\n");
}
