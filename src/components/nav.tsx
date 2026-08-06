"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/borrowers", label: "Borrowers" },
  { href: "/payments", label: "Payments" },
  { href: "/audit", label: "Audit" },
  { href: "/staff", label: "Staff", adminOnly: true },
  { href: "/settings", label: "Settings", adminOnly: true },
];

export function Nav({
  role,
  pendingRequests = 0,
}: {
  role: "admin" | "operator" | "viewer";
  /** Shown as a badge on Staff so waiting people are noticed without an email. */
  pendingRequests?: number;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {LINKS.filter((l) => !l.adminOnly || role === "admin").map((l) => {
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            {l.label}
            {l.href === "/staff" && pendingRequests > 0 && (
              <span
                aria-label={`${pendingRequests} waiting for access`}
                className="ml-1.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-semibold text-white"
              >
                {pendingRequests}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
