export interface SellerShippingAddress {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface SellerParcel {
  weightOz: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
}

export type SellerParcelInput = {
  weightOz?: unknown;
  lengthIn?: unknown;
  widthIn?: unknown;
  heightIn?: unknown;
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_ADDRESS_PART_LENGTH = 256;
const MAX_WEIGHT_OZ = 1_000_000;
const MAX_DIMENSION_IN = 10_000;

function isSafePart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ADDRESS_PART_LENGTH &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function normalizeUsCountry(value: string): string | null {
  const country = value.trim().toUpperCase();
  return country === "US" || country === "USA" || country === "UNITED STATES"
    ? "US"
    : null;
}

function normalizeRequiredPart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return isSafePart(normalized) ? normalized : null;
}

function normalizeOptionalPart(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return isSafePart(normalized) ? normalized : null;
}

export function normalizeSellerShippingAddress(
  input: unknown
): SellerShippingAddress | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const value = input as Record<string, unknown>;
  const street1 = normalizeRequiredPart(value.street1);
  const city = normalizeRequiredPart(value.city);
  const state = normalizeRequiredPart(value.state);
  const postalCode = normalizeRequiredPart(value.postalCode);
  const countryValue = normalizeRequiredPart(value.country);
  const country = countryValue ? normalizeUsCountry(countryValue) : null;
  const name = normalizeOptionalPart(value.name);
  const company = normalizeOptionalPart(value.company);
  const street2 = normalizeOptionalPart(value.street2);
  const phone = normalizeOptionalPart(value.phone);
  const email = normalizeOptionalPart(value.email);

  if (
    !street1 ||
    !city ||
    !state ||
    !postalCode ||
    !country ||
    name === null ||
    company === null ||
    street2 === null ||
    phone === null ||
    email === null
  ) {
    return null;
  }

  return {
    ...(name ? { name } : {}),
    ...(company ? { company } : {}),
    street1,
    ...(street2 ? { street2 } : {}),
    city,
    state,
    postalCode,
    country,
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
  };
}

export function parseSellerOrderAddress(
  input: string
): SellerShippingAddress | null {
  if (!input || input.length > 1_024 || CONTROL_CHARACTERS.test(input)) {
    return null;
  }

  const parts = input.split(",").map((part) => part.trim());
  if ((parts.length !== 6 && parts.length !== 7) || !parts.every(isSafePart)) {
    return null;
  }

  const [name, street1] = parts;
  const hasStreet2 = parts.length === 7;
  const street2 = hasStreet2 ? parts[2] : undefined;
  const city = parts[hasStreet2 ? 3 : 2];
  const state = parts[hasStreet2 ? 4 : 3];
  const postalCode = parts[hasStreet2 ? 5 : 4];
  const country = normalizeUsCountry(parts[hasStreet2 ? 6 : 5] ?? "");

  if (!name || !street1 || !city || !state || !postalCode || !country) {
    return null;
  }

  return {
    name,
    street1,
    ...(street2 ? { street2 } : {}),
    city,
    state,
    postalCode,
    country,
  };
}

function parseOptionalPositiveNumber(
  value: unknown,
  maximum: number
): number | undefined | null {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed =
    typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : null;
}

export function normalizeSellerParcel(
  input: SellerParcelInput
): SellerParcel | null {
  const weightOz = parseOptionalPositiveNumber(input.weightOz, MAX_WEIGHT_OZ);
  const lengthIn = parseOptionalPositiveNumber(
    input.lengthIn,
    MAX_DIMENSION_IN
  );
  const widthIn = parseOptionalPositiveNumber(input.widthIn, MAX_DIMENSION_IN);
  const heightIn = parseOptionalPositiveNumber(
    input.heightIn,
    MAX_DIMENSION_IN
  );

  if (
    weightOz === undefined ||
    weightOz === null ||
    lengthIn === null ||
    widthIn === null ||
    heightIn === null
  ) {
    return null;
  }

  return {
    weightOz,
    ...(lengthIn !== undefined ? { lengthIn } : {}),
    ...(widthIn !== undefined ? { widthIn } : {}),
    ...(heightIn !== undefined ? { heightIn } : {}),
  };
}

export function isSafeShippingUrl(value: string): boolean {
  if (!value || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}
