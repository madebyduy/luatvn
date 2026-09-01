export type ViewName = "tra-cuu" | "so-sanh" | "luoc-su";

export const viewNames: readonly ViewName[] = ["tra-cuu", "so-sanh", "luoc-su"];

export const viewLabels: Record<ViewName, string> = {
  "luoc-su": "Lược sử sửa đổi",
  "so-sanh": "So sánh hai phiên bản",
  "tra-cuu": "Tra cứu theo thời điểm",
};

export interface TimeMachineState {
  readonly datasetReleaseId: string;
  readonly fromVersionId: string;
  readonly knownAt: string;
  readonly provisionId: string;
  readonly toVersionId: string;
  readonly validAt: string;
  readonly view: ViewName;
}

export const emptyState: TimeMachineState = {
  datasetReleaseId: "",
  fromVersionId: "",
  knownAt: "",
  provisionId: "",
  toVersionId: "",
  validAt: "",
  view: "tra-cuu",
};

const parameterNames = {
  datasetReleaseId: "release",
  fromVersionId: "from",
  knownAt: "knownAt",
  provisionId: "provision",
  toVersionId: "to",
  validAt: "validAt",
  view: "view",
} as const;

function readView(value: string | null): ViewName {
  return viewNames.find((name) => name === value) ?? "tra-cuu";
}

// The question itself is the address: view, provision, legal date, release, the
// system time the answer was computed against and the two versions being
// compared all live in the URL, so reloading or sharing a link reproduces
// exactly the same question.
export function parseTimeMachineState(search: string): TimeMachineState {
  const parameters = new URLSearchParams(search);
  return {
    datasetReleaseId: parameters.get(parameterNames.datasetReleaseId) ?? "",
    fromVersionId: parameters.get(parameterNames.fromVersionId) ?? "",
    knownAt: parameters.get(parameterNames.knownAt) ?? "",
    provisionId: parameters.get(parameterNames.provisionId) ?? "",
    toVersionId: parameters.get(parameterNames.toVersionId) ?? "",
    validAt: parameters.get(parameterNames.validAt) ?? "",
    view: readView(parameters.get(parameterNames.view)),
  };
}

export function toSearchString(state: TimeMachineState): string {
  const parameters = new URLSearchParams();
  const set = (name: string, value: string): void => {
    if (value !== "") parameters.set(name, value);
  };
  set(parameterNames.view, state.view);
  set(parameterNames.provisionId, state.provisionId);
  set(parameterNames.validAt, state.validAt);
  set(parameterNames.fromVersionId, state.fromVersionId);
  set(parameterNames.toVersionId, state.toVersionId);
  set(parameterNames.datasetReleaseId, state.datasetReleaseId);
  set(parameterNames.knownAt, state.knownAt);
  const query = parameters.toString();
  return query === "" ? "" : `?${query}`;
}

export function isQueryable(state: TimeMachineState): boolean {
  if (state.datasetReleaseId === "" || state.provisionId === "") {
    return false;
  }
  if (state.view === "tra-cuu") return state.validAt !== "";
  if (state.view === "so-sanh") return state.fromVersionId !== "" && state.toVersionId !== "";
  return true;
}

export function currentInstant(): string {
  return new Date().toISOString();
}
