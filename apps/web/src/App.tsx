import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  fetchAmendments,
  fetchCatalog,
  fetchComparison,
  fetchProvisionAt,
  fetchReadyState,
  type AmendmentsResponse,
  type CatalogDocument,
  type CatalogProvision,
  type CompareResponse,
  type ProvisionAtResponse,
} from "./api.js";
import { DiffView } from "./components/DiffView.js";
import { DocumentTree } from "./components/DocumentTree.js";
import { EvidencePanel, MetadataPanel } from "./components/MetadataPanel.js";
import { AskView } from "./components/AskView.js";
import { CitationCheckView } from "./components/CitationCheckView.js";
import { ProvisionResult } from "./components/ProvisionResult.js";
import { TraceView } from "./components/TraceView.js";
import {
  currentInstant,
  emptyState,
  isQueryable,
  parseTimeMachineState,
  toSearchString,
  viewLabels,
  viewNames,
  type TimeMachineState,
} from "./url-state.js";

type QueryStatus = "idle" | "loading" | "ready" | "failed";

interface Outcome {
  readonly amendments: AmendmentsResponse | null;
  readonly comparison: CompareResponse | null;
  readonly failure: string | null;
  readonly provision: ProvisionAtResponse | null;
  readonly status: QueryStatus;
}

const idleOutcome: Outcome = {
  amendments: null,
  comparison: null,
  failure: null,
  provision: null,
  status: "idle",
};

function findProvision(
  documents: readonly CatalogDocument[],
  provisionId: string,
): { readonly document: CatalogDocument; readonly provision: CatalogProvision } | null {
  for (const document of documents) {
    for (const provision of document.provisions) {
      if (provision.provisionId === provisionId) {
        return { document, provision };
      }
    }
  }
  return null;
}

function versionLabel(version: CatalogProvision["versions"][number]): string {
  return version.validTo === null
    ? `Từ ${version.validFrom} trở đi`
    : `Từ ${version.validFrom} đến trước ${version.validTo}`;
}

