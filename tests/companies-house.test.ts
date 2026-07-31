/* eslint-disable @typescript-eslint/no-unused-vars -- fetch stub needs the params for typing */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CompaniesHouseClient,
  isCompaniesHouseConfigured,
  isLendableStatus,
} from "@/lib/companies-house";

/**
 * Field names verified against the Companies House Public Data API docs:
 * search items use `title`, the company profile uses `company_name`. Getting
 * that wrong is invisible until a real call, which is how the Plaid consent
 * field bug reached staging, so it is pinned here.
 */

const client = new CompaniesHouseClient({ apiKey: "test-key" });

function stubFetch(body: unknown, status = 200) {
  const spy = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", spy);
  return {
    url: () => String(spy.mock.calls[0][0]),
    init: () => spy.mock.calls[0][1]!,
    calls: () => spy.mock.calls.length,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("search", () => {
  const results = {
    items: [
      {
        company_number: "15976056",
        title: "SUSSEX ROAD INVESTMENTS LIMITED",
        company_status: "active",
        company_type: "ltd",
        date_of_creation: "2025-01-14",
        address_snippet: "1 Sussex Road, London, N1 1AA",
      },
    ],
  };

  it("maps search items using `title`, the search field name", async () => {
    stubFetch(results);
    const found = await client.search("sussex road");
    expect(found).toEqual([
      {
        companyNumber: "15976056",
        name: "SUSSEX ROAD INVESTMENTS LIMITED",
        status: "active",
        type: "ltd",
        incorporatedOn: "2025-01-14",
        address: "1 Sussex Road, London, N1 1AA",
      },
    ]);
  });

  it("calls the documented search endpoint with the query", async () => {
    const cap = stubFetch(results);
    await client.search("sussex road");
    const url = new URL(cap.url());
    expect(url.origin + url.pathname).toBe(
      "https://api.company-information.service.gov.uk/search/companies",
    );
    expect(url.searchParams.get("q")).toBe("sussex road");
  });

  it("authenticates with the API key as the HTTP Basic username", async () => {
    const cap = stubFetch(results);
    await client.search("x");
    const auth = new Headers(cap.init().headers).get("authorization") ?? "";
    expect(auth.startsWith("Basic ")).toBe(true);
    // Companies House expects "apiKey:" with an empty password.
    expect(atob(auth.slice("Basic ".length))).toBe("test-key:");
  });

  it("returns nothing for a blank query without calling the API", async () => {
    const cap = stubFetch(results);
    expect(await client.search("   ")).toEqual([]);
    expect(cap.calls()).toBe(0);
  });

  it("tolerates a response with no items", async () => {
    stubFetch({});
    expect(await client.search("nothing")).toEqual([]);
  });

  it("skips items missing a company number or name", async () => {
    stubFetch({
      items: [
        { title: "NO NUMBER LTD", company_status: "active" },
        { company_number: "123", company_status: "active" },
        { ...results.items[0] },
      ],
    });
    const found = await client.search("x");
    expect(found).toHaveLength(1);
    expect(found[0].companyNumber).toBe("15976056");
  });
});

describe("getCompany", () => {
  const profile = {
    company_name: "RIVERSIDE CAFE LTD",
    company_number: "12345678",
    company_status: "active",
    type: "ltd",
    date_of_creation: "2020-06-01",
  };

  it("maps the profile using `company_name`, not `title`", async () => {
    stubFetch(profile);
    const c = await client.getCompany("12345678");
    expect(c).toMatchObject({
      companyNumber: "12345678",
      name: "RIVERSIDE CAFE LTD",
      status: "active",
      incorporatedOn: "2020-06-01",
    });
  });

  it("normalises the company number in the path", async () => {
    const cap = stubFetch(profile);
    await client.getCompany(" 1234 5678 ");
    expect(cap.url()).toBe(
      "https://api.company-information.service.gov.uk/company/12345678",
    );
  });

  it("returns null for a company that is not on the register", async () => {
    stubFetch({ errors: [{ error: "company-profile-not-found" }] }, 404);
    expect(await client.getCompany("99999999")).toBeNull();
  });

  it("throws on an authentication failure rather than pretending nothing exists", async () => {
    stubFetch({ error: "Invalid Authorization" }, 401);
    await expect(client.getCompany("12345678")).rejects.toThrow(/Companies House/i);
  });

  it("throws when rate limited", async () => {
    stubFetch({}, 429);
    await expect(client.getCompany("12345678")).rejects.toThrow(/Companies House/i);
  });
});

describe("isCompaniesHouseConfigured", () => {
  it("is false without a key, so the app can degrade to manual entry", () => {
    expect(isCompaniesHouseConfigured({})).toBe(false);
    expect(isCompaniesHouseConfigured({ COMPANIES_HOUSE_API_KEY: "  " })).toBe(false);
  });

  it("is true with a key", () => {
    expect(isCompaniesHouseConfigured({ COMPANIES_HOUSE_API_KEY: "k" })).toBe(true);
  });
});

describe("isLendableStatus", () => {
  it("accepts an active company", () => {
    expect(isLendableStatus("active")).toBe(true);
  });

  it("rejects companies that should not be taking on new debt", () => {
    for (const status of [
      "dissolved",
      "liquidation",
      "receivership",
      "administration",
      "insolvency-proceedings",
      "removed",
      "closed",
      "converted-closed",
    ]) {
      expect(isLendableStatus(status)).toBe(false);
    }
  });

  it("rejects an unknown or missing status rather than assuming it is fine", () => {
    expect(isLendableStatus(undefined)).toBe(false);
    expect(isLendableStatus("something-new")).toBe(false);
  });
});
