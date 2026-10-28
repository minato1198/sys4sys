# sys4sys 外部コマンド堅牢性 修正計画

- 版: v1.0
- 作成日: 2026-10-28
- 基準: `main` / `bc3b413`
- 対象: `apps/agent`, `apps/api`, `apps/web`, `packages/shared`
- ステータス: 実装済み（自動テスト完了、WSL 無効環境の実機確認は未実施）
- 前提: デプロイログの文字化け修正 `882a584` と AI 分析の日本語化 `bc3b413` は完了済み。本計画では既存の認証・監視・AI の設計を変更しない。

---

## 0. 目的

WSL / PowerShell / 外部コマンドの一時的な失敗が、スキャン結果の一部欠落ではなく **API 全体の 500** や **誤ったプロセス状態** になる経路を除去する。

本計画の最優先事項は次の 2 点。

1. WSL が使えない環境でも、Windows のポート一覧・予約・kill 系 API が動作する。
2. Windows スキャンが失敗しても、WSL の結果と既存のポート履歴を失わない。

そのうえで、WSL ログ tailer、プロセス生死判定、Windows ヘルスチェック、監査ログの整合性を段階的に修正する。

### 非ゴール

- WSL のネットワーク共有仕様（WSL 3.x の distro 間共有）の再設計。
- 認証・ロール・監査ポリシーの全面変更。
- ポートスキャナの UI デザイン変更。
- 外部コマンドを常駐エージェント化する構想。
- 本計画作成時点でのコード変更。

---

## 1. 問題の要約

### 1.1 優先度定義

| 優先度 | 定義                                                                   |
| ------ | ---------------------------------------------------------------------- |
| P0     | 主要 API が 500 になる、または Windows のみの操作が WSL 障害で停止する |
| P1     | 誤った状態判定、復旧阻害、ログ欠損・文字化け、ヘルスチェック誤判定     |
| P2     | 履歴・監査の整合性、ポーリング負荷、セキュリティ上の運用リスク         |

### 1.2 指摘一覧

| ID   | 優先度 | 問題                                                                              | 主な箇所                                                                               |
| ---- | ------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| R-01 | P0     | `scope=windows` でも WSL 一覧取得を無条件実行し、失敗を捕捉していない             | `apps/agent/src/scan.ts:81`                                                            |
| R-02 | P0     | Windows スキャン失敗が `Promise.all` 全体の reject になる                         | `apps/agent/src/scan.ts:88-99`, `apps/agent/src/windows.ts:77-79`                      |
| R-03 | P1     | WSL コマンド失敗を「プロセス死亡」と誤判定する                                    | `apps/agent/src/process.ts:30-40`, `apps/api/src/services/manager.ts:502-525, 907-950` |
| R-04 | P1     | Windows の command ヘルスチェックが `cwd` / `env` を無視し、`.cmd` も実行できない | `apps/api/src/services/manager.ts:748-755`, `apps/agent/src/exec.ts:9-17`              |
| R-05 | P1     | WSL tailer が検出失敗をキャッシュせず、起動時に source ごとに再試行する           | `apps/api/src/logs/tailers.ts:35-45, 257-261`                                          |
| R-06 | P1     | ファイルログが UTF-8 固定で、既存の Shift-JIS デコーダを使っていない              | `apps/api/src/logs/tailers.ts:89, 118`                                                 |
| R-07 | P1     | `runFile()` のエラー診断が WSL の UTF-16LE / stdout を扱えない                    | `apps/agent/src/exec.ts:18-27, 40-49`                                                  |
| R-08 | P2     | PowerShell の空出力を「0 件の正常終了」と扱い、履歴を閉じ得る                     | `apps/agent/src/windows.ts:41-44`                                                      |
| R-09 | P2     | WSL の `ss` と `ps` が `Promise.all` で、`ps` 失敗時に `ss` の結果も捨てる        | `apps/agent/src/wsl.ts:56-59`                                                          |
| R-10 | P2     | 監査ログ失敗が操作失敗扱いになり、実状態と API 応答がずれる                       | `apps/api/src/routes/services.ts:805-864` ほか                                         |
| R-11 | P2     | 10 秒ポーリングと直列スキャンに single-flight がなく、リクエストが堆積する        | `apps/web/app/page.tsx:190-198`, `apps/api/src/ports/scanner.ts:209-228`               |
| R-12 | P2     | 初回生成 admin パスワードを構造化ログに平文出力している                           | `apps/api/src/app.ts:109-114`                                                          |

