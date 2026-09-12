/**
 * CSV header -> field resolution for lead imports.
 *
 * Matching is exact-normalized first (aliases in priority order), then a constrained
 * substring fallback for third-party exports that prefix their headers
 * (e.g. "Contact Full Name").
 *
 * The previous inline implementation matched by substring in file order only. Because
 * "first name".includes("name") is true, importing this app's own export
 * (`ID, First Name, Last Name, Full Name, ...`) resolved Full Name to the *first* name
 * and every imported record silently lost its surname.
 *
 * Headers are claimed on first use, so a generic alias can never steal a column that
 * another field already owns.
 */

export type CsvRow = Record<string, string>;

/** Minimum normalized alias length eligible for the substring fallback. */
const SUBSTRING_FALLBACK_MIN_ALIAS_LENGTH = 8;

const normalizeHeaderKey = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Builds a field reader bound to one CSV row.
 *
 * Resolve fields from most specific to least specific: a field resolved earlier claims
 * its header, so callers should read narrow fields (first/last name, company, title,
 * email, ...) before broad ones (full name).
 */
export function createCsvFieldReader(
  row: CsvRow,
): (aliases: readonly string[]) => string {
  const headerIndex = Object.keys(row).map((raw) => ({
    raw,
    norm: normalizeHeaderKey(raw),
  }));
  const claimedHeaders = new Set<string>();

  const read = (hit: { raw: string } | undefined): string => {
    if (!hit) return "";
    const value = String(row[hit.raw] ?? "").trim();
    if (value) claimedHeaders.add(hit.raw);
    return value;
  };

  return (aliases: readonly string[]): string => {
    // 1. Exact normalized match, aliases in priority order.
    for (const alias of aliases) {
      const target = normalizeHeaderKey(alias);
      const hit = headerIndex.find(
        (h) => h.norm === target && !claimedHeaders.has(h.raw),
      );
      const value = read(hit);
      if (value) return value;
    }

    // 2. Substring fallback, restricted to specific aliases so that a generic alias
    //    like "name" cannot capture "Company Name" or an already-claimed "First Name".
    for (const alias of aliases) {
      const target = normalizeHeaderKey(alias);
      if (target.length < SUBSTRING_FALLBACK_MIN_ALIAS_LENGTH) continue;
      const hit = headerIndex.find(
        (h) =>
          !claimedHeaders.has(h.raw) &&
          h.norm !== target &&
          h.norm.includes(target),
      );
      const value = read(hit);
      if (value) return value;
    }

    return "";
  };
}

/** Alias groups shared by import and round-trip tests, ordered most specific first. */
export const CSV_FIELD_ALIASES = {
  firstName: [
    "first name",
    "firstname",
    "first",
    "given name",
    "fname",
    "fn",
  ],
  lastName: ["last name", "lastname", "last", "surname", "family name", "lname", "ln"],
  fullName: [
    "full name",
    "fullname",
    "name",
    "contact name",
    "contactname",
    "display name",
    "displayname",
  ],
  company: [
    "current company",
    "company name",
    "companyname",
    "company",
    "employer",
    "organization",
    "organisation",
    "org",
    "account",
  ],
  title: [
    "current title",
    "primary title",
    "job title",
    "jobtitle",
    "title",
    "role",
    "position",
    "headline",
  ],
  email: ["corporate email", "email address", "emailaddress", "email", "e-mail", "mail"],
  phone: [
    "phone number",
    "phonenumber",
    "phone",
    "mobile number",
    "mobilenumber",
    "mobile",
    "telephone",
    "tel",
  ],
  linkedin: [
    "linkedin profile url",
    "linkedin url",
    "linkedinurl",
    "linkedin",
    "profile url",
    "profileurl",
    "url",
  ],
  industry: ["industry segment", "industry", "sector"],
  location: ["geographic location", "location", "country", "city"],
  summary: ["biography summary", "summary", "bio", "notes"],
  skills: ["skills keywords", "skills", "tags"],
  reviewStatus: ["review status", "reviewstatus"],
  nextAction: ["next action", "nextaction"],
} as const;
