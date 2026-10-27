"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  href: string;
  label: string;
  adminOnly?: boolean;
}

interface NavGroup {
  title: string;
  key: string;
  links: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "ポート監視",
    key: "monitor",
    links: [
      { href: "/", label: "ポート" },
      { href: "/services", label: "サービス" },
      { href: "/logs", label: "ログ" },
      { href: "/incidents", label: "インシデント" },
    ],
  },
  {
    title: "運用",
    key: "operate",
    links: [
      { href: "/reports", label: "レポート" },
      { href: "/approvals", label: "承認" },
      { href: "/hosts", label: "ホスト" },
    ],
  },
  {
    title: "管理",
    key: "admin",
    links: [
      { href: "/admin/users", label: "ユーザー", adminOnly: true },
      { href: "/audit", label: "監査ログ", adminOnly: true },
      { href: "/settings", label: "設定", adminOnly: true },
    ],
  },
];

function AppBrandMark() {
  return (
    <Link
      href="/"
      aria-label="sys4sys ホーム"
      className="inline-flex min-h-11 items-center rounded-lg px-1 transition hover:opacity-80"
    >
      <BrandMark compact />
    </Link>
  );
}

function NavLink({
  link,
  active,
  onNavigate,
}: {
  link: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={`inline-flex min-h-11 items-center justify-between rounded-md border px-3 text-sm transition ${
        active
          ? "border-accent/30 bg-accent/10 text-accent"
          : "border-border bg-surface text-fg hover:border-accent/30 hover:bg-accent/10 hover:text-accent"
      }`}
    >
      {link.label}
    </Link>
  );
}

function SidebarNav({
  role,
  onNavigate,
}: {
  role?: string | null;
  onNavigate: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-4">
      {NAV_GROUPS.map((group) => {
        const links = group.links.filter(
          (link) => !link.adminOnly || role === "admin",
        );
        if (links.length === 0) return null;

        return (
          <section key={group.key} aria-labelledby={`nav-group-${group.key}`}>
            <h2
              id={`nav-group-${group.key}`}
              className="flex items-center gap-2 px-3 text-sm font-semibold text-fg"
            >
              <span>{group.title}</span>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
            </h2>
            <nav
              aria-label={group.title}
              className="mt-2 ml-3 flex flex-col gap-1"
            >
              {links.map((link) => {
                const active =
                  link.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(link.href);
                return (
                  <NavLink
                    key={link.href}
                    link={link}
                    active={active}
                    onNavigate={onNavigate}
                  />
                );
              })}
            </nav>
          </section>
        );
      })}
    </div>
  );
}

export function AppShell({
  title,
  description,
  user,
  actions,
  children,
}: {
  title: string;
  description?: string;
  user: { role?: string | null; email?: string | null } | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobileNav = useCallback(() => setMobileOpen(false), []);

  useEffect(() => {
    if (!mobileOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const role = user?.role ?? null;
  const email = user?.email ?? "認証確認中…";

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <a
        href="#main"
        className="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium text-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-accent"
      >
        本文へ
      </a>

      <aside
        className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface-muted/70 px-4 py-5 lg:flex"
        aria-label="メインナビゲーション"
      >
        <AppBrandMark />
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto">
          <SidebarNav role={role} onNavigate={closeMobileNav} />
        </div>
        <p className="mt-6 border-t border-border pt-4 text-xs leading-relaxed text-fg-muted">
          Windows / WSL のポートとプロセスを、同じ台帳で確認します。
        </p>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="メニューを閉じる"
            onClick={closeMobileNav}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <aside
            id="app-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="メインナビゲーション"
            className="relative h-dvh w-[min(88vw,18rem)] overflow-y-auto border-r border-border bg-surface px-4 py-5"
          >
            <div className="flex items-start justify-between gap-3">
              <AppBrandMark />
              <button
                type="button"
                onClick={closeMobileNav}
                className="min-h-11 rounded-md border border-border px-3 text-sm font-medium text-fg-muted transition hover:text-fg"
              >
                閉じる
              </button>
            </div>
            <div className="mt-6">
              <SidebarNav role={role} onNavigate={closeMobileNav} />
            </div>
          </aside>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b border-border bg-bg/92 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileOpen((current) => !current)}
                aria-controls="app-drawer"
                aria-expanded={mobileOpen}
                className="min-h-11 rounded-md border border-border px-3 text-sm font-medium text-fg transition hover:bg-surface-muted lg:hidden"
              >
                メニュー
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold tracking-tight text-fg">
                  {title}
                </h1>
                {description ? (
                  <p className="truncate text-sm text-fg-muted">
                    {description}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {actions ? (
                <div className="flex items-center gap-2">{actions}</div>
              ) : null}
              <div className="hidden items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 md:flex">
                <div className="text-right">
                  <div className="max-w-[18rem] truncate text-sm text-fg">
                    {email}
                  </div>
                  <div className="text-xs text-fg-muted">{role ?? ""}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="min-h-11 rounded-md border border-border px-2.5 text-sm text-fg-muted transition hover:border-danger/40 hover:text-danger"
                >
                  ログアウト
                </button>
              </div>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