> 行番号は基準コミット時点のもの。実装時に周辺コードが変わっている場合は、関数名と意図を優先する。

---

## 2. 共通設計

### 2.1 スキャン結果の契約

現在の `PortScanResult` は `skipped: SkippedDistro[]` しか持たない。Windows スコープの失敗と WSL distro のスキップを混在させないため、追加のエラー情報を持たせる。

```ts
// packages/shared/src/ports.ts（案）
export const scanErrorSchema = z.object({
  scope: portScopeSchema, // "windows" | "wsl"
  distro: z.string().optional(),
  code: z
    .enum(["not_available", "timeout", "command_failed", "invalid_output"])
    .optional(),
  message: z.string(),
});

export type ScanError = z.infer<typeof scanErrorSchema>;

export const portScanResultSchema = z.object({
  scannedAt: z.string(),
  rows: z.array(portRowSchema),
  skipped: z.array(skippedDistroSchema),
  scanErrors: z.array(scanErrorSchema).default([]),
});
```

`DetailedScanResult` にも同じフィールドを追加する。

### 2.2 スコープごとの成否

`scanPorts()` は外部コマンド失敗で throw しない。代わりに、以下の状態を持つ。

- 成功したスコープだけ `timings` を持つ。
- 失敗したスコープは `scanErrors` に記録し、`timings` を作らない。
- WSL 一覧取得が成功し、Running の distro が 0 件の場合は「失敗」ではなく「スキャン対象なし」とする。この場合も `timings` は作らない。
- 停止中の distro は従来どおり `skipped` に入れる。

`scanner.ts:61-67` の `wasScanned()` は `timings` の有無で履歴クローズを判断しているため、**失敗スコープに timing を作らないことが履歴保護の条件**になる。

### 2.3 API のステータス

`/api/ports` 系の応答は次の方針にする。

| 状況                       | 応答                           |
| -------------------------- | ------------------------------ |
| 要求スコープがすべて成功   | 200                            |
| 一部スコープ成功、一部失敗 | 200 + `scanErrors`（部分結果） |
| 要求スコープがすべて失敗   | 503 Problem Details            |
| 予期しないプログラム例外   | 500（従来どおり）              |

`scope=windows` は Windows だけを要求していると解釈する。WSL の検出は行わない。

### 2.4 プロセス生死の契約

`isProcessAlive()` を boolean から三値に変更する。

```ts
export type ProcessLiveness = "alive" | "dead" | "unknown";
```

- `alive`: プロセスが存在する。
- `dead`: プロセスが存在しないことをコマンド結果から確認できた。
- `unknown`: `wsl.exe` の起動失敗、タイムアウト、権限不足などで確認できない。

`unknown` を `dead` として扱う箇所をなくす。

### 2.5 監査ログの方針

監査ログの失敗を、外部操作の成否と混同しない。

- 外部プロセス操作（start / stop / kill / deploy）: 監査失敗は警告に留め、操作結果を覆さない。
- DB だけで完結する作成・更新: 状態更新と監査を同一 transaction にできるものは transaction 化する。
- 監査失敗は `audit.write_failed` としてアプリログに記録する。監査ログ本文に秘密値を追加しない。

---

## 3. P0 修正

### R-01 WSL 検出をスコープ別に遅延実行する

**現状**

`scanPorts()` は `scope` の分岐前に `listDistroStates()` を await している。

```ts
const scope = options.scope ?? "all";
const distros = await listDistroStates(); // ← scope=windows でも実行
```

`listDistroStates()` は `wsl.exe` の失敗をそのまま reject するため、WSL 無効環境では Windows のみのリクエストも 500 になる。

**影響する API**

- `GET /api/ports`（`apps/api/src/routes/ports.ts:168`）
- `POST /api/ports/reserve`（`routes/ports.ts:311`、`scope: "all"` 固定）
- `GET /api/ports/:port/kill-token`（`routes/ports.ts:440`）
- `POST /api/ports/:port/kill`（`routes/ports.ts:547`）
- Web の 10 秒ポーリング（`apps/web/app/page.tsx:190-198`）

**変更**

- `scan.ts`
  - `scope === "windows"` のときは `listDistroStates()` を呼ばない。
  - WSL を含む場合だけ `safeListDistroStates()` を呼ぶ。
  - WSL 一覧失敗時は `scanErrors` に `scope: "wsl"` を追加し、`distros = []` にする。
  - WSL の `timings` を作らない。
