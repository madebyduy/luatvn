import { parseIsoInstant, parseLegalDate } from "@luatvn/domain";
import { z } from "zod";

export const maximumIdentifierLength = 128;

export function issueMessageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function domainValue<Value>(parse: (value: string) => Value, maximumLength: number) {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .transform((value, ctx) => {
      try {
        return parse(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: issueMessageFrom(error, "Value violates a domain rule"),
        });
        return z.NEVER;
      }
    });
}

export const legalDateSchema = domainValue(parseLegalDate, 10);
export const isoInstantSchema = domainValue(parseIsoInstant, 32);

export const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "SHA-256 must be 64 lowercase hex characters");

export const officialSourceUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Official source URL must be a valid https URL");
