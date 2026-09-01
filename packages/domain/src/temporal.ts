declare const legalDateBrand: unique symbol;
declare const isoInstantBrand: unique symbol;

export type LegalDate = string & { readonly [legalDateBrand]: "LegalDate" };
export type IsoInstant = string & { readonly [isoInstantBrand]: "IsoInstant" };

const legalDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function parseLegalDate(value: string): LegalDate {
  const match = legalDatePattern.exec(value);
  if (match === null) {
    throw new TypeError("LegalDate must use YYYY-MM-DD");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new TypeError("LegalDate must be a real calendar date");
  }

  return value as LegalDate;
}

export function parseIsoInstant(value: string): IsoInstant {
  const candidate = new Date(value);
  if (Number.isNaN(candidate.getTime()) || candidate.toISOString() !== value) {
    throw new TypeError("IsoInstant must be a canonical UTC ISO-8601 instant");
  }

  return value as IsoInstant;
}

export interface HalfOpenInterval<Value extends string> {
  readonly from: Value;
  readonly to: Value | null;
}

export function contains<Value extends string>(
  interval: HalfOpenInterval<Value>,
  point: Value,
): boolean {
  return point >= interval.from && (interval.to === null || point < interval.to);
}

export function assertValidInterval<Value extends string>(
  interval: HalfOpenInterval<Value>,
  field: string,
): void {
  if (interval.to !== null && interval.from >= interval.to) {
    throw new RangeError(`${field} must be a non-empty [from, to) interval`);
  }
}
