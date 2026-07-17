"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/borrowers", label: "Borrowers" },
  { href: "/payments", label: "Payments" },
  { href: "/audit", label: "Audit" },
  { href: "/settings", label: "Settings", adminOnly: true },
];

export function Nav({ role }: { role: "admin" | "operator" | "viewer" }) {
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
          </Link>
        );
      })}
    </nav>
  );
}
