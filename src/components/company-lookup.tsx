"use client";

import { useRef, useState } from "react";
import type { CompanyMatch } from "@/lib/companies-house";

/**
 * Search Companies House and fill the legal name and company number from the
 * register, so an operator never types them by hand.
 *
 * Writes into the sibling legalName and companyNumber inputs rather than owning
 * them, which keeps the surrounding form a plain server-action form. Manual
 * typing still works, and this whole block hides itself when no API key is
 * configured.
 */
export function CompanyLookup() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanyMatch[] | null>(null);
  const [chosen, setChosen] = useState<CompanyMatch | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const requestId = useRef(0);

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    const id = ++requestId.current;
    setSearching(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/companies/search?q=${encodeURIComponent(q)}`);
      const body = (await res.json()) as {
        configured?: boolean;
        results?: CompanyMatch[];
        error?: string;
      };
      // Ignore a slow reply that arrived after a newer search.
      if (id !== requestId.current) return;

      if (body.configured === false) {
        setUnavailable(true);
        return;
      }
      if (body.error) {
        setMessage(body.error);
        setResults([]);
        return;
      }
      setResults(body.results ?? []);
      if ((body.results ?? []).length === 0) {
        setMessage("No companies found. Check the spelling, or type the details in by hand.");
      }
    } catch {
      if (id === requestId.current) {
        setMessage("Could not reach Companies House. You can type the details in by hand.");
      }
    } finally {
      if (id === requestId.current) setSearching(false);
    }
  }

  function choose(match: CompanyMatch) {
    const form = document.querySelector("form");
    const name = form?.querySelector<HTMLInputElement>('[name="legalName"]');
    const number = form?.querySelector<HTMLInputElement>('[name="companyNumber"]');
    if (name) name.value = match.name;
    if (number) number.value = match.companyNumber;
    setChosen(match);
    setResults(null);
    setMessage(null);
  }

  if (unavailable) return null;

  return (
    <div className="col-span-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <label className="block text-sm font-medium text-slate-700" htmlFor="ch-search">
        Find the company on Companies House
      </label>
      <p className="mt-0.5 text-xs text-slate-500">
        Search by name or company number. Picking a result fills in the official
        name and number, so they always match the register.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          id="ch-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Do not submit the borrower form while searching.
              e.preventDefault();
              void runSearch();
            }
          }}
          placeholder="e.g. Riverside Cafe, or 12345678"
          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={searching || !query.trim()}
          className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      {message && <p className="mt-2 text-xs text-slate-600">{message}</p>}

      {results && results.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-200 overflow-hidden rounded-md border border-slate-200 bg-white">
          {results.map((r) => (
            <li key={r.companyNumber}>
              <button
                type="button"
                onClick={() => choose(r)}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-slate-50"
              >
                <span className="text-sm font-medium text-slate-900">{r.name}</span>
                <span className="text-xs text-slate-500">
                  {r.companyNumber}
                  {r.status ? ` · ${r.status}` : ""}
                  {r.incorporatedOn ? ` · incorporated ${r.incorporatedOn}` : ""}
                </span>
                {r.address && <span className="text-xs text-slate-400">{r.address}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {chosen && (
        <div
          role="status"
          className={`mt-2 rounded-md border p-2 text-xs ${
            chosen.status === "active"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          {chosen.status === "active" ? (
            <>Using {chosen.name} ({chosen.companyNumber}), active on the register.</>
          ) : (
            <>
              Careful: {chosen.name} ({chosen.companyNumber}) is
              {" "}
              {chosen.status ?? "in an unknown state"} on the register, not active.
              Check before lending to it.
            </>
          )}
        </div>
      )}
    </div>
  );
}