- `wsl.ts`
  - `listDistroStates()` はそのまま残し、呼び出し側でエラーを分類する。
  - 可能なら `ExternalCommandError` の code を使い、WSL 未導入・タイムアウト・コマンド失敗を区別する。
- `shared/ports.ts`
  - `scanErrors` を追加する。
- `routes/ports.ts`
  - 要求スコープの全失敗を 503、部分成功を 200 に変換する。
  - `reserve` は予約対象スコープが未スキャンなら 503。対象外スコープだけが不明な場合は、既存の横断競合チェックを維持しつつ警告を返す。
  - kill-token / kill は対象スコープが未スキャンなら、対象なしの 409 ではなく「状態不明」の 503 を返す。
- `apps/web/app/page.tsx`
  - `scanErrors` を警告として表示する。

**回帰テスト**

- `listDistroStates` が reject しても `scanPorts({ scope: "windows" })` が Windows 行を返す。
- 同じ状況で `/api/ports?scope=windows` が 500 にならない。
- `scope=all` で Windows 成功・WSL 失敗のとき、200 の部分結果になる。
- `scope=wsl` で WSL 一覧失敗のとき 503 になり、500 にはならない。
- WSL の timing が存在せず、既存の WSL `portHistory` が閉じられない。
- `scope=windows` で `listDistroStates` が呼ばれない。

**完了条件**

- WSL を無効化した環境で `/api/ports?scope=windows` が成功する。
- Windows の予約・kill-token が WSL 障害で停止しない。
- WSL 障害時に UI が「WSL スコープ未取得」を明示する。

---

### R-02 Windows スキャン失敗を局所化する

**現状**

`scan.ts` の Windows タスクには `.catch` がなく、`scanWindows()` が throw すると `Promise.all(tasks)` 全体が reject する。

```ts
tasks.push(
  scanWindows().then((result) => {
    rows.push(...result.rows);
    timings["windows"] = { ... };
  }),
);
```

`scanWindows()` は `pwsh.exe` と `powershell.exe` の両方が失敗すると throw する。

**変更**

- `scan.ts`
  - Windows タスクを `.then(...).catch(...)` で包む。
  - 失敗時は `scanErrors` に `scope: "windows"` を追加する。
  - 成功時だけ `timings.windows` を設定する。
- `windows.ts`
  - 失敗理由を `ExternalCommandError` として返せるようにする。
  - 空出力の扱いは R-08 で別途修正する。
- `scanner.ts`
  - `wasScanned()` は変更しない。成功 timing のみで履歴を閉じる既存仕様を維持する。
- `routes/ports.ts`
  - 部分成功時は 200 + `scanErrors`、Windows のみ要求して失敗した場合は 503。

**回帰テスト**

- `scanWindows` が reject し、WSL が成功するケースで `scope=all` が 200 の部分結果を返す。
- `timings.windows` が存在せず、既存の Windows `portHistory` が閉じられない。
- `scope=windows` で Windows のみ失敗した場合は 503 になり、500 にはならない。
- Windows と WSL の両方が失敗した場合も、未処理 reject にならない。

**完了条件**

- PowerShell の実行環境に問題があっても、WSL の結果が失われない。
- Windows スキャン失敗で既存の Windows ポート履歴が消えない。
- API の 500 は予期しないプログラム例外に限定される。

---

## 4. P1 修正

### R-03 `isProcessAlive()` を三値化する

**現状**

`process.ts:30-40` は WSL の `runFile()` が失敗すると、理由を問わず `false` を返す。

```ts
try {
  await runFile("wsl.exe", [
    "-d",
    ref.pidScope,
    "--",
    "kill",
    "-0",
    String(ref.pid),
  ]);
  return true;
} catch {
  return false;
}
```

`false` は `reconcileServices()` で「停止」、`waitForDeath()` で「死亡確認済み」として扱われる。

**変更**

- `process.ts`
  - `ProcessLiveness` を追加。
  - Windows は `EPERM` を `alive`、`ESRCH` を `dead`、その他を `unknown` とする。
  - WSL は `kill -0` の終了コード 1 を `dead`、コマンド起動失敗・タイムアウト・exit code 127 などを `unknown` とする。
  - `pidScope` がない WSL 参照は `unknown` とする。
- `exec.ts`
  - `ExternalCommandError` に `code` / `exitCode` / `timedOut` / `stdout` / `stderr` を持たせる（R-07 と共通）。
