"use client";

/** One collectable account, flattened for the client. */
export interface DestinationChoice {
  consentId: string;
  label: string;
  isDefault: boolean;
  /** Masked account, e.g. "••••4321 / ••-••-56", to confirm the right account. */
  masked: string;
}

/**
 * Choose which bank account a collection pays into.
 *
 * Renders NOTHING when there is only one account, which is most borrowers. A
 * dropdown with a single option is pure noise, and this feature must not make the
 * ordinary case harder to use than it was before.
 *
 * Choosing an account here means choosing which mandate to collect against: the
 * money is never rerouted after the borrower approved it, so the destination
 * shown is genuinely where it lands.
 */
export function DestinationPicker({
  destinations,
  name = "destinationConsentId",
}: {
  destinations: DestinationChoice[];
  name?: string;
}) {
  if (destinations.length <= 1) return null;

  const preselected = destinations.find((d) => d.isDefault) ?? destinations[0];

  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-700">Pay into</span>
      <select
        name={name}
        defaultValue={preselected.consentId}
        className="mt-1 block rounded-md border border-slate-300 px-3 py-1.5 text-sm"
      >
        {destinations.map((d) => (
          <option key={d.consentId} value={d.consentId}>
            {d.label} ({d.masked}){d.isDefault ? " — default" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
