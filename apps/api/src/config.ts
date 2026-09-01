import { z } from "zod";

const portTextSchema = z
  .string()
  .regex(/^\d{1,5}$/u, "must be a base-10 integer")
  .transform(Number)
  .refine((value) => value >= 0 && value <= 65_535, "must be between 0 and 65535");

const timeoutTextSchema = z
  .string()
  .regex(/^\d{1,6}$/u, "must be a base-10 integer")
  .transform(Number)
  .refine((value) => value >= 100 && value <= 600_000, "must be between 100 and 600000");

const hostAllowlistTextSchema = z
  .string()
  .min(1)
  .max(1_024)
  .transform((value) => value.split(",").map((host) => host.trim().toLowerCase()))
  .refine(
    (hosts) => hosts.length <= 16 && hosts.every((host) => /^[a-z0-9.-]{1,255}$/u.test(host)),
    "must be up to 16 comma-separated host names",
  );

const environmentSchema = z.object({
  LUATVN_DATA_DIR: z.string().min(1).max(1_024).optional(),
  LUATVN_HOST: z.string().min(1).max(255).optional(),
  LUATVN_OPERATION_TIMEOUT_MS: timeoutTextSchema.optional(),
  LUATVN_PORT: portTextSchema.optional(),
  LUATVN_SHUTDOWN_TIMEOUT_MS: timeoutTextSchema.optional(),
  LUATVN_SOURCE_HOST_ALLOWLIST: hostAllowlistTextSchema.optional(),
});

export interface RuntimeConfig {
  readonly dataDirectory: string;
  readonly host: string;
  readonly operationTimeoutMs: number;
  readonly port: number;
  readonly shutdownTimeoutMs: number;
  // Replaces the registered source hosts (SR-003) when set. Drill/test use only;
  // startup logs an explicit event so the override is observable.
  readonly sourceHostAllowlist: readonly string[] | null;
}

export class RuntimeConfigError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Runtime configuration is invalid: ${issues.join("; ")}`);
    this.name = "RuntimeConfigError";
  }
}

export function readRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeConfig {
  const parsed = environmentSchema.safeParse({
    LUATVN_DATA_DIR: environment["LUATVN_DATA_DIR"],
    LUATVN_HOST: environment["LUATVN_HOST"],
    LUATVN_OPERATION_TIMEOUT_MS: environment["LUATVN_OPERATION_TIMEOUT_MS"],
    LUATVN_PORT: environment["LUATVN_PORT"],
    LUATVN_SHUTDOWN_TIMEOUT_MS: environment["LUATVN_SHUTDOWN_TIMEOUT_MS"],
    LUATVN_SOURCE_HOST_ALLOWLIST: environment["LUATVN_SOURCE_HOST_ALLOWLIST"],
  });
  if (!parsed.success) {
    throw new RuntimeConfigError(
      parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`),
    );
  }

  return {
    dataDirectory: parsed.data.LUATVN_DATA_DIR ?? "data/manual",
    host: parsed.data.LUATVN_HOST ?? "127.0.0.1",
    operationTimeoutMs: parsed.data.LUATVN_OPERATION_TIMEOUT_MS ?? 10_000,
    port: parsed.data.LUATVN_PORT ?? 3_000,
    shutdownTimeoutMs: parsed.data.LUATVN_SHUTDOWN_TIMEOUT_MS ?? 10_000,
    sourceHostAllowlist: parsed.data.LUATVN_SOURCE_HOST_ALLOWLIST ?? null,
  };
}
