import { readRuntimeConfig, RuntimeConfigError } from "@luatvn/api";
import { describe, expect, it } from "vitest";

function expectConfigRejected(environment: Readonly<Record<string, string | undefined>>): void {
  expect(() => readRuntimeConfig(environment)).toThrowError(RuntimeConfigError);
}

describe("readRuntimeConfig", () => {
  it("applies documented defaults when the environment is empty", () => {
    const config = readRuntimeConfig({});
    expect(config).toEqual({
      dataDirectory: "data/manual",
      host: "127.0.0.1",
      operationTimeoutMs: 10_000,
      port: 3_000,
      shutdownTimeoutMs: 10_000,
      sourceHostAllowlist: null,
    });
  });

  it("accepts explicit values including an ephemeral port", () => {
    const config = readRuntimeConfig({
      LUATVN_DATA_DIR: "tmp/synthetic-data",
      LUATVN_OPERATION_TIMEOUT_MS: "2500",
      LUATVN_PORT: "0",
      LUATVN_SOURCE_HOST_ALLOWLIST: "Drill.Invalid, second.invalid",
    });
    expect(config.dataDirectory).toBe("tmp/synthetic-data");
    expect(config.operationTimeoutMs).toBe(2_500);
    expect(config.port).toBe(0);
    expect(config.sourceHostAllowlist).toEqual(["drill.invalid", "second.invalid"]);
  });

  it("fails closed on an out-of-range port", () => {
    expectConfigRejected({ LUATVN_PORT: "70000" });
  });

  it("fails closed on a non-numeric port", () => {
    expectConfigRejected({ LUATVN_PORT: "http" });
  });

  it("fails closed on a timeout below the minimum", () => {
    expectConfigRejected({ LUATVN_OPERATION_TIMEOUT_MS: "50" });
  });

  it("fails closed on a malformed host allowlist", () => {
    expectConfigRejected({ LUATVN_SOURCE_HOST_ALLOWLIST: "bad host name" });
  });
});
