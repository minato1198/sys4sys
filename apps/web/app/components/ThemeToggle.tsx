"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "sys4sys.theme";

type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function SunIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="size-3.5"
    >
      <circle cx="10" cy="10" r="3.25" />
      <path d="M10 1.75v2M10 16.25v2M1.75 10h2M16.25 10h2M4.17 4.17l1.42 1.42M14.41 14.41l1.42 1.42M15.83 4.17l-1.42 1.42M5.59 14.41l-1.42 1.42" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="M16.5 12.4A6.5 6.5 0 0 1 7.6 3.5a6.5 6.5 0 1 0 8.9 8.9Z" />
    </svg>
  );
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(currentTheme());

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handleSystemChange = () => {
      try {
        if (window.localStorage.getItem(STORAGE_KEY)) return;
      } catch {
        return;
      }
      const next = media.matches ? "light" : "dark";
      applyTheme(next);
      setTheme(next);
    };

    media.addEventListener("change", handleSystemChange);
    return () => media.removeEventListener("change", handleSystemChange);
  }, []);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    applyTheme(next);
    setTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // テーマの保存に失敗しても、このページ内の表示は切り替える。
    }
  }

  const isLight = theme === "light";
  const actionLabel = isLight
    ? "ダークモードに切り替え"
    : "ライトモードに切り替え";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={actionLabel}
      title={actionLabel}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-surface-muted/70 px-2.5 py-1.5 text-xs font-medium text-fg-muted transition hover:border-accent/40 hover:text-fg sm:min-h-9 ${className}`}
    >
      {isLight ? <SunIcon /> : <MoonIcon />}
      <span>{isLight ? "Light" : "Dark"}</span>
    </button>
  );
}
