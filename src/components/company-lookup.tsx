"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { CompanyMatch } from "@/lib/companies-house";

/**
 * Search Companies House and fill the legal name and company number from the
 * register, so an operator never types them by hand.
 *
 * Writes into the sibling legalName and companyNumber inputs rather than owning
 * them, which keeps the surrounding form a plain server-action form. Manual
 * typing still works, and this whole block hides itself when no API key is
 * configured.
 *
 * Results appear in a type-ahead dropdown as the operator types (debounced);
 * there is no Search button.
 */
export function CompanyLookup() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CompanyMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<CompanyMatch | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const skipSearchRef = useRef<string | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Debounced Companies House search. setState only runs inside the timeout
  // callback (or after await) so the effect body stays sync-setState-free.
  useEffect(() => {
    const trimmed = query.trim();

    if (skipSearchRef.current !== null && skipSearchRef.current === trimmed) {
      skipSearchRef.current = null;
      return;
    }

    const timer = setTimeout(() => {
      if (trimmed.length < 3) {
        setResults([]);
        setOpen(false);
        setMessage(null);
        setSearching(false);
        setHighlight(-1);
        return;
      }

      const controller = new AbortController();
      inFlightRef.current = controller;
      setSearching(true);
      setMessage(null);

      void (async () => {
        try {
          const res = await fetch(
            `/api/companies/search?q=${encodeURIComponent(trimmed)}`,
            { signal: controller.signal },
          );
          const body = (await res.json()) as {
            configured?: boolean;
            results?: CompanyMatch[];
            error?: string;
          };

          if (controller.signal.aborted) return;

          if (body.configured === false) {
            setUnavailable(true);
            return;
          }
          if (body.error) {
            setMessage(body.error);
            setResults([]);
            setOpen(false);
            setHighlight(-1);
            return;
          }

          const next = body.results ?? [];
          setResults(next);
          setOpen(next.length > 0);
          setHighlight(next.length > 0 ? 0 : -1);
          if (next.length === 0) {
            setMessage(
              "No companies found. Check the spelling, or type the details in by hand.",
            );
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setMessage(
            "Could not reach Companies House. You can type the details in by hand.",
          );
          setResults([]);
          setOpen(false);
          setHighlight(-1);
        } finally {
          if (!controller.signal.aborted) setSearching(false);
          if (inFlightRef.current === controller) inFlightRef.current = null;
        }
      })();
    }, 250);

    return () => {
      clearTimeout(timer);
      inFlightRef.current?.abort();
      inFlightRef.current = null;
    };
  }, [query]);

  // Close the dropdown when the operator clicks outside this block.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  function choose(match: CompanyMatch) {
    const form = document.querySelector("form");
    const name = form?.querySelector<HTMLInputElement>('[name="legalName"]');
    const number = form?.querySelector<HTMLInputElement>('[name="companyNumber"]');
    if (name) name.value = match.name;
    if (number) number.value = match.companyNumber;
    skipSearchRef.current = match.name.trim();
    setQuery(match.name);
    setChosen(match);
    setResults([]);
    setOpen(false);
    setMessage(null);
    setHighlight(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open || results.length === 0) return;
      setHighlight((h) => (h + 1) % results.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open || results.length === 0) return;
      setHighlight((h) => (h <= 0 ? results.length - 1 : h - 1));
      return;
    }
    if (e.key === "Enter") {
      // Do not submit the borrower form while navigating the combobox.
      e.preventDefault();
      if (open && highlight >= 0 && results[highlight]) {
        choose(results[highlight]);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  if (unavailable) return null;

  const activeOption =
    open && highlight >= 0 && results[highlight]
      ? `${listId}-opt-${results[highlight].companyNumber}`
      : undefined;

  return (
    <div
      ref={containerRef}
      className="relative col-span-2 rounded-md border border-slate-200 bg-slate-50 p-3"
    >
      <label className="block text-sm font-medium text-slate-700" htmlFor="ch-search">
        Find the company on Companies House
      </label>
      <p className="mt-0.5 text-xs text-slate-500">
        Search by name or company number. Picking a result fills in the official
        name and number, so they always match the register.
      </p>
      <div className="relative mt-2">
        <input
          id="ch-search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption}
          value={query}
          onChange={(e) => {
            setChosen(null);
            setQuery(e.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder="e.g. Riverside Cafe, or 12345678"
          autoComplete="off"
          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
        {searching && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
            Searching…
          </span>
        )}
        {open && results.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-md"
          >
            {results.map((r, i) => (
              <li
                key={r.companyNumber}
                id={`${listId}-opt-${r.companyNumber}`}
                role="option"
                aria-selected={i === highlight}
                className={`cursor-pointer px-3 py-2 ${
                  i === highlight ? "bg-slate-100" : "hover:bg-slate-50"
                }`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  // Keep focus on the input so the click is not lost to blur.
                  e.preventDefault();
                  choose(r);
                }}
              >
                <span className="block text-sm font-medium text-slate-900">{r.name}</span>
                <span className="block text-xs text-slate-500">
                  {r.companyNumber}
                  {r.status ? ` · ${r.status}` : ""}
                  {r.incorporatedOn ? ` · incorporated ${r.incorporatedOn}` : ""}
                </span>
                {r.address && (
                  <span className="block text-xs text-slate-400">{r.address}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {message && <p className="mt-2 text-xs text-slate-600">{message}</p>}

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
