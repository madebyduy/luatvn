// Builds a drill release through the real pipeline so every screen and the
// verification chain can be exercised before a reviewed corpus exists:
// extract -> link amendments -> promote -> publish with archives -> verify.
//
// The payloads below are operational placeholder text, never legal content, and
// everything is written to a throwaway directory - never to data/manual.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  extractVbplDraft,
  linkAmendments,
  mergeDrafts,
  relationEvidenceFrom,
} from "@luatvn/ingest";
import { promoteRecordToVerified, publishRelease, sha256HexOfText } from "@luatvn/manual-dataset";

const dataDirectory = process.argv[2] ?? "tmp/ui-drill";
const releaseId = "rel_ui_drill";
const amendedUuid = "11111111-2222-3333-4444-555555555555";
const amendingUuid = "99999999-8888-7777-6666-555555555555";
const allowedHosts = ["drill.invalid"];
const reviewer = "ui-drill-operator";

function drillPayload({ documentId, docNum, title, effFrom, effTo, provisionUuid, heading, text }) {
  const metadata = {
    docNum,
    effFrom: `${effFrom}T00:00:00`,
    effStatus: { name: "Diễn tập" },
    effTo: effTo === null ? null : `${effTo}T00:00:00`,
    id: documentId,
    issueDate: `${effFrom}T00:00:00`,
    title,
  };
  const html = [
    "<html><body>",
    `<p class="prov-article" id="${provisionUuid}"><span><strong>${heading}</strong></span></p>`,
    ...text.map((line) => `<p class="prov-clause" id="${provisionUuid}"><span>${line}</span></p>`),
    "</body></html>",
  ].join("\n");
  const chunkLength = Buffer.byteLength(html, "utf8").toString(16);
  return `0:["drill",null]\n1:${JSON.stringify(metadata)}\n2:T${chunkLength},${html}\n`;
}

// Two snapshots of the amended document plus the document that amends it.
const snapshots = [
  {
    docNum: "01/2020/TT-DRILL",
    documentId: "drill-doc",
    effFrom: "2020-01-01",
    effTo: "2024-01-01",
    heading: "Điều 1. Nguyên tắc diễn tập giao diện",
    provisionUuid: amendedUuid,
    text: [
      "1. Đây là văn bản diễn tập giao diện, không phải nội dung pháp luật.",
      "2. Phiên bản thứ nhất áp dụng từ ngày 01 tháng 01 năm 2020.",
      "3. Đoạn này sẽ được giữ nguyên ở phiên bản sau để thấy phần không đổi.",
    ],
    title: "Thông tư diễn tập số 01/2020/TT-DRILL",
  },
  {
    docNum: "01/2020/TT-DRILL",
    documentId: "drill-doc",
    effFrom: "2024-01-01",
    effTo: null,
    heading: "Điều 1. Nguyên tắc diễn tập giao diện",
    provisionUuid: amendedUuid,
    text: [
      "1. Đây là văn bản diễn tập giao diện, không phải nội dung pháp luật.",
      "2. Phiên bản thứ hai áp dụng từ ngày 01 tháng 01 năm 2024, thay cho phiên bản thứ nhất.",
      "3. Đoạn này sẽ được giữ nguyên ở phiên bản sau để thấy phần không đổi.",
      "4. Khoản này được bổ sung bởi văn bản sửa đổi.",
    ],
    title: "Thông tư diễn tập số 01/2020/TT-DRILL",
  },
  {
    docNum: "45/2023/TT-DRILL",
    documentId: "drill-doc-amending",
    effFrom: "2024-01-01",
    effTo: null,
    heading: "Điều 1. Sửa đổi, bổ sung khoản 2 Điều 1",
    provisionUuid: amendingUuid,
    text: [
      "Sửa đổi, bổ sung khoản 2 và bổ sung khoản 4 vào Điều 1 của Thông tư diễn tập số 01/2020/TT-DRILL.",
    ],
    title: "Thông tư diễn tập số 45/2023/TT-DRILL sửa đổi Thông tư 01/2020/TT-DRILL",
  },
];

await rm(dataDirectory, { recursive: true, force: true });
await mkdir(dataDirectory, { recursive: true });

