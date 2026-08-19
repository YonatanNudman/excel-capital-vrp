const DAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

/**
 * Which days a daily schedule may collect on. Only meaningful for the "daily"
 * frequency; the server ignores it otherwise.
 *
 * Ticking nothing means every day, which is stated on screen so it never has to
 * be guessed. Plain checkboxes rather than client state, so this stays a server
 * component and submits with the surrounding form.
 */
export function WeekdayPicker({ selected }: { selected: number[] | null }) {
  const chosen = new Set(selected ?? []);
  return (
    <fieldset className="block">
      <legend className="text-sm font-medium text-slate-700">
        Which day(s) can we collect on?
      </legend>
      <p className="mt-0.5 text-xs text-slate-500">
      For <strong>Daily</strong>: tick every day you want, or tick nothing to collect every day including weekends.
      </p>
      <p className="mt-0.5 text-xs text-slate-500">
      For <strong>Weekly</strong> or{" "} <strong>Fortnightly</strong>: tick the one day you want, for example Tuesday.
      </p>
      <p className="mt-0.5 text-xs text-slate-500">
      Leave it blank and the day is taken from the start date instead.
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        {DAYS.map((d) => (
          <label
            key={d.value}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
          >
            <input
              type="checkbox"
              name="daysOfWeek"
              value={d.value}
              defaultChecked={chosen.has(d.value)}
              className="h-4 w-4"
            />
            {d.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