- `manager.ts`
  - `reconcileServices()` は `unknown` の場合、`pid` を消さず、状態を維持する。`lastError` に「プロセス状態を確認できない」を記録する。
  - `waitForDeath()` は `unknown` を「死亡」と扱わない。停止 API は 409/503 で失敗させる。
  - ヘルスチェックの process 判定も `unknown` を unhealthy ではなく「判定不能」として扱い、即時の再起動判断に使わない。

**回帰テスト**

- `runFile` が ENOENT / timeout を返したとき `isProcessAlive` が `unknown` になる。
- `kill -0` の exit code 1 は `dead` になる。
- WSL 障害中の `reconcileServices` がサービスを `stopped` にせず、`pid` を消さない。
- WSL 障害中の `stopService` が成功扱いにならない。

**完了条件**

- WSL の一時障害で、稼働中サービスの PID と状態が失われない。
- 実際には停止していないプロセスを「停止成功」と報告しない。

---

### R-04 Windows の command ヘルスチェックを修正する

**現状**

`manager.ts:748-755` の Windows 分岐は、`runFile(command[0]!, command.slice(1), timeoutMs)` だけを実行している。

```ts
if (host.kind === "windows") {
  await runFile(command[0]!, command.slice(1), timeoutMs);
}
```

このため次の問題がある。

- `service.cwd` を使わない。
- Windows では `service.env` を復号・マージしない。
- `runFile()` は `execFile()` ベースなので、`.cmd` / `.bat` を直接実行できない。

許可リストは `pnpm.cmd` を `pnpm` に正規化して許可するが、`execFile("pnpm.cmd", ...)` は `spawn EINVAL` になる。結果として、許可済みのコマンドがヘルスチェックだけ常に失敗する。

**変更**

- `manager.ts` に Windows command 用の実行ヘルパーを追加する。
  - `cross-spawn` を使い、引数配列のまま実行する。
  - `cwd: service.cwd ?? undefined` を渡す。
  - `env: { ...process.env, ...serviceEnv }` を渡す。
  - タイムアウト時はプロセスツリーを停止する。
- `serviceEnv` の復号を Windows / WSL の分岐前に移動する。
- WSL 側は既存の `wslCommandArgs(host, command, service.cwd, serviceEnv)` を維持する。
- `.cmd` / `.bat` の実行は `cross-spawn` に任せる。シェル文字列を組み立てない。

**回帰テスト**

- `.cmd` のヘルスチェックが成功する（Windows 実機またはモック）。
- `service.cwd` 基準の相対パスが解決される。
- `service.env` の値が子プロセスから参照できる。
- タイムアウト時にヘルスチェックが失敗し、プロセスが残らない。
- 許可リスト通過後のコマンドだけが実行される。

**完了条件**

- `pnpm.cmd` / `npm.cmd` などの許可済みコマンドでヘルスチェックが誤判定されない。
- cwd / env 依存のヘルスチェックが Windows / WSL で同じように動く。

---

### R-05 WSL tailer の失敗キャッシュと起動時処理を修正する

**現状**

`tailers.ts:35-45` の `distroRunning()` は `listDistroStates()` の失敗時に `false` を返すだけで、`distroCache` を更新しない。

```ts
try {
  const distros = await listDistroStates();
  distroCache = { ... };
} catch {
  return false; // キャッシュされない
}
```

そのため WSL が利用できない間、WSL ログ source ごとに毎回 `wsl.exe` を呼ぶ。`startAllLogTailers()` は source を直列に await するため、source が N 個あると起動時に最大 N × 10 秒待つ可能性がある。

**変更**

- `distroCache` に失敗状態を持たせる。

```ts
let distroCache: {
  at: number;
  states: Map<string, string>;
  error?: string;
} | null = null;
```

- 失敗時も TTL（例: 30 秒）でネガティブキャッシュする。
- 失敗ログは一度だけ出し、ポーリングごとの連続警告を避ける。
- `startAllLogTailers()` は source ごとに `try/catch` し、1 つの source の失敗で API 起動を止めない。
- WSL 復旧後は TTL 経過で再検出する。
- DB 全体の障害は従来どおり起動失敗でよい。

**回帰テスト**

- `listDistroStates` が reject するとき、同じ TTL 内の複数回呼び出しで `wsl.exe` 呼び出しが 1 回だけ。
- WSL source が複数あっても起動が source 数 × 10 秒にならない。
- WSL 復旧後に tailer が再初期化される。
- 1 つの log source の `startTailer` 失敗が他の source を止めない。

**完了条件**

- WSL 無効環境で API 起動が不必要に遅延しない。
- WSL 障害中に `wsl.exe` の連続起動が発生しない。