const drafts = [];
const sources = [];
for (const snapshot of snapshots) {
  const flight = drillPayload(snapshot);
  const sourceSha256 = sha256HexOfText(flight);
  const { draft } = extractVbplDraft(flight, {
    datasetReleaseId: releaseId,
    evidence: {
      officialSourceUrl: `https://drill.invalid/van-ban/${snapshot.documentId}-${snapshot.effFrom}`,
      retrievedAt: "2026-08-31T00:00:00.000Z",
      sourceSha256,
    },
  });
  drafts.push(draft);
  sources.push({
    bytes: Buffer.from(flight, "utf8"),
    path: `${sourceSha256.slice(0, 12)}.rsc.txt`,
  });
}

const amendingDraft = drafts[2];
const amendedLatest = drafts[1];
const linked = linkAmendments({
  amendingProvisions: amendingDraft.provisionVersions,
  effectiveFrom: amendingDraft.provisionVersions[0].validTime.from,
  evidence: relationEvidenceFrom({
    officialSourceUrl: "https://drill.invalid/van-ban/drill-doc-amending",
    retrievedAt: "2026-08-31T00:00:00.000Z",
    sourceDocumentId: "drilldocamending",
    sourceSha256: sha256HexOfText(drillPayload(snapshots[2])),
  }),
  relationType: "amends",
  targetProvisions: amendedLatest.provisionVersions,
});

const merged = mergeDrafts(drafts, linked.amendments);
if (!merged.ok) {
  process.stderr.write(
    `drill draft invalid: ${merged.issues[0].path}: ${merged.issues[0].message}\n`,
  );
  process.exitCode = 1;
} else {
  // A human promotes every record; the machine never sets verified itself.
  let stagingText = `${JSON.stringify(merged.value, null, 2)}\n`;
  const reviewLog = [];
  for (const version of merged.value.provisionVersions) {
    const promoted = promoteRecordToVerified({
      datasetText: stagingText,
      provisionVersionId: version.provisionVersionId,
      reviewedBy: reviewer,
    });
    stagingText = promoted.updatedDatasetText;
    reviewLog.push(promoted.audit);
  }
  for (const amendment of merged.value.amendments) {
    const promoted = promoteRecordToVerified({
      amendmentId: amendment.amendmentId,
      datasetText: stagingText,
      reviewedBy: reviewer,
    });
    stagingText = promoted.updatedDatasetText;
    reviewLog.push(promoted.audit);
  }

  await writeFile(join(dataDirectory, "staging.json"), stagingText, "utf8");
  const published = await publishRelease(dataDirectory, stagingText, {
    allowedHosts,
    reviewLog,
    reviewedBy: reviewer,
    sources,
  });

  const versions = merged.value.provisionVersions.filter(
    (version) => version.provisionId === `prov_vbpl_${amendedUuid}`,
  );
  process.stdout.write(
    [
      `drill release published: ${published.datasetReleaseId} in ${dataDirectory}`,
      `  provisions: ${merged.value.provisionVersions.length}, amendments: ${merged.value.amendments.length}, archived sources: ${sources.length}, reviewer entries: ${reviewLog.length}`,
      linked.unlinked.length > 0
        ? `  not linked: ${linked.unlinked.map((entry) => entry.reason).join("; ")}`
        : "  every amending provision linked to a target",
      "",
      "Verify the chain:",
      `  pnpm dataset verify --data-dir ${dataDirectory} --allow-hosts drill.invalid`,
      "",
      "Serve it and open the UI:",
      `  LUATVN_DATA_DIR=${dataDirectory} LUATVN_SOURCE_HOST_ALLOWLIST=drill.invalid pnpm start`,
      "  pnpm web",
      "",
      "Screens to try:",
      `  Tra cứu 2021: ?view=tra-cuu&provision=prov_vbpl_${amendedUuid}&validAt=2021-06-01&release=${releaseId}`,
      `  Tra cứu 2025: ?view=tra-cuu&provision=prov_vbpl_${amendedUuid}&validAt=2025-06-01&release=${releaseId}`,
      `  So sánh:     ?view=so-sanh&provision=prov_vbpl_${amendedUuid}&from=${versions[0]?.provisionVersionId ?? ""}&to=${versions[1]?.provisionVersionId ?? ""}&release=${releaseId}`,
      `  Lược sử:     ?view=luoc-su&provision=prov_vbpl_${amendedUuid}&release=${releaseId}`,
      "",
    ].join("\n"),
  );
}
