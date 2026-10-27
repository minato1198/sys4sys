"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "Ports", adminOnly: false },
  { href: "/services", label: "Services", adminOnly: false },
  { href: "/logs", label: "Logs", adminOnly: false },
  { href: "/incidents", label: "Incidents", adminOnly: false },
  { href: "/reports", label: "Reports", adminOnly: false },
  { href: "/approvals", label: "Approvals", adminOnly: false },
  { href: "/hosts", label: "Hosts", adminOnly: false },
  { href: "/admin/users", label: "Users", adminOnly: true },
  { href: "/audit", label: "Audit", adminOnly: true },
  { href: "/settings", label: "Settings", adminOnly: true },
] as const;

export function NavLinks({ role }: { role?: string | null }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-surface/60 p-1 text-xs">
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
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-md px-2.5 py-1.5 transition sm:min-h-9 ${
                active
                  ? "bg-surface-muted text-fg"
                  : "text-fg-muted hover:text-fg"
              }`}
            >
              {link.label}
            </Link>
          );
        },
      )}
      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
      <ThemeToggle />
    </nav>
  );
}
