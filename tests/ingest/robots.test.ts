import { isPathAllowed, parseRobots } from "@luatvn/ingest";
import { describe, expect, it } from "vitest";

const fixtureRobots = parseRobots(
  [
    "User-agent: *",
    "Disallow: /private/",
    "Allow: /private/open",
    "Disallow: /*.pdf$",
    "",
    "User-agent: blockedbot",
    "Disallow: /",
  ].join("\n"),
);

describe("robots rules", () => {
  it("allows paths with no matching rule", () => {
    expect(isPathAllowed(fixtureRobots, "LuatVN-ingest/0.1", "/doc.txt")).toBe(true);
  });

  it("disallows a matching prefix", () => {
    expect(isPathAllowed(fixtureRobots, "LuatVN-ingest/0.1", "/private/doc.txt")).toBe(false);
  });

  it("lets the longer allow rule win over a shorter disallow", () => {
    expect(isPathAllowed(fixtureRobots, "LuatVN-ingest/0.1", "/private/open/doc.txt")).toBe(true);
  });

  it("honors the trailing anchor in patterns", () => {
    expect(isPathAllowed(fixtureRobots, "LuatVN-ingest/0.1", "/files/law.pdf")).toBe(false);
    expect(isPathAllowed(fixtureRobots, "LuatVN-ingest/0.1", "/files/law.pdfx")).toBe(true);
  });

  it("applies the specific user-agent group instead of the wildcard", () => {
    expect(isPathAllowed(fixtureRobots, "blockedbot/2.0", "/doc.txt")).toBe(false);
  });

  it("allows everything when no group exists", () => {
    expect(isPathAllowed(parseRobots(""), "LuatVN-ingest/0.1", "/anywhere")).toBe(true);
  });
});
