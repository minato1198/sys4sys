"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppShell } from "../../components/AppShell";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

interface ManagedUser extends AuthUser {
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Problem {
  detail?: string;
}

const EMPTY_FORM = {
  email: "",
  name: "",
  password: "",
  role: "viewer" as "admin" | "operator" | "viewer",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
}

export default function UsersPage() {
  const [me, setMe] = useState<AuthUser | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [passwordFor, setPasswordFor] = useState<ManagedUser | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
      if (meResponse.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!meResponse.ok) throw new Error(`auth ${meResponse.status}`);
      const current = (await meResponse.json()) as AuthUser;
      setMe(current);

      if (current.role !== "admin") {
        setError("ユーザー管理は管理者のみ利用できます");
        setLoading(false);
        return;
      }

      const response = await fetch("/api/users", { cache: "no-store" });
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!response.ok) throw new Error(`users ${response.status}`);
      setUsers((await response.json()) as ManagedUser[]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim(),
          name: form.name.trim(),
          password: form.password,
          role: form.role,
        }),
      });
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `作成に失敗しました (${response.status})`,
        );
      }
      const created = (await response.json()) as ManagedUser;
      setMessage(`${created.email} を作成しました`);
      setForm(EMPTY_FORM);
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function updateUser(
    user: ManagedUser,
    patch: Record<string, unknown>,
    successMessage: string,
  ) {
    setBusyId(user.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/users/${encodeURIComponent(user.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `更新に失敗しました (${response.status})`,
        );
      }
      setMessage(successMessage);
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordFor) return;
    const target = passwordFor;
    setBusyId(target.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/users/${encodeURIComponent(target.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: newPassword }),
        },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ??
            `パスワード変更に失敗しました (${response.status})`,
        );
      }
      setMessage(
        `${target.email} のパスワードを再設定し、既存セッションを無効化しました`,
      );
      setPasswordFor(null);
      setNewPassword("");
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell
      title="ユーザー"
      description="admin / operator / viewer のロールとセッションを管理します。"
      user={{ role: me?.role, email: me?.email }}
    >
      {error ? (
        <div className="mt-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {message ? (
        <div className="mt-6 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          {message}
        </div>
      ) : null}

      {me?.role === "admin" ? (
        <>
          <section className="mt-6 overflow-hidden rounded-xl border border-border bg-surface">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold text-fg">ユーザー一覧</h2>
              <p className="text-xs text-fg-muted">
                最後の有効な管理者は降格・無効化できません。パスワード再設定は対象ユーザーの全セッションを無効化します。
              </p>
            </div>
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-xs text-fg-muted">
                    <th scope="col" className="px-4 py-2 font-medium">
                      Email
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Role
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Active
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Last login
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Created
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loading ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-8 text-center text-sm text-fg-muted"
                      >
                        読み込み中…
                      </td>
                    </tr>
                  ) : users.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-8 text-center text-sm text-fg-muted"
                      >
                        ユーザーがいません
                      </td>
                    </tr>
                  ) : (
                    users.map((user) => (
                      <tr key={user.id} className="hover:bg-surface-muted">
                        <td className="px-4 py-2 text-xs text-fg">
                          {user.email}
                          {user.id === me.id ? (
                            <span className="ml-2 rounded bg-surface-muted px-1 text-xs text-fg-muted">
                              you
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 text-xs text-fg">
                          {user.name}
                        </td>
                        <td className="px-4 py-2">
                          <select
                            value={user.role}
                            disabled={busyId === user.id}
                            onChange={(event) =>
                              void updateUser(
                                user,
                                { role: event.target.value },
                                `${user.email} のロールを ${event.target.value} に変更しました`,
                              )
                            }
                            className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-success/40 disabled:opacity-50"
                          >
                            <option value="admin">admin</option>
                            <option value="operator">operator</option>
                            <option value="viewer">viewer</option>
                          </select>
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                              user.isActive
                                ? "bg-success/15 text-success"
                                : "bg-danger/15 text-danger"
                            }`}
                          >
                            {user.isActive ? "active" : "disabled"}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-fg-muted">
                          {formatDate(user.lastLoginAt)}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-fg-muted">
                          {formatDate(user.createdAt)}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                void updateUser(
                                  user,
                                  { isActive: !user.isActive },
                                  `${user.email} を${user.isActive ? "無効" : "有効"}にしました`,
                                )
                              }
                              disabled={busyId === user.id}
                              className="rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:border-warning/40 hover:text-warning disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {user.isActive ? "無効化" : "有効化"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setPasswordFor(user);
                                setNewPassword("");
                              }}
                              disabled={busyId === user.id}
                              className="rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:border-success/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              PW 再設定
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {passwordFor ? (
            <form
              onSubmit={submitPassword}
              className="mt-4 rounded-xl border border-success/30 bg-success/5 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-fg">
                    {passwordFor.email} のパスワードを再設定
                  </h2>
                  <p className="text-xs text-fg-muted">
                    12
                    文字以上。対象ユーザーの既存セッションはすべて無効化されます。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPasswordFor(null);
                    setNewPassword("");
                  }}
                  className="rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:text-fg"
                >
                  キャンセル
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="新しいパスワード"
                  className="min-w-[240px] flex-1 rounded-md border border-border bg-bg px-3 py-2 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                />
                <button
                  type="submit"
                  disabled={busyId === passwordFor.id}
                  className="rounded-md bg-success px-3 py-2 text-xs font-semibold text-success-fg transition hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyId === passwordFor.id ? "変更中…" : "再設定する"}
                </button>
              </div>
            </form>
          ) : null}

          <form
            onSubmit={createUser}
            className="mt-6 rounded-xl border border-border bg-surface p-4"
          >
            <h2 className="text-sm font-semibold text-fg">ユーザーを追加</h2>
            <p className="mt-1 text-xs text-fg-muted">
              初期パスワードは 12
              文字以上。作成後、本人に安全な方法で伝えてください。
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs text-fg-muted">Email</span>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={(event) =>
                    setForm({ ...form, email: event.target.value })
                  }
                  placeholder="user@example.com"
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-fg-muted">Name</span>
                <input
                  required
                  value={form.name}
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value })
                  }
                  placeholder="Operator"
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-fg-muted">
                  Password
                </span>
                <input
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(event) =>
                    setForm({ ...form, password: event.target.value })
                  }
                  placeholder="12+ characters"
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-fg-muted">Role</span>
                <select
                  value={form.role}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      role: event.target.value as
                        "admin" | "operator" | "viewer",
                    })
                  }
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
                >
                  <option value="viewer">viewer</option>
                  <option value="operator">operator</option>
                  <option value="admin">admin</option>
                </select>
              </label>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-4 rounded-md bg-success px-4 py-2 text-xs font-semibold text-success-fg transition hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "作成中…" : "作成する"}
            </button>
          </form>
        </>
      ) : null}
    </AppShell>
  );
}