---

### R-06 ファイルログを UTF-8 / Shift-JIS 対応にする

**現状**

`tailers.ts:89` は `buffer.toString("utf8")`、`tailers.ts:118` は `decodeWslOutput()` を使っており、Windows の Shift-JIS ファイルログをデコードしていない。

既存の `logs/process-lines.ts` には `decodeProcessBytes()` と `ProcessLineDecoder` があるが、ファイル tailer からは使われていない。

**変更**

- tailer の読み取り結果を文字列ではなく `Buffer` にする。
- `ProcessLineDecoder` を source ごとに保持し、読み取ったバイト列を投入する。
- `ProcessLineDecoder` が行単位で返した文字列を既存の `ingestLogs()` に渡す。
- `dropped` 時は decoder の保留バイトをリセットする。
- `carry` はデコーダ内の保留バイトと混同しないよう、文字列ベースの処理を整理する。
- BOM 付き UTF-8 / UTF-16 も `decodeCommandOutput` または専用デコーダで扱う。

**回帰テスト**

- Shift-JIS の日本語ログが正しく保存される。
- UTF-8 の日本語ログがそのまま保存される。
- マルチバイト文字がチャンク境界をまたいでも壊れない。
- ファイルの切り詰め・ローテーション後に decoder がリセットされる。
- 既存の `process-lines.test.ts` の hex フィクスチャを拡張する。

**完了条件**

- Windows / WSL のファイルログで日本語が文字化けしない。
- 既存の stdout / stderr ログのデコードを壊さない。

---

### R-07 `runFile()` のエラー診断と UTF-16 判定を改善する

**現状**

`exec.ts:18-27` はエラー時に stderr だけを UTF-8 として読み、stdout を捨てている。

```ts
const errText = stderr
  ? Buffer.from(stderr).toString("utf8").slice(0, 2000)
  : "";
```

しかし WSL のエラーは stdout に UTF-16LE（BOM なし）で出ることがある。また `decodeWslOutput()` は NUL 密度 25% で判定しており、日本語の UTF-16LE 出力では 24.4% 程度になって UTF-8 と誤判定され得る。

**変更**

- `exec.ts` に `ExternalCommandError` を追加する。

```ts
export class ExternalCommandError extends Error {
  code?: string;
  exitCode?: number | null;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
}
```

- `runFile()` の reject を `ExternalCommandError` に統一する。
- エラー時も stdout / stderr の両方をデコードし、短く切り詰めてメッセージに含める。
- `decodeCommandOutput(buf)` を追加する。
  1. BOM があれば UTF-8 / UTF-16LE / UTF-16BE を確定。
  2. BOM がなければ strict UTF-8 を試す。
  3. UTF-8 として妥当でも NUL が多い場合は UTF-16LE を試す。
  4. UTF-8 が不正で偶数長なら UTF-16LE を試す。
  5. 最後に UTF-8 フォールバック。
- `decodeWslOutput()` は `decodeCommandOutput()` に委譲する。
- エラーメッセージにコマンド引数をそのまま含めない。秘密値が引数に含まれる可能性があるため、実行ファイル名と短い診断だけにする。

**回帰テスト**

- 日本語の UTF-16LE（BOM なし）を正しくデコードする。
- ASCII の UTF-16LE（NUL 密度が高い）を正しくデコードする。
- UTF-8 の日本語を誤って UTF-16 と判定しない。
- WSL の stdout エラーが `scanErrors` に反映される。
- `runFile` のエラーで stdout / stderr / exit code が保持される。

**完了条件**

- WSL 障害時に distro 名・エラーコードを含む診断が得られる。
- 日本語の WSL エラーが文字化けしない。

---

## 5. P2 修正

### R-08 空の PowerShell 出力を成功扱いしない

`windows.ts:41-44` は空文字列を `rows: []` として返す。`scan-windows.ps1` は `$ErrorActionPreference = 'SilentlyContinue'` なので、CIM 取得などが静かに失敗すると空出力になり得る。

この場合 `scan.ts` が `timings.windows` を作り、`scanner.ts:61-67` の `wasScanned()` が true になるため、既存の Windows ポート履歴をすべて「消えた」と閉じてしまう。

**変更**

- `scanWindows` は空 stdout をコマンド失敗として扱う。
- 正常な 0 件は `[]` の JSON として成功させる。
- `JSON.parse` の結果が `null` / 非配列・非オブジェクトの場合は失敗とする。
- 必要なら PowerShell 側で `{ scanned: true, rows: [...] }` のような明示マーカーを返す。

