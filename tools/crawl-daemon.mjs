#!/usr/bin/env node
// Runs the gazette crawl unattended, one round after another, and stops on its
// own. Written because a crawl that only advances while somebody watches a
// terminal will never build a corpus: each round costs minutes, and the useful
// number of rounds is "keep going until the seeds are exhausted".
//
// It changes nothing that a single round would not change. The batch command
// keeps its own state file, so stopping this at any moment - a closed laptop, a
// killed shell - loses at most the document being fetched, and the next run
// picks up from the same place.
//
//   node tools/crawl-daemon.mjs --seeds-file tmp/seeds.txt --release rel_003
//     [--rounds 12] [--max 40] [--state <file>] [--backup-to <dir>]
//     [--retry-unclean]

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function readFlags(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token?.startsWith("--") !== true) {
      continue;
    }
    const next = argv[index + 1];
    flags.set(token.slice(2), next?.startsWith("--") === false ? next : "true");
  }
  return flags;
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function main() {
  const flags = readFlags(process.argv.slice(2));
  const seedsFile = flags.get("seeds-file") ?? join("tmp", "seeds.txt");
  const releaseId = flags.get("release") ?? "rel_003";
  const rounds = Number(flags.get("rounds") ?? "12");
  const max = flags.get("max") ?? "40";
  const stagingPath =
    flags.get("out") ?? join("data", "manual", `staging-${releaseId.replaceAll("_", "-")}.json`);
  const backupTo = flags.get("backup-to") ?? null;
  // One ledger of crawled URLs across every release, so a new staging file does
  // not mean re-fetching everything already held.
  const statePath = flags.get("state") ?? join("data", "manual", "crawl-state.json");

  const seeds = (await readFile(seedsFile, "utf8"))
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry.startsWith("https://"));
  if (seeds.length === 0) {
    process.stderr.write(`${seedsFile} không có seed https nào\n`);
    process.exit(2);
  }

  const logDirectory = join("data", "manual", "crawl-log");
  await mkdir(logDirectory, { recursive: true });
  const logPath = join(logDirectory, `${new Date().toISOString().slice(0, 10)}.log`);
  const note = async (text) => {
    process.stdout.write(`${text}\n`);
    await appendFile(logPath, `${text}\n`, "utf8");
  };

  await note(
    `\n=== ${stamp()} bắt đầu, ${String(seeds.length)} seed, tối đa ${String(rounds)} lượt ===`,
  );

  // The extractor keeps improving, and every improvement is worth exactly as
  // much as the documents it can be applied to. A document refused or flagged
  // last week was judged by last week's code; without this it stays judged that
  // way forever, because the ledger only remembers that it was seen. Clearing
  // the entries that did not come out clean puts them back in the queue while
  // leaving the clean ones alone, so a re-run costs only what it has to.
  if (flags.get("retry-unclean") === "true") {
    let state = null;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch {
      state = null;
    }
    if (state?.documents !== undefined) {
      const before = Object.keys(state.documents).length;
      const kept = {};
      for (const [url, entry] of Object.entries(state.documents)) {
        if (entry?.status === "ingested") kept[url] = entry;
      }
      state.documents = kept;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await note(
        `${stamp()} xoá ${String(before - Object.keys(kept).length)} mục chưa sạch khỏi sổ để bóc lại; giữ ${String(Object.keys(kept).length)} mục đã sạch`,
      );
    }
  }

  let totalFetched = 0;
  let quietRounds = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const started = Date.now();
    // eslint-disable-next-line no-await-in-loop -- rounds are sequential on purpose: each one reads the state the previous one wrote, and the site is crawled politely one request at a time
    const result = await run(process.execPath, [
      join("tools", "ingest-cli.mjs"),
      "congbao-batch",
      "--seeds",
      seeds.join(","),
      "--release",
      releaseId,
      "--out",
      stagingPath,
      "--max",
      max,
      "--state",
      statePath,
    ]);
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    const summary = /^lần này:.*$/mu.exec(result.output)?.[0] ?? "(không đọc được tổng kết)";
    const fetched = Number(/(\d+)\s+văn bản sạch/u.exec(summary)?.[1] ?? "0");
    const review = Number(/(\d+)\s+cần người xem/u.exec(summary)?.[1] ?? "0");
    const refused = Number(/(\d+)\s+từ chối/u.exec(summary)?.[1] ?? "0");
    const transient = Number(/(\d+)\s+tạm lỗi/u.exec(summary)?.[1] ?? "0");
    totalFetched += fetched;
    // eslint-disable-next-line no-await-in-loop -- see above
    await note(`${stamp()} lượt ${String(round)} (${minutes} phút): ${summary}`);

    if (result.code !== 0) {
      // eslint-disable-next-line no-await-in-loop -- see above
      await note(`${stamp()} lượt ${String(round)} lỗi mã ${String(result.code)}; dừng`);
      break;
    }
    // Nothing fetched, flagged or refused means every URL the seeds reach has
    // been seen. A transient failure does not mean that: the document was not
    // processed and the next round would retry it, so stopping on the first
    // such round would leave it uncrawled and look like completion. Give the
    // retries two rounds to settle before calling the seeds exhausted.
    if (fetched === 0 && review === 0 && refused === 0) {
      if (transient > 0 && quietRounds === 0) {
        quietRounds += 1;
        // eslint-disable-next-line no-await-in-loop -- see above
        await note(
          `${stamp()} không có văn bản mới nhưng còn ${String(transient)} lỗi tạm; thử lại một lượt nữa`,
        );
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- see above
      await note(
        `${stamp()} hết văn bản mới từ các seed hiện có; dừng sau ${String(round)} lượt${transient > 0 ? ` (còn ${String(transient)} lỗi tạm chưa lấy được - chạy lại sau)` : ""}`,
      );
      break;
    }
    quietRounds = 0;
  }

  if (backupTo !== null && totalFetched > 0) {
    const backup = await run(process.execPath, [
      join("tools", "dataset-cli.mjs"),
      "backup",
      "--to",
      backupTo,
    ]);
    const last = backup.output.trim().split("\n").at(-1) ?? "";
    await note(
      `${stamp()} sao lưu -> ${backupTo}: ${backup.code === 0 ? last : `LỖI mã ${String(backup.code)}`}`,
    );
  }

  await note(`${stamp()} xong; ${String(totalFetched)} văn bản sạch thêm trong phiên này`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
