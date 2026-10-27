"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppShell } from "../components/AppShell";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

interface Host {
  id: string;
  kind: "windows" | "wsl";
  name: string;
  distro: string | null;
  defaultUser: string | null;
  enabled: boolean;
  state: "running" | "stopped" | "unknown";
  distroState: string | null;
}

interface WslDistro {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
  registered: boolean;
}

interface Problem {
  detail?: string;
}

const EMPTY_FORM = {
  name: "",
  distro: "",
  defaultUser: "",
};

export default function HostsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [distros, setDistros] = useState<WslDistro[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    try {
      const [meResponse, hostsResponse] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/hosts", { cache: "no-store" }),
      ]);

      if (meResponse.status === 401 || hostsResponse.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!meResponse.ok) throw new Error(`auth ${meResponse.status}`);
      if (!hostsResponse.ok) throw new Error(`hosts ${hostsResponse.status}`);

      setUser((await meResponse.json()) as AuthUser);
      setHosts((await hostsResponse.json()) as Host[]);
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

  async function detect() {
    setDetecting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/hosts/wsl/detect", {
        method: "POST",
      });
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `検出に失敗しました (${response.status})`,
        );
      }
      const result = (await response.json()) as WslDistro[];
      setDistros(result);
      setMessage(`${result.length} 個の WSL ディストロを検出しました`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDetecting(false);
    }
  }

  async function registerDistro(distro: WslDistro) {
    setBusyId(distro.name);
    setMessage(null);
    try {
      const response = await fetch("/api/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "wsl",
          name: distro.name,
          distro: distro.name,
          enabled: true,
        }),
      });
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `登録に失敗しました (${response.status})`,
        );
      }
      setMessage(`${distro.name} を登録しました`);
      await load();
      await detect();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function createHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "wsl",
          name: form.name.trim(),
          distro: form.distro.trim(),
          defaultUser: form.defaultUser.trim() || undefined,
          enabled: true,
        }),
      });
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `登録に失敗しました (${response.status})`,
        );
      }
      setMessage(`${form.name} を登録しました`);
      setForm(EMPTY_FORM);
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleEnabled(host: Host) {
    setBusyId(host.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/hosts/${encodeURIComponent(host.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: !host.enabled }),
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
      setMessage(`${host.name} を${host.enabled ? "無効" : "有効"}にしました`);
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  const isAdmin = user?.role === "admin";

  return (
    <AppShell
      title="ホスト"
      description="Windows は自動登録、WSL は検出して明示登録します。"
      user={user}
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

      <section className="mt-6 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">登録ホスト</h2>
            <p className="text-xs text-fg-muted">
              enabled のホストがスキャン・サービス実行の対象になります。
            </p>
          </div>
          {isAdmin ? (
            <button
              type="button"
              onClick={() => void detect()}
              disabled={detecting}
              className="rounded-md border border-border bg-surface-muted px-3 py-1.5 text-xs font-medium text-fg transition hover:border-success/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {detecting ? "検出中…" : "WSL を検出"}
            </button>
          ) : null}
        </div>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-muted text-xs text-fg-muted">
                <th scope="col" className="px-4 py-2 font-medium">
                  Kind
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Distro
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Default user
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  State
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Enabled
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Action
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
              ) : hosts.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-fg-muted"
                  >
                    ホストがありません
                  </td>
                </tr>
              ) : (
                hosts.map((host) => (
                  <tr key={host.id} className="hover:bg-surface-muted">
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                          host.kind === "windows"
                            ? "bg-info/15 text-info"
                            : "bg-success/15 text-success"
                        }`}
                      >
                        {host.kind.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-sm text-fg">{host.name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-fg-muted">
                      {host.distro ?? "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-fg-muted">
                      {host.defaultUser ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs ${
                          host.state === "running"
                            ? "text-success"
                            : host.state === "stopped"
                              ? "text-warning"
                              : "text-fg-muted"
                        }`}
                      >
                        <span
                          className={`size-1.5 rounded-full ${
                            host.state === "running"
                              ? "bg-success"
                              : host.state === "stopped"
                                ? "bg-warning"
                                : "bg-mist-400"
                          }`}
                        />
                        {host.state}
                        {host.distroState && host.distroState !== host.state ? (
                          <span className="text-xs text-fg-muted">
                            ({host.distroState})
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-fg">
                      {host.enabled ? "yes" : "no"}
                    </td>
                    <td className="px-4 py-2">
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={() => void toggleEnabled(host)}
                          disabled={busyId === host.id}
                          className="rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:border-success/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busyId === host.id
                            ? "更新中…"
                            : host.enabled
                              ? "無効化"
                              : "有効化"}
                        </button>
                      ) : (
                        <span className="text-xs text-fg-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin ? (
        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold text-fg">検出された WSL</h2>
            <p className="mt-1 text-xs text-fg-muted">
              「WSL を検出」を押すと一覧が更新されます。登録済みの distro
              は再登録できません。
            </p>
            <div className="mt-3 space-y-2">
              {distros.length === 0 ? (
                <p className="rounded-md border border-border bg-surface-muted px-3 py-4 text-center text-xs text-fg-muted">
                  まだ検出していません
                </p>
              ) : (
                distros.map((distro) => (
                  <div
                    key={distro.name}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-muted px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs text-fg">
                        {distro.name}
                        {distro.isDefault ? (
                          <span className="ml-2 rounded bg-surface-muted px-1 text-xs text-fg-muted">
                            default
                          </span>
                        ) : null}
                      </div>
                      <div className="font-mono text-xs text-fg-muted">
                        {distro.state} / v{distro.version}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void registerDistro(distro)}
                      disabled={distro.registered || busyId === distro.name}
                      className="shrink-0 rounded border border-border px-2 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {distro.registered
                        ? "登録済み"
                        : busyId === distro.name
                          ? "登録中…"
                          : "登録"}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <form
            onSubmit={createHost}
            className="rounded-xl border border-border bg-surface p-4"
          >
            <h2 className="text-sm font-semibold text-fg">WSL を手動登録</h2>
            <p className="mt-1 text-xs text-fg-muted">
              detect で見つからない場合のフォールバック。distro 名は `wsl -l -v`
              の NAME と一致させてください。
            </p>
            <label className="mt-3 block">
              <span className="mb-1 block text-xs text-fg-muted">
                Display name
              </span>
              <input
                required
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Ubuntu 24.04"
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
              />
            </label>
            <label className="mt-3 block">
              <span className="mb-1 block text-xs text-fg-muted">Distro</span>
              <input
                required
                value={form.distro}
                onChange={(event) =>
                  setForm({ ...form, distro: event.target.value })
                }
                placeholder="Ubuntu-24.04"
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
              />
            </label>
            <label className="mt-3 block">
              <span className="mb-1 block text-xs text-fg-muted">
                Default user (optional)
              </span>
              <input
                value={form.defaultUser}
                onChange={(event) =>
                  setForm({ ...form, defaultUser: event.target.value })
                }
                placeholder="dev"
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
              />
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="mt-4 w-full rounded-md bg-success px-3 py-2 text-xs font-semibold text-success-fg transition hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "登録中…" : "登録する"}
            </button>
          </form>
        </section>
      ) : (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-3 text-xs text-fg-muted">
          WSL の検出・登録・有効化は管理者のみ実行できます。
        </p>
      )}
    </AppShell>
  );
}
