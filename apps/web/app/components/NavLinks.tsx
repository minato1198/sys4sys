"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Ports", adminOnly: false },
  { href: "/services", label: "Services", adminOnly: false },
  { href: "/logs", label: "Logs", adminOnly: false },
  { href: "/hosts", label: "Hosts", adminOnly: false },
  { href: "/admin/users", label: "Users", adminOnly: true },
] as const;

export function NavLinks({ role }: { role?: string | null }) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-900/60 p-1 text-xs">
      {LINKS.filter((link) => !link.adminOnly || role === "admin").map(
        (link) => {
          const active =
            link.href === "/"
              ? pathname === "/"
              : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-2.5 py-1 transition ${
                active
                  ? "bg-ink-800 text-white"
                  : "text-mist-400 hover:text-white"
              }`}
            >
              {link.label}
            </Link>
          );
        },
      )}
    </nav>
  );
}
