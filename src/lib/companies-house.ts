/**
 * Companies House Public Data API client.
 *
 * Used to look up real registered companies when onboarding a borrower, so a
 * company number is never a typo and the legal name matches the register.
 *
 * Field names differ between the two endpoints and are easy to get wrong:
 * search items carry `title`, the company profile carries `company_name`. Both
 * are pinned by tests/companies-house.test.ts.
 *
 * Auth is HTTP Basic with the API key as the username and an empty password.
 * The key is a Worker secret and never reaches the browser; the UI talks to our
 * own /api/companies/search route instead.
 */

const BASE_URL = "https://api.company-information.service.gov.uk";

/** Statuses where taking on new lending would be a red flag. */
const LENDABLE_STATUSES = new Set(["active"]);

export interface CompanyMatch {
  companyNumber: string;
  name: string;
  status: string | null;
  type: string | null;
  incorporatedOn: string | null;
  /** Registered office, formatted for display. Search returns a snippet. */
  address: string | null;
  /** Only available from the company profile, not from search results. */
  postcode?: string | null;
}

/**
 * The registered office as one display line, in postal order.
 *
 * Field names per the Companies House registeredOfficeAddress resource. Absent
 * or blank parts are dropped so the result never contains empty gaps.
 */
function formatRegisteredAddress(raw: unknown): { address: string | null; postcode: string | null } {
  if (!raw || typeof raw !== "object") return { address: null, postcode: null };
  const a = raw as Record<string, unknown>;
  const parts = [
    "premises",
    "address_line_1",
    "address_line_2",
    "locality",
    "region",
    "postal_code",
    "country",
  ]
    .map((key) => readString(a, key))
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim());
  return {
    address: parts.length > 0 ? parts.join(", ") : null,
    postcode: readString(a, "postal_code"),
  };
}

export class CompaniesHouseError extends Error {
  constructor(
    message: string,
    public httpStatus?: number,
  ) {
    super(`Companies House: ${message}`);
  }
}

export function isCompaniesHouseConfigured(env: {
  COMPANIES_HOUSE_API_KEY?: string;
}): boolean {
  return Boolean(env.COMPANIES_HOUSE_API_KEY?.trim());
}

/**
 * Whether a company in this state should be able to take on a new repayment
 * mandate. Anything unrecognised is treated as NOT lendable, so a status the
 * register adds later fails closed instead of slipping through.
 */
export function isLendableStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return LENDABLE_STATUSES.has(status);
}

function readString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v : null;
}

export class CompaniesHouseClient {
  constructor(private cfg: { apiKey: string }) {}

  private async call(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: {
          // Empty password, hence the trailing colon.
          authorization: `Basic ${btoa(`${this.cfg.apiKey}:`)}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new CompaniesHouseError(
        error instanceof Error ? error.message : String(error),
      );
    }

    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      // A 404 with an empty body is normal; other statuses are handled below.
    }
    return { status: res.status, body };
  }

  /** Free-text search by company name or number. Empty query returns nothing. */
  async search(query: string, limit = 10): Promise<CompanyMatch[]> {
    const q = query.trim();
    if (!q) return [];

    const params = new URLSearchParams({ q, items_per_page: String(limit) });
    const { status, body } = await this.call(`/search/companies?${params}`);
    if (status !== 200) {
      throw new CompaniesHouseError(`search failed with HTTP ${status}`, status);
    }

    const items = Array.isArray(body.items) ? body.items : [];
    const out: CompanyMatch[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const companyNumber = readString(item, "company_number");
      // Search results name the company in `title`.
      const name = readString(item, "title");
      if (!companyNumber || !name) continue;
      out.push({
        companyNumber,
        name,
        status: readString(item, "company_status"),
        type: readString(item, "company_type"),
        incorporatedOn: readString(item, "date_of_creation"),
        address: readString(item, "address_snippet"),
      });
    }
    return out;
  }

  /** Look up one company by number. Returns null when it is not on the register. */
  async getCompany(companyNumber: string): Promise<CompanyMatch | null> {
    const number = companyNumber.replace(/\s+/g, "");
    if (!number) return null;

    const { status, body } = await this.call(`/company/${encodeURIComponent(number)}`);
    if (status === 404) return null;
    if (status !== 200) {
      throw new CompaniesHouseError(`lookup failed with HTTP ${status}`, status);
    }

    // The profile endpoint names the company in `company_name`.
    const name = readString(body, "company_name");
    const resolvedNumber = readString(body, "company_number") ?? number;
    if (!name) return null;

    const office = formatRegisteredAddress(body.registered_office_address);
    return {
      companyNumber: resolvedNumber,
      name,
      status: readString(body, "company_status"),
      type: readString(body, "type"),
      incorporatedOn: readString(body, "date_of_creation"),
      address: office.address,
      postcode: office.postcode,
    };
  }
}

export function getCompaniesHouseClient(env: {
  COMPANIES_HOUSE_API_KEY?: string;
}): CompaniesHouseClient | null {
  const apiKey = env.COMPANIES_HOUSE_API_KEY?.trim();
  return apiKey ? new CompaniesHouseClient({ apiKey }) : null;
}