**テスト**

- 空 stdout で timing が作られない。
- `[]` は正常な 0 件として timing が作られる。
- 既存の Windows `portHistory` が空出力で閉じられない。

---

### R-09 WSL の `ss` / `ps` を独立して扱う

`wsl.ts:56-59` は `ss` と `ps` を `Promise.all` している。BusyBox / Alpine 系 distro では `ps -eo ... etimes` が失敗し、`ss` が成功していても distro 全体が skipped になる。

**変更**

- `Promise.allSettled` を使う。
- `ss` が失敗した場合だけ distro を skipped にする。
- `ps` が失敗した場合は、ポート行は返し、process / parent / commandLine を null にする。
- `ps` 失敗を `warnings` として返し、`scanErrors` とは分ける（ポート自体は取得できているため）。
- `ss` 成功時は `timings` を作り、履歴クローズの対象にする。

**テスト**

- `ps` だけ reject し、`ss` が成功するケースでポート行が返る。
- `ss` が reject するケースで distro が skipped になる。
- `ps` 失敗時に process 情報が null でも行が壊れない。

---

### R-10 監査ログ失敗を操作結果と分離する

**現状**

- `routes/services.ts:805-864`: サービス起動成功後の `writeAudit()` が失敗すると、catch が action を `failed` に更新し、API は 409 を返す。
- `routes/ports.ts:355`: 予約 insert 後の `writeAudit()` が失敗すると 500。予約は残る。
- `routes/ports.ts:629`: kill の action / portHistory 更新後の `writeAudit()` が失敗すると、catch が action を failed にする。実際には kill 済み。

**変更**

- `audit.ts` に best-effort 用の `tryWriteAudit()` を追加する。
  - 失敗時は `audit.write_failed` をアプリログに記録する。
  - 監査 entry の秘密値はログに出さない。
- 外部プロセス操作を含むルートでは `tryWriteAudit()` を使い、操作結果を覆さない。
- DB だけで完結する作成・更新は、状態更新と監査ログを同一 transaction にする。
- `performAction` の catch は「実際の操作が失敗した場合」だけ action を failed にする。

**テスト**

- `writeAudit` が reject しても service start が 202 で成功し、action が succeeded のまま。
- 予約 insert 後の監査失敗で 500 にならず、予約が返る。
- kill 後の監査失敗で kill 結果が failed にならない。
- 監査失敗がアプリログに記録され、秘密値が含まれない。

---

### R-11 スキャンの single-flight / ポーリング制御

`apps/web/app/page.tsx:190-198` は 10 秒ごとに `/api/ports` を呼び、`apps/api/src/ports/scanner.ts:209-228` はスキャンをグローバルに直列化している。スキャンが 10 秒を超えると、ポーリングのたびにリクエストが queue に積まれる。

**変更**

- `scanner.ts` に同一オプションの single-flight を追加する。
  - 同一 `scope` / `distro` / `includeStopped` の実行中 Promise を共有する。
  - 異なるオプションは従来どおり直列 queue に置く。
- `apps/web` の `load()` に in-flight フラグまたは `AbortController` を追加し、前回未完了なら次のポーリングをスキップする。
- 短時間のスキャン結果キャッシュ（例: 2〜3 秒）を検討する。ポート画面の 10 秒ポーリングと手動再スキャンの競合を減らす。

**テスト**

- 同時に 3 回 `scanAndPersist` を呼んでも `scanPorts` が 1 回だけ実行される。
- 10 秒を超えるスキャン中にポーリングが重複しない。
- 手動再スキャンは実行中表示を維持する。

---

### R-12 初回生成 admin パスワードをログに出さない

`apps/api/src/app.ts:109-114` は、開発環境で生成した初期 admin パスワードを構造化ログに含めている。本番では `ADMIN_PASSWORD` 必須のため発生しないが、開発ログの共有・収集時に秘密情報が残る。

**変更**

- 生成パスワードを `app.log` に出さない。
- 既定では `ADMIN_PASSWORD` を必須にする。
- 開発用に生成する場合も、ログではなく制限されたローカル TTY または `0600` の一時ファイルに限定する。
- ログには「初期管理者を作成した。パスワードは指定の安全な経路で確認すること」だけを出す。

**テスト**

- 初回起動ログに生成パスワードが含まれない。
- `ADMIN_PASSWORD` 未設定時の挙動が環境ごとに期待どおり。
- 監査ログ・エラーログに秘密値が含まれない。

