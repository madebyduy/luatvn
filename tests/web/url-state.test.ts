import {
  emptyState,
  isQueryable,
  parseTimeMachineState,
  toSearchString,
  type TimeMachineState,
} from "../../apps/web/src/url-state.js";
import { describe, expect, it } from "vitest";

const fullState: TimeMachineState = {
  datasetReleaseId: "rel_drill_ui",
  fromVersionId: "pv_vbpl_a17_e20200101",
  knownAt: "2026-09-01T00:00:00.000Z",
  provisionId: "prov_vbpl_a17",
  toVersionId: "pv_vbpl_a17_e20240101",
  validAt: "2024-06-01",
  view: "so-sanh",
};

describe("time machine URL state", () => {
  it("round-trips a full question through the query string", () => {
    expect(parseTimeMachineState(toSearchString(fullState))).toEqual(fullState);
  });

  it("keeps every part of the question addressable", () => {
    const search = toSearchString(fullState);
    expect(search).toContain("view=so-sanh");
    expect(search).toContain("provision=prov_vbpl_a17");
    expect(search).toContain("validAt=2024-06-01");
    expect(search).toContain("release=rel_drill_ui");
    expect(search).toContain("knownAt=2026-09-01");
  });

  it("reads an empty search as an empty question rather than inventing values", () => {
    expect(parseTimeMachineState("")).toEqual(emptyState);
  });

  it("omits fields that were never filled in", () => {
    expect(toSearchString({ ...emptyState, provisionId: "prov_vbpl_a17" })).toBe(
      "?view=tra-cuu&provision=prov_vbpl_a17",
    );
  });

  it("keeps the chosen view in the address", () => {
    expect(parseTimeMachineState("?view=luoc-su").view).toBe("luoc-su");
  });

  it("falls back to the lookup view when the address names an unknown one", () => {
    expect(parseTimeMachineState("?view=khong-ton-tai").view).toBe("tra-cuu");
  });

  it("requires a date before answering a point-in-time question", () => {
    const lookup = { ...fullState, view: "tra-cuu" as const };
    expect(isQueryable(lookup)).toBe(true);
    expect(isQueryable({ ...lookup, validAt: "" })).toBe(false);
    expect(isQueryable({ ...lookup, provisionId: "" })).toBe(false);
    expect(isQueryable({ ...lookup, datasetReleaseId: "" })).toBe(false);
  });

  it("requires two versions before answering a comparison", () => {
    expect(isQueryable(fullState)).toBe(true);
    expect(isQueryable({ ...fullState, fromVersionId: "" })).toBe(false);
    expect(isQueryable({ ...fullState, toVersionId: "" })).toBe(false);
  });

  it("needs only a provision to answer an amendment history question", () => {
    const history = {
      ...fullState,
      fromVersionId: "",
      toVersionId: "",
      validAt: "",
      view: "luoc-su" as const,
    };
    expect(isQueryable(history)).toBe(true);
    expect(isQueryable({ ...history, provisionId: "" })).toBe(false);
  });

  it("survives a value that needs escaping", () => {
    const awkward: TimeMachineState = { ...fullState, provisionId: "prov_vbpl_a b&c" };
    expect(parseTimeMachineState(toSearchString(awkward))).toEqual(awkward);
  });
});
