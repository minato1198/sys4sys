"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "../components/ThemeToggle";
import { StatusBanner } from "../components/ui/StatusBanner";

interface Problem {
  detail?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `ログインに失敗しました (${response.status})`,
        );
      }

      router.replace("/");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center px-4 py-10">
      <div className="fixed right-4 top-4 z-20">
        <ThemeToggle />
      </div>

      <div className="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-border bg-surface shadow-xl lg:grid-cols-[1.05fr_1fr]">
        <section className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-surface-muted p-8 lg:flex">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                "linear-gradient(to right, var(--color-border) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)",
              backgroundSize: "28px 28px",
            }}
          />

          <div className="relative flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-lg border border-accent/30 bg-accent/10">
              <span className="font-mono text-sm font-bold text-accent">
                s4s
              </span>
            </div>
            <div>
              <div className="text-lg font-semibold tracking-tight text-fg">
                sys4sys
              </div>
              <div className="text-sm text-fg-muted">
                Windows / WSL operations
              </div>
            </div>
          </div>

          <div className="relative">
            <p className="max-w-md text-3xl font-semibold leading-tight tracking-tight text-fg">
              待受ポートと予約を、
              <br />
              ひとつの画面で。
            </p>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-fg-muted">
              Windows と WSL
              のポート所有者、予約、競合を同じ台帳で確認できます。
            </p>

            <div className="mt-8 max-w-sm space-y-2 border-l-2 border-accent/40 pl-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-fg-muted">Windows</span>
                <span className="font-mono text-fg">TCP / UDP</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-fg-muted">WSL</span>
                <span className="font-mono text-fg">shared network</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-fg-muted">Reservations</span>
                <span className="font-mono text-fg">conflict check</span>
              </div>
            </div>
          </div>

          <p className="relative text-xs text-fg-muted">
            ローカル環境の運用コンソール
          </p>
        </section>

        <section className="p-6 sm:p-8">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <div className="grid size-9 place-items-center rounded-lg border border-accent/30 bg-accent/10">
              <span className="font-mono text-xs font-bold text-accent">
                s4s
              </span>
            </div>
            <div className="text-base font-semibold text-fg">sys4sys</div>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            サインイン
          </h1>
          <p className="mt-1 text-sm text-fg-muted">
            チームアカウントで続行します。
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-fg">
                メールアドレス
              </span>
              <input
                type="email"
                required
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@sys4sys.local"
                className="w-full rounded-md border border-border bg-bg/70 px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition focus:border-accent/60"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-fg">
                パスワード
              </span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-md border border-border bg-bg/70 px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition focus:border-accent/60"
              />
            </label>

            {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

            <button
              type="submit"
              disabled={submitting}
              className="min-h-11 w-full rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "サインイン中…" : "サインイン"}
            </button>
          </form>

          <p className="mt-6 border-t border-border pt-4 text-xs leading-relaxed text-fg-muted">
            管理者から受け取ったアカウントでサインインしてください。
          </p>
        </section>
      </div>
    </main>
  );
}