---

## 6. 実装順とコミット分割

P0 を先に完了し、P1 / P2 は独立性の高い単位で分ける。

| 順序 | コミット / PR の単位               | 内容                                             | 依存 |
| ---- | ---------------------------------- | ------------------------------------------------ | ---- |
| 1    | `R-01` + `R-02` の契約変更         | `scanErrors` 追加、スコープ別エラー、API 200/503 | -    |
| 2    | `R-01` WSL 検出の遅延化            | `scope=windows` の WSL 非依存化                  | 1    |
| 3    | `R-02` Windows 失敗の局所化        | Windows task の catch、timing 非作成             | 1    |
| 4    | `R-03` プロセス生死三値化          | `exec.ts` エラー型、`process.ts`、`manager.ts`   | 1    |
| 5    | `R-04` Windows ヘルスチェック      | `cross-spawn`、cwd / env、`.cmd`                 | 4    |
| 6    | `R-05` tailer ネガティブキャッシュ | 起動時 per-source エラー分離                     | -    |
| 7    | `R-06` ファイルログデコード        | Buffer + `ProcessLineDecoder`                    | 5    |
| 8    | `R-07` `runFile` 診断改善          | `ExternalCommandError`、UTF-16 判定              | 4    |
| 9    | `R-08` 空出力の失敗扱い            | Windows 履歴保護                                 | 2    |
| 10   | `R-09` WSL `allSettled`            | `ps` 失敗時の部分結果                            | -    |
| 11   | `R-10` 監査ログ分離                | transaction / best-effort audit                  | -    |
| 12   | `R-11` single-flight               | API / Web のポーリング制御                       | 1    |
| 13   | `R-12` パスワードログ削除          | 初回 bootstrap                                   | -    |

> `R-01` と `R-02` は同じ `scanErrors` 契約を使うため、1 つの PR にまとめてもよい。P0 の 2 件は最優先で、P1 以降より先に完了させる。

---

## 7. テストマトリクス

| ケース                                   | 期待                                          |
| ---------------------------------------- | --------------------------------------------- |
| WSL 無効 + `scope=windows`               | 200、Windows 行あり、WSL timing なし          |
| WSL 無効 + `scope=all`                   | 200、Windows 行あり、WSL の `scanErrors` あり |
| WSL 無効 + `scope=wsl`                   | 503、500 ではない                             |
| Windows スキャン失敗 + WSL 成功          | 200、WSL 行あり、Windows 履歴維持             |
| Windows スキャン失敗 + `scope=windows`   | 503、500 ではない                             |
| Windows スキャン空出力                   | 失敗扱い、Windows 履歴維持                    |
| WSL の `kill -0` が exit 1               | `dead`                                        |
| WSL コマンド起動失敗 / timeout           | `unknown`                                     |
| WSL 障害中の API 再起動                  | サービスを `stopped` にしない、PID を消さない |
| Windows command ヘルスチェック `.cmd`    | 成功                                          |
| Windows command ヘルスチェック cwd / env | 成功                                          |
| Shift-JIS ファイルログ                   | 日本語が正しく保存される                      |
| UTF-8 → Shift-JIS フォールバック         | 文字化けしない                                |
| WSL 日本語 UTF-16LE エラー               | 正しくデコードされる                          |
| PowerShell 空出力                        | 履歴を閉じない                                |
| WSL `ps` 失敗 / `ss` 成功                | ポート行を返す                                |
| 監査ログ失敗 + service start             | API 成功、action succeeded                    |
| 監査ログ失敗 + port reserve              | API 成功、予約作成                            |
| 10 秒超スキャン + 3 回ポーリング         | スキャンは 1 回、queue が増えない             |
| 初回 admin bootstrap                     | ログに生成パスワードが出ない                  |

---

