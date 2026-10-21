"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

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
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-ink-700/70 bg-ink-900/60 shadow-2xl shadow-black/30 lg:grid-cols-[1.05fr_1fr]">
        <section className="hidden flex-col justify-between border-r border-ink-700/70 bg-ink-950/50 p-8 lg:flex">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-lg border border-signal-400/30 bg-signal-400/10">
              <span className="font-mono text-sm font-bold text-signal-400">
                s4s
              </span>
            </div>
            <div>
              <div className="text-lg font-semibold tracking-tight text-white">
                sys4sys
              </div>
              <div className="text-[11px] text-mist-400">
                backend operations console
              </div>
            </div>
          </div>

          <div>
            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white">
              ポート・ログ・監視を
              <br />
              ひとつの場所で。
            </h1>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-mist-400">
              Windows と WSL
              の待受ポートを横断表示。サービス監視、承認付き自動復旧、AI
              レポートまでを段階的に追加します。
            </p>
            <div className="mt-6 flex flex-wrap gap-2 text-[11px] text-mist-400">
              <span className="rounded-md border border-ink-700 bg-ink-800/60 px-2 py-1">
                Windows + WSL
              </span>
              <span className="rounded-md border border-ink-700 bg-ink-800/60 px-2 py-1">
                observe → approve → auto
              </span>
              <span className="rounded-md border border-ink-700 bg-ink-800/60 px-2 py-1">
                local-first AI
              </span>
            </div>
          </div>

          <p className="font-mono text-[10px] text-mist-400/70">
            M1 / authentication + port view
          </p>
        </section>

        <section className="p-6 sm:p-8">
          <div className="mb-6 lg:hidden">
            <div className="flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-lg border border-signal-400/30 bg-signal-400/10">
                <span className="font-mono text-xs font-bold text-signal-400">
                  s4s
                </span>
              </div>
              <div className="text-base font-semibold text-white">sys4sys</div>
            </div>
          </div>

          <h2 className="text-xl font-semibold tracking-tight text-white">
            サインイン
          </h2>
          <p className="mt-1 text-xs text-mist-400">
            チームアカウントでダッシュボードにアクセスします。
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-mist-400">
                Email
              </span>
              <input
                type="email"
                required
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@sys4sys.local"
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-3 py-2 text-sm text-white placeholder:text-mist-400/50 focus:border-signal-400/50 focus:outline-none focus:ring-2 focus:ring-signal-400/10"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.12em] text-mist-400">
                Password
              </span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-3 py-2 text-sm text-white placeholder:text-mist-400/50 focus:border-signal-400/50 focus:outline-none focus:ring-2 focus:ring-signal-400/10"
              />
            </label>

            {error ? (
              <div
                role="alert"
                className="rounded-md border border-danger-400/30 bg-danger-400/10 px-3 py-2 text-xs text-danger-400"
              >
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-signal-400 px-3 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-signal-400/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "サインイン中…" : "サインイン"}
            </button>
          </form>

          <p className="mt-6 border-t border-ink-700/70 pt-4 text-[11px] leading-relaxed text-mist-400">
            初回起動時に管理者ユーザーが作成されます。認証情報は{" "}
            <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[10px] text-mist-200">
              ADMIN_EMAIL
            </code>{" "}
            /{" "}
            <code className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[10px] text-mist-200">
              ADMIN_PASSWORD
            </code>{" "}
            で指定するか、未指定の場合は起動ログに表示される一時パスワードを使用してください。
          </p>
        </section>
      </div>
    </main>
  );
}