export function App() {
  const [form, setForm] = useState<TimeMachineState>(emptyState);
  const [documents, setDocuments] = useState<readonly CatalogDocument[]>([]);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(idleOutcome);
  const resultsRef = useRef<HTMLDivElement>(null);
  const shouldFocusResults = useRef(false);

  const runQuery = useCallback(async (state: TimeMachineState): Promise<void> => {
    setOutcome({ ...idleOutcome, status: "loading" });
    const context = {
      datasetReleaseId: state.datasetReleaseId,
      knownAt: state.knownAt === "" ? currentInstant() : state.knownAt,
    };
    try {
      if (state.view === "so-sanh") {
        const comparison = await fetchComparison(context, {
          fromVersionId: state.fromVersionId,
          toVersionId: state.toVersionId,
        });
        setOutcome({ ...idleOutcome, comparison, status: "ready" });
        return;
      }
      if (state.view === "luoc-su") {
        const amendments = await fetchAmendments(context, {
          maxDepth: 2,
          provisionId: state.provisionId,
        });
        setOutcome({ ...idleOutcome, amendments, status: "ready" });
        return;
      }
      const provision = await fetchProvisionAt(context, {
        provisionId: state.provisionId,
        validAt: state.validAt,
      });
      setOutcome({ ...idleOutcome, provision, status: "ready" });
    } catch (error) {
      setOutcome({
        ...idleOutcome,
        failure: error instanceof ApiError ? error.message : "Không thực hiện được truy vấn.",
        status: "failed",
      });
    }
  }, []);

  const applyState = useCallback(
    (state: TimeMachineState): void => {
      setForm(state);
      if (isQueryable(state)) {
        shouldFocusResults.current = true;
        void runQuery(state);
      } else {
        setOutcome(idleOutcome);
      }
    },
    [runQuery],
  );

  useEffect(() => {
    const start = async (): Promise<void> => {
      const fromUrl = parseTimeMachineState(globalThis.location.search);
      let state = fromUrl;
      if (state.datasetReleaseId === "") {
        const ready = await fetchReadyState();
        if (ready !== null) {
          state = { ...state, datasetReleaseId: ready.datasetReleaseId };
        }
      }
      applyState(state);

      if (state.datasetReleaseId === "") {
        setCatalogNote("Chưa kết nối được máy chủ nên không tải được danh mục văn bản.");
        return;
      }
      try {
        const catalog = await fetchCatalog({
          datasetReleaseId: state.datasetReleaseId,
          knownAt: state.knownAt === "" ? currentInstant() : state.knownAt,
        });
        setDocuments(catalog.data.documents);
        setCatalogNote(
          catalog.data.documents.length === 0 ? "Bản phát hành này chưa có văn bản nào." : null,
        );
      } catch (error) {
        setCatalogNote(
          error instanceof ApiError
            ? `Không tải được danh mục: ${error.message}`
            : "Không tải được danh mục văn bản.",
        );
      }
    };
    void start();

    const onPopState = (): void => {
      applyState(parseTimeMachineState(globalThis.location.search));
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => {
      globalThis.removeEventListener("popstate", onPopState);
    };
  }, [applyState]);

  useEffect(() => {
    if (outcome.status !== "loading" && shouldFocusResults.current) {
      shouldFocusResults.current = false;
      resultsRef.current?.focus();
    }
  }, [outcome.status]);

  const commit = (state: TimeMachineState): void => {
    setForm(state);
    globalThis.history.pushState(
      null,
      "",
      `${globalThis.location.pathname}${toSearchString(state)}`,
    );
    if (isQueryable(state)) {
      shouldFocusResults.current = true;
      void runQuery(state);
    } else {
      setOutcome(idleOutcome);
    }
  };

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    commit({ ...form, knownAt: form.knownAt === "" ? currentInstant() : form.knownAt });
  };

  const selected = findProvision(documents, form.provisionId);
  const versions = selected?.provision.versions ?? [];
  const citation =
    outcome.provision?.data.status === "resolved" ? outcome.provision.data.citation : null;

  return (
    <>
      <a className="skip-link" href="#main">
        Bỏ qua, tới nội dung chính
      </a>

      <header className="masthead">
        <div className="masthead-inner">
          <div className="brand">
            <span aria-hidden="true" className="brand-mark">
              LV
            </span>
            <span className="brand-text">
              <span className="brand-name">LuatVN</span>
              <span className="brand-sub">Tra cứu điều khoản pháp luật theo thời điểm</span>
            </span>
          </div>
          <p className="release-chip">
            <span className="release-chip-label">Bản phát hành</span>
            <code>{form.datasetReleaseId === "" ? "chưa xác định" : form.datasetReleaseId}</code>
          </p>
        </div>
        <nav aria-label="Chế độ xem" className="view-nav">
          <ul>
            {viewNames.map((name) => (
              <li key={name}>
                <a
                  aria-current={form.view === name ? "page" : undefined}
                  href={toSearchString({ ...form, view: name })}
                  onClick={(event) => {
                    event.preventDefault();
                    commit({ ...form, view: name });
                  }}
                >
                  {viewLabels[name]}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <nav aria-label="Đường dẫn" className="breadcrumb">
        <ol>
          <li>Danh mục</li>
          <li>{selected?.document.documentNumber ?? "Chưa chọn văn bản"}</li>
          <li aria-current="page">
            {selected?.provision.heading ??
              (form.provisionId === "" ? "Chưa chọn điều khoản" : form.provisionId)}
          </li>
        </ol>
      </nav>

      <div className="layout" id="main" tabIndex={-1}>
        <div className="rail rail-left">
          <DocumentTree
            documents={documents}
            note={catalogNote}
            onSelect={(provisionId) => {
              commit({ ...form, fromVersionId: "", provisionId, toVersionId: "" });
            }}
            selectedProvisionId={form.provisionId}
          />
          {documents.length === 0 && (
            <div className="side-panel">
              <label className="panel-title" htmlFor="provisionId">
                Mã điều khoản
              </label>
              <input
                id="provisionId"
                onChange={(event) => {
                  setForm((previous) => ({ ...previous, provisionId: event.target.value }));
                }}
                value={form.provisionId}
              />
              <p className="hint">Nhập tay khi danh mục chưa tải được.</p>
            </div>
          )}
        </div>

        <main className="content">
          {form.view === "hoi" ? (
            <AskView
              context={{
                datasetReleaseId: form.datasetReleaseId,
                knownAt: form.knownAt === "" ? currentInstant() : form.knownAt,
              }}
              initialQuery={form.query}
              onAsked={(query) => {
                const next = { ...form, query };
                setForm(next);
                globalThis.history.replaceState(
                  null,
                  "",
                  `${globalThis.location.pathname}${toSearchString(next)}`,
                );
              }}
            />
          ) : form.view === "kiem-chung" ? (
            <CitationCheckView
              context={{
                datasetReleaseId: form.datasetReleaseId,
                knownAt: form.knownAt === "" ? currentInstant() : form.knownAt,
              }}
            />
          ) : (
            <>
              <form className="toolbar" onSubmit={onSubmit}>
                <fieldset>
                  <legend className="visually-hidden">{viewLabels[form.view]}</legend>

                  {form.view === "tra-cuu" && (
                    <div className="toolbar-field">
                      <label htmlFor="validAt">Ngày pháp lý cần hỏi</label>
                      <input
                        id="validAt"
                        onChange={(event) => {
                          setForm((previous) => ({ ...previous, validAt: event.target.value }));
                        }}
                        required
                        type="date"
                        value={form.validAt}
                      />
                    </div>
                  )}

                  {form.view === "so-sanh" && (
                    <>
                      <div className="toolbar-field">
                        <label htmlFor="fromVersionId">Phiên bản trước</label>
                        <select
                          id="fromVersionId"
                          onChange={(event) => {
                            setForm((previous) => ({
                              ...previous,
                              fromVersionId: event.target.value,
                            }));
                          }}
                          value={form.fromVersionId}
                        >
                          <option value="">— Chọn phiên bản —</option>
                          {versions.map((version) => (
                            <option
                              key={version.provisionVersionId}
                              value={version.provisionVersionId}
                            >
                              {versionLabel(version)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="toolbar-field">
                        <label htmlFor="toVersionId">Phiên bản sau</label>
                        <select
                          id="toVersionId"
                          onChange={(event) => {
                            setForm((previous) => ({
                              ...previous,
                              toVersionId: event.target.value,
                            }));
                          }}
                          value={form.toVersionId}
                        >
                          <option value="">— Chọn phiên bản —</option>
                          {versions.map((version) => (
                            <option
                              key={version.provisionVersionId}
                              value={version.provisionVersionId}
                            >
                              {versionLabel(version)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}

                  {form.view === "luoc-su" && (
                    <p className="toolbar-note">
                      Hiển thị quan hệ sửa đổi đã được người kiểm chứng, kèm nguồn của từng quan hệ.
                    </p>
                  )}

                  <button type="submit">
                    {form.view === "so-sanh"
                      ? "So sánh"
                      : form.view === "luoc-su"
                        ? "Xem lược sử"
                        : "Tra cứu"}
                  </button>
                </fieldset>
              </form>

              <div aria-live="polite" className="results" ref={resultsRef} tabIndex={-1}>
                {outcome.status === "loading" && (
                  <p className="doc-card state-loading" role="status">
                    Đang tra cứu…
                  </p>
                )}

                {outcome.status === "failed" && outcome.failure !== null && (
                  <div className="doc-card state-conflict" role="alert">
                    <p className="state-badge">Không tra cứu được</p>
                    <p>{outcome.failure}</p>
                    <p className="note">
                      Câu hỏi của bạn vẫn được giữ nguyên trên thanh địa chỉ, thử lại khi máy chủ
                      sẵn sàng.
                    </p>
                  </div>
                )}

                {outcome.status === "ready" && outcome.provision !== null && (
                  <ProvisionResult response={outcome.provision} />
                )}
                {outcome.status === "ready" && outcome.comparison !== null && (
                  <DiffView response={outcome.comparison} />
                )}
                {outcome.status === "ready" && outcome.amendments !== null && (
                  <TraceView provisionId={form.provisionId} response={outcome.amendments} />
                )}

                {outcome.status === "idle" && (
                  <p className="doc-card note">
                    {form.view === "so-sanh"
                      ? "Chọn một điều khoản ở danh mục bên trái, rồi chọn hai phiên bản để xem phần thay đổi."
                      : form.view === "luoc-su"
                        ? "Chọn một điều khoản ở danh mục bên trái để xem chuỗi sửa đổi."
                        : "Chọn một điều khoản ở danh mục bên trái và nhập ngày pháp lý để bắt đầu."}
                  </p>
                )}
              </div>
            </>
          )}
        </main>

        <aside aria-label="Thuộc tính và bằng chứng" className="rail rail-right">
          {citation === null ? (
            <section className="side-panel">
              <h2 className="panel-title">Thuộc tính văn bản</h2>
              <p className="hint">
                Thuộc tính và bằng chứng nguồn hiện ở đây sau khi tra cứu được một điều khoản.
              </p>
            </section>
          ) : (
            <>
              <MetadataPanel citation={citation} />
              <EvidencePanel citation={citation} />
            </>
          )}

          <details className="side-panel">
            <summary>Tùy chọn nâng cao</summary>
            <label htmlFor="datasetReleaseId">Bản phát hành dữ liệu</label>
            <input
              id="datasetReleaseId"
              onChange={(event) => {
                setForm((previous) => ({ ...previous, datasetReleaseId: event.target.value }));
              }}
              value={form.datasetReleaseId}
            />
            <p className="hint">
              Ảnh chụp dữ liệu dùng để tái hiện đúng câu trả lời này. Đổi khi cần tra trên bản phát
              hành khác.
            </p>
          </details>
        </aside>
      </div>

      <footer className="site-footer">
        <p>
          Dữ liệu pháp luật hiển thị nguyên văn từ nguồn đã đăng ký, kèm địa chỉ nguồn và SHA-256 để
          đối chiếu. Đây không phải tư vấn pháp lý.
        </p>
      </footer>
    </>
  );
}