## 8. 検証コマンド

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm --filter @sys4sys/api test
```

追加で、WSL を無効化した環境の手動確認を行う。

```text
1. WSL を無効化、または wsl.exe が失敗する状態にする。
2. GET /api/ports?scope=windows が 200 になることを確認する。
3. GET /api/ports?scope=all が 200 で Windows 行を返し、WSL の警告を含むことを確認する。
4. POST /api/ports/reserve で Windows ポートを予約できることを確認する。
5. 既存の WSL ポート履歴が閉じられていないことを DB で確認する。
6. WSL を復旧し、次回スキャンで WSL 行が戻ることを確認する。
```

WSL が利用できる環境では、以下も確認する。

```text
1. distro を停止した状態で、停止中 distro が暗黙起動されない。
2. WSL サービス停止後の API 再起動で、PID と状態が誤って消えない。
3. 日本語の WSL エラーがログで文字化けしない。
4. WSL のファイルログ（UTF-8 / Shift-JIS）が正しく取り込まれる。
```

---

## 9. リスクと戻し方

| リスク                                              | 影響                   | 対策 / 戻し方                                                                      |
| --------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `scanErrors` 追加で Web / CLI の型が壊れる          | 画面・CLI のビルド失敗 | 追加フィールドは default 付き。Web 型を同時更新                                    |
| 部分成功を 200 にすることで競合を見落とす           | 予約の誤判定           | 予約対象スコープが未スキャンなら fail-closed（503）                                |
| `isProcessAlive` 三値化で既存呼び出しが壊れる       | サービス状態監視の停止 | 呼び出し箇所を型エラーで洗い出し、unknown の扱いをテスト                           |
| WSL ネガティブキャッシュで復旧が遅れる              | ログ tail の再開遅延   | TTL を 30 秒程度にし、手動 refresh ではキャッシュを無効化                          |
| ファイルログの Buffer 化で offset がずれる          | ログ欠損 / 重複        | `ProcessLineDecoder` の保留バイトと offset を分離し、切り詰めテストを追加          |
| 監査を best-effort にすることで監査要件を満たせない | コンプライアンス       | 秘密値開示は fail-closed。それ以外は警告ログを残し、必要なら DB transaction を追加 |
| single-flight で手動再スキャンが待たされる          | UX 低下                | 手動更新は実行中表示を出し、同一スキャンの完了を共有する                           |

---

## 10. 決定事項（実装済み）

実装時に採用した方針。当初の既定案から、開発時の扱いだけ現実的な値へ修正した。

| 項目                                  | 実装方針                                                          | 根拠 |
| ------------------------------------- | ----------------------------------------------------------------- | ---- |
| 部分スキャン時の `/api/ports/reserve` | 対象スコープ未取得なら 503。対象外スコープのみ不明なら 200 + 警告 | R-01 |
| 監査ログ失敗時の運用                  | 外部操作は best-effort。秘密値開示は fail-closed                  | R-10 |
| 初回 admin パスワード                 | 本番は `ADMIN_PASSWORD` 必須。開発時はログではなく制限ファイル    | R-12 |
| WSL 検出失敗の TTL                    | 30 秒                                                             | R-05 |
| スキャン結果共有                      | 実行中の同一オプションだけを共有。完了後の cache は未導入         | R-11 |
| WSL `ps` 失敗時の扱い                 | `ss` 成功ならポート行を返し、process 情報は null                  | R-09 |

---

## 11. 実装チェックリスト

### P0

- [x] `scanErrors` を shared schema に追加
- [x] `scope=windows` で WSL 検出を呼ばない
- [x] WSL 一覧失敗を `scanErrors` に変換
- [x] Windows タスクの reject を局所化
- [x] 失敗スコープに `timings` を作らない
- [x] `/api/ports` の部分成功 200 / 全失敗 503
- [x] reserve / kill-token / kill のスコープ別エラー
- [x] Web の `scanErrors` 表示
- [ ] WSL 無効環境の手動確認（単体テストで代替。実機の無効化確認は未実施）
- [x] WSL 有効環境で `scope=windows` / `scope=all` の実スキャンを確認

### P1

- [x] `ExternalCommandError` と `ProcessLiveness`
- [x] `reconcileServices` の unknown 対応
- [x] `waitForDeath` の unknown 対応
- [x] Windows command ヘルスチェックの `cross-spawn` / cwd / env / `.cmd`
- [x] tailer のネガティブキャッシュ
- [x] ファイルログの UTF-8 / Shift-JIS ストリーミングデコード
- [x] `runFile` の stdout / stderr / exit code 診断
- [x] 各修正の回帰テスト

### P2

- [x] 空 PowerShell 出力の失敗扱い
- [x] WSL `ss` / `ps` の `allSettled`
- [x] 監査ログの best-effort 化（外部操作を失敗させない）
- [x] スキャン single-flight と Web ポーリング制御
- [x] admin パスワードのログ出力停止

### 最終確認

- [x] `pnpm format:check`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [ ] WSL 無効 / 有効の両環境で API を確認（WSL 有効の実スキャンのみ確認済み）
- [ ] 既存の CLI / Web UI の主要操作が無回帰（手動確認待ち）
