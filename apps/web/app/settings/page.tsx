"use client";

import { useCallback, useEffect, useState } from "react";
import { NavLinks } from "../components/NavLinks";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

interface MailSettingsView {
  configured: boolean;
  source: "db" | "env" | "none";
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  recipients: string[];
  mode: "immediate" | "digest5m";
  passwordSet: boolean;
}

interface Problem {
  detail?: string;
}

interface MailForm {
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  recipients: string;
  mode: "immediate" | "digest5m";
  clearPassword: boolean;
}

const EMPTY_FORM: MailForm = {
  host: "",
  port: "587",
  secure: false,
  username: "",
  password: "",
  from: "",
  recipients: "",
  mode: "immediate",
  clearPassword: false,
};

function viewToForm(view: MailSettingsView): MailForm {
  return {
    host: view.host,
    port: String(view.port),
    secure: view.secure,
    username: view.username,
    password: "",
    from: view.from,
    recipients: view.recipients.join(", "),
    mode: view.mode,
    clearPassword: false,
  };
}

function splitRecipients(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function SettingsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [view, setView] = useState<MailSettingsView | null>(null);
  const [form, setForm] = useState<MailForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/mail", {
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (response.status === 403) {
      setView(null);
      setError("SMTP 設定の表示には admin 権限が必要です");
      return;
    }
    if (!response.ok) throw new Error(`mail settings ${response.status}`);
    const body = (await response.json()) as MailSettingsView;
    setView(body);
    setForm(viewToForm(body));
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
        if (meResponse.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!meResponse.ok) throw new Error(`auth ${meResponse.status}`);
        if (active) setUser((await meResponse.json()) as AuthUser);
        await load();
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const recipients = splitRecipients(form.recipients);
      if (recipients.length === 0) {
        throw new Error("送信先を 1 件以上入力してください");
      }
      const response = await fetch("/api/settings/mail", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          host: form.host.trim(),
          port: Number(form.port),
          secure: form.secure,
          username: form.username.trim() || undefined,
          password: form.password || undefined,
          from: form.from.trim(),
          recipients,
          mode: form.mode,
          clearPassword: form.clearPassword,
        }),
      });
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `保存に失敗しました (${response.status})`,
        );
      }
      const body = (await response.json()) as MailSettingsView;
      setView(body);
      setForm(viewToForm(body));
      setMessage("SMTP 設定を保存しました");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/settings/mail/test", {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as {
        accepted?: string[];
        recipients?: string[];
        detail?: string;
      } | null;
      if (!response.ok) {
        throw new Error(
          body?.detail ?? `テスト送信に失敗しました (${response.status})`,
        );
      }
      setMessage(
        `テストメールを送信しました: ${
          body?.accepted?.join(", ") ??
          body?.recipients?.join(", ") ??
          "送信済み"
        }`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  }

  const isAdmin = user?.role === "admin";

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg border border-signal-400/30 bg-signal-400/10">
            <span className="font-mono text-sm font-bold text-signal-400">
              s4s
            </span>
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white">
              Settings
            </h1>
            <p className="text-xs text-mist-400">
              SMTP 通知と監視ポリシーの設定を確認します。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <NavLinks role={user?.role} />
          <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-800/60 px-3 py-1.5">
            <div className="text-right">
              <div className="text-xs text-mist-200">
                {user?.email ?? "認証確認中…"}
              </div>
              <div className="text-[9px] font-medium uppercase tracking-[0.14em] text-mist-400">
                {user?.role ?? ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded border border-ink-700 px-2 py-1 text-[11px] text-mist-400 transition hover:border-danger-400/40 hover:text-danger-400"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="mt-6 rounded-lg border border-danger-400/30 bg-danger-400/10 px-4 py-3 text-sm text-danger-400">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mt-6 rounded-lg border border-signal-400/30 bg-signal-400/10 px-4 py-3 text-sm text-signal-400">
          {message}
        </div>
      ) : null}

      {!isAdmin ? (
        <section className="mt-6 rounded-xl border border-ink-700/70 bg-ink-900/50 p-6 text-sm text-mist-400">
          SMTP 設定の変更には admin 権限が必要です。
        </section>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-xl border border-ink-700/70 bg-ink-900/50">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700/70 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  SMTP / Email
                </h2>
                <p className="text-[11px] text-mist-400">
                  保存した設定は env より優先されます。パスワードは AES-256-GCM
                  で暗号化して保存します。
                </p>
              </div>
              {view ? (
                <span
                  className={`rounded border px-2 py-0.5 text-[10px] font-medium uppercase ${
                    view.configured
                      ? "border-signal-400/40 bg-signal-400/10 text-signal-400"
                      : "border-warn-400/40 bg-warn-400/10 text-warn-400"
                  }`}
                >
                  {view.configured ? "configured" : "not configured"} /{" "}
                  {view.source}
                </span>
              ) : null}
            </div>

            <div className="space-y-3 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-mist-400">
                    SMTP host
                  </span>
                  <input
                    value={form.host}
                    onChange={(event) =>
                      setForm({ ...form, host: event.target.value })
                    }
                    placeholder="smtp.example.com"
                    className="mt-1 w-full rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-2 text-xs text-mist-200 outline-none focus:border-signal-400/50"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-mist-400">
                    Port
                  </span>
                  <input
                    value={form.port}
                    onChange={(event) =>
                      setForm({ ...form, port: event.target.value })
                    }
                    inputMode="numeric"
                    className="mt-1 w-full rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-2 font-mono text-xs text-mist-200 outline-none focus:border-signal-400/50"
                  />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-mist-400">
                    Username
                  </span>
                  <input
                    value={form.username}
                    onChange={(event) =>
                      setForm({ ...form, username: event.target.value })
                    }
                    autoComplete="off"
                    className="mt-1 w-full rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-2 text-xs text-mist-200 outline-none focus:border-signal-400/50"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-mist-400">
                    Password{" "}
                    {view?.passwordSet ? (
                      <span className="text-signal-400">(保存済み)</span>
                    ) : null}
                  </span>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        password: event.target.value,
                        clearPassword: false,
                      })
                    }
                    placeholder={
                      view?.passwordSet
                        ? "変更する場合のみ入力"
                        : "SMTP password"
                    }
                    autoComplete="new-password"
                    className="mt-1 w-full rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-2 text-xs text-mist-200 outline-none focus:border-signal-400/50"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-xs text-mist-200">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.secure}
                    onChange={(event) =>
                      setForm({ ...form, secure: event.target.checked })
                    }
                    className="size-3.5 accent-signal-400"
                  />
                  TLS (secure)
                </label>
                {view?.passwordSet ? (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.clearPassword}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          clearPassword: event.target.checked,
                          password: "",
                        })
                      }
                      className="size-3.5 accent-danger-400"
                    />
                    保存済みパスワードを削除
                  </label>
                ) : null}
              </div>

              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-mist-400">
                  From
                </span>
                <input
                  value={form.from}
                  onChange={(event) =>
                    setForm({ ...form, from: event.target.value })
                  }
                  placeholder="sys4sys@example.com"
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-2 text-xs text-mist-200 outline-none focus:border-signal-400/50"
                />
              </label>

              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-mist-400">
                  Recipients
                </span>
                <textarea
                  value={form.recipients}
                  onChange={(event) =>
                    setForm({ ...form, recipients: event.target.value })
                  }
                  rows={2}
                  placeholder="ops@example.com, oncall@example.com"
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-2 text-xs text-mist-200 outline-none focus:border-signal-400/50"
                />
                <span className="mt-1 block text-[10px] text-mist-400">
                  カンマ / 空白 / 改行区切り。空にすると保存できません。
                </span>
              </label>

              <label className="block">
                <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-mist-400">
                  Delivery mode
                </span>
                <select
                  value={form.mode}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      mode: event.target.value as "immediate" | "digest5m",
                    })
                  }
                  className="mt-1 w-full rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-2 text-xs text-mist-200 outline-none focus:border-signal-400/50"
                >
                  <option value="immediate">immediate</option>
                  <option value="digest5m">digest5m（現状は即時送信）</option>
                </select>
              </label>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save()}
                  className="rounded-md border border-signal-400/40 bg-signal-400/10 px-3 py-1.5 text-xs font-medium text-signal-400 transition hover:bg-signal-400/20 disabled:opacity-50"
                >
                  {saving ? "保存中…" : "保存"}
                </button>
                <button
                  type="button"
                  disabled={testing}
                  onClick={() => void test()}
                  className="rounded-md border border-ink-700 bg-ink-800/80 px-3 py-1.5 text-xs font-medium text-mist-200 transition hover:border-signal-400/40 hover:text-white disabled:opacity-50"
                >
                  {testing ? "送信中…" : "テスト送信（保存済み設定）"}
                </button>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-mist-400 transition hover:border-signal-400/40 hover:text-white"
                >
                  再読み込み
                </button>
              </div>
              <p className="text-[10px] text-mist-400">
                テスト送信は保存済みの設定を使用します。変更後は先に保存してください。
              </p>
            </div>
          </section>

          <section className="space-y-4">
            <div className="rounded-xl border border-ink-700/70 bg-ink-900/50 p-4">
              <h2 className="text-sm font-semibold text-white">通知ポリシー</h2>
              <ul className="mt-2 space-y-2 text-xs text-mist-400">
                <li>
                  検知・承認待ち・復旧・復旧失敗・エスカレーションをメール通知します。
                </li>
                <li>
                  SMTP
                  が未設定の場合は通知をスキップし、インシデント画面とログだけに記録します。
                </li>
                <li>
                  送信先が空の場合は、有効な admin / operator
                  のメールアドレスを使用します。
                </li>
                <li>
                  digest5m
                  は現時点では即時送信として扱います（ダイジェスト集約は未実装）。
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-ink-700/70 bg-ink-900/50 p-4">
              <h2 className="text-sm font-semibold text-white">
                自動再起動ポリシー
              </h2>
              <dl className="mt-2 grid gap-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-mist-400">observe</dt>
                  <dd className="text-mist-200">検知と通知のみ</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-mist-400">approve</dt>
                  <dd className="text-mist-200">UI 承認後に再起動</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-mist-400">auto</dt>
                  <dd className="text-mist-200">安全装置内で自動再起動</dd>
                </div>
              </dl>
              <p className="mt-3 text-[11px] text-mist-400">
                クールダウン、最大試行回数、クラッシュループ、復旧確認失敗の安全装置は
                <span className="font-mono text-mist-200">
                  {" "}
                  AUTO_RESTART_*{" "}
                </span>
                env で調整します。サービスごとの phase は Services
                画面で変更できます。
              </p>
            </div>

            <div className="rounded-xl border border-ink-700/70 bg-ink-900/50 p-4">
              <h2 className="text-sm font-semibold text-white">現在の設定</h2>
              {loading ? (
                <p className="mt-2 text-xs text-mist-400">読み込み中…</p>
              ) : view ? (
                <dl className="mt-2 space-y-1.5 text-[11px]">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-mist-400">source</dt>
                    <dd className="text-mist-200">{view.source}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-mist-400">host:port</dt>
                    <dd className="font-mono text-mist-200">
                      {view.host || "—"}:{view.port}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-mist-400">from</dt>
                    <dd className="break-all text-mist-200">
                      {view.from || "—"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-mist-400">recipients</dt>
                    <dd className="break-all text-right text-mist-200">
                      {view.recipients.length > 0
                        ? view.recipients.join(", ")
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-mist-400">password</dt>
                    <dd className="text-mist-200">
                      {view.passwordSet ? "set" : "not set"}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-xs text-mist-400">—</p>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
