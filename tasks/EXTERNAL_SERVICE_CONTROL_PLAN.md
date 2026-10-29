# sys4sys 外部サービス制御 実装計画

- 版: v1.0
- 作成日: 2026-10-29
- 基準: `main` / `63d512a`
- 対象: `apps/api`, `apps/agent`, `apps/cli`, `apps/web`, `packages/shared`
- ステータス: 実装完了（コード・テスト・ドキュメント更新済み / NSSM 実機検証: start / stop / restart / deploy owner / log sources / crash incident 済み）
- 前提: NSSM / WinSW / ネイティブ Windows サービスは、すべて Windows SCM 管理の外部サービスとして扱う。

---

## 0. 目的

NSSM などでサービス化された API を、sys4sys から安全に管理できるようにする。

最優先事項は次の 3 点。

1. **サービス名を同一性の基準**にし、PID や親子関係に依存しない。
2. sys4sys と deploy スクリプトの**stop / start の所有者を一意**にする。
3. 既存の spawn 管理サービスと WSL 管理を壊さず、段階的に移行できるようにする。

### 非ゴール

- NSSM のインストール・削除・設定変更を sys4sys から行うこと。
- Windows Event Log の新規ログソース対応。
- WSL systemd の実装（アダプタ設計のみ将来対応）。
- blue-green / 無停止デプロイ。
- サービスアカウントのパスワード管理。
- NSSM を sys4sys のプロセス管理へ置き換えること。

---

## 1. 現状の課題

### 1.1 現在のサービス管理

`apps/api/src/services/manager.ts` は、次の前提で実装されている。

- `service.command` を `spawn()` して起動する
- 起動した子プロセスの PID を `services.pid` に保存する
- 停止は `taskkill /T /F` を基本とする
- stdout / stderr をパイプで受けてログ保存する
- 再起動時は保存 PID の生死で状態を復元する
- `reconcileServices()` は停止中・失敗中で PID がないサービスをスキップする

NSSM サービスでは、この前提が成立しない。

- 実際の API は `nssm.exe` の子プロセスとして動く
- SCM / NSSM の再起動で PID が変わる
- API の子プロセスを kill すると NSSM が自動再起動する
- stdout / stderr は spawn パイプではなく、`AppStdout` / `AppStderr` ファイルになる
- `reconcileServices()` が PID なしのサービスをスキップすると、SCM 上は Running でも sys4sys は Stopped のままになる

### 1.2 現在の deploy

`apps/api/src/services/deploy.ts` は、次の順序で動く。

```text
deploy.command を spawn
  ↓
成功したら restartAfter=true なら restartService()
  ↓
healthTimeoutSec の間ヘルスチェック
```

NSSM サービスで deploy.ps1 が stop / start まで行う場合、`restartAfter=true` のままだと二重再起動になる。

また、現在の deploy は**コマンド実行前にサービスを停止しない**。NSSM サービスのように実行ファイルをロックする場合、deploy.ps1 側で停止するか、sys4sys 側に停止フェーズを追加する必要がある。

### 1.3 現在の多重実行防止

`apps/api/src/services/deploy.ts` の `activeDeploys` は in-memory の Set で、DB の running action チェックと併用されている。

ただし、次の操作はデプロイ中でも止められない。

- `POST /api/services/:id/start`
- `POST /api/services/:id/stop`
- `POST /api/services/:id/restart`
- `ports kill`
- インシデントからの自動再起動
- `reconcileServices()` の autoStart

外部サービスでは、デプロイ中にこれらが動くと「停止した直後に起動し直す」事故になる。

### 1.4 既存 deploy.ps1 との衝突

`apps/demo-api/deploy.ps1` は、ビルド後に `POST /api/services/:id/restart` を呼び、sys4sys 経由でサービスを再起動している。

- `serviceControlOwner=sys4sys` の deploy 中にこの API を呼ぶと、deploy lock により 409 になる。
- lock を一時的に無視したとしても、sys4sys の stop / start と API restart が二重になる。
- `serviceControlOwner=script` でも、sys4sys API の restart は「スクリプトが SCM を直接制御する」という契約と一致しない。

そのため、外部サービス用の deploy スクリプトは次のどちらかに統一する。

- `sys4sys`: スクリプトは stop / start をしない。`-NoRestart` / `-NoServiceControl` 相当でサービス制御をスキップする。
- `script`: スクリプトが `Stop-Service` / `Start-Service` を直接実行する。sys4sys API の restart は呼ばない。

既存の `apps/demo-api/deploy.ps1` は、外部サービス用の実装に合わせて更新対象とする。

---

## 2. 基本設計

### 2.1 用語

| 用語                         | 意味                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `controlMode`                | サービスの制御方式。`spawn` または `windows-service`         |
| `serviceName`                | Windows SCM のサービス名。外部サービスモードでは必須         |
| `deploy.serviceControlOwner` | deploy 時の stop / start の所有者。`sys4sys` または `script` |
| 外部サービスモード           | `controlMode=windows-service` のサービス                     |
| deploy lock                  | 同一サービスの deploy と手動操作を排他する仕組み             |
| controller                   | SCM を操作するアダプタ                                       |

### 2.2 単一所有者原則

**1 つのサービスについて、deploy 時の stop / start は必ずどちらか一方だけが行う。**

| `serviceControlOwner` | サービス停止      | deploy.command   | サービス起動      | ヘルスチェック                             |
| --------------------- | ----------------- | ---------------- | ----------------- | ------------------------------------------ |
| `sys4sys`             | sys4sys           | ビルド・配置のみ | sys4sys           | sys4sys                                    |
| `script`              | deploy スクリプト | 停止・配置・起動 | deploy スクリプト | deploy スクリプト + sys4sys の読み取り確認 |

- `sys4sys`: sys4sys が SCM 経由で停止・起動する。スクリプトはサービス制御をしない。
- `script`: スクリプトがサービス制御まで行う。sys4sys は deploy 前後の stop / start をしない。
- 手動の start / stop / restart は、所有者にかかわらず sys4sys の controller が担当する。`serviceControlOwner` は **deploy ライフサイクル専用** とする。

### 2.3 サービス同一性

- 外部サービスモードでは `serviceName` を同一性の基準にする。
- `services.pid` は「最後に観測した PID」として扱い、状態判定の主キーにしない。
- NSSM のラッパー PID とアプリ本体の PID は一致しないことがある。
- 状態判定は SCM の状態を優先する。
- ポート所有者とサービスの紐付けは `expectedPorts` を基本にし、必要なら PID / プロセスツリーで補助する。

### 2.4 状態モデル

SCM の状態を次のようにマッピングする。

| SCM 状態                    | sys4sys status                              |
| --------------------------- | ------------------------------------------- |
| `Running`                   | `running`                                   |
| `Stopped`                   | `stopped`                                   |
| `Start Pending`             | `starting`                                  |
| `Stop Pending`              | `stopping`                                  |
| `Paused` / `Paused Pending` | `degraded`                                  |
| 照会失敗 / タイムアウト     | `unknown` 相当。現在の status と PID を保持 |

`stopping` をサービス status に追加する。  
`serviceListQuerySchema` だけでなく、`packages/shared/src/ports.ts` の `serviceStatusSchema`、`apps/api/src/db/schema.ts` の status enum、`apps/cli/src/mcp/schema.ts`、`apps/cli/src/commands/services.ts` の running 判定、Web の status union も同時に更新する。

### 2.5 エラー方針

- サービス不存在（`1060`）: `failed`。`lastError` に「サービスが見つかりません」。
- アクセス拒否（`5`）: API は `503`。`lastError` に権限不足を記録。
- すでに起動済み（`1056`）: 成功扱い。状態を再照会する。
- すでに停止済み（`1062`）: 成功扱い。
- タイムアウト: `unknown` とし、勝手に `stopped` にしない。
- 照会失敗: 現在の status / PID を保持し、`lastError` のみ更新する。

### 2.6 WSL 非依存

- `controlMode=windows-service` は `host.kind=windows` のサービスだけを対象にする。
- WSL が使えない環境でも、Windows サービスの登録・状態取得・start / stop / restart / deploy は継続できる。
- `reconcileServices()` で WSL ホストの照会に失敗しても、そのサービスだけ `unknown` とし、Windows サービスの処理は止めない。
- WSL systemd 対応は将来の controller 追加で行い、Windows SCM の実装に混ぜない。

---

## 3. データモデル

### 3.1 `services` テーブル

追加するカラム:

```text
control_mode TEXT NOT NULL DEFAULT 'spawn'
  spawn | windows-service
service_name TEXT NULL
  Windows SCM のサービス名
```

制約:

- `control_mode=windows-service` のとき、API バリデーションで `service_name` を必須にする。
- `(host_id, service_name)` に部分 unique index を追加する。`service_name IS NULL` は除外する。
- Windows のサービス名は大文字小文字を区別しないため、重複判定は case-insensitive にする。DB index は `COLLATE NOCASE` または `lower(service_name)` の式 index を使う。
- `service_name` は前後空白を trim する。1〜256 文字。`/`、`\`、制御文字を禁止する。空白は許可する。
- `control_mode=windows-service` は `host.kind=windows` のときだけ許可する。
- `services.name` は sys4sys の表示名、`service_name` は SCM のサービス名であり、別物として扱う。
- P0 では `service.command` を既存 schema 互換のため必須のまま残す。外部サービスでは実行しない。

既存行は `control_mode='spawn'`、`service_name=NULL` で移行する。

### 3.2 `deploy` JSON

`DeployConfigInput` に追加:

```text
serviceControlOwner: "sys4sys" | "script"
```

バリデーション:

- `controlMode=spawn`: `serviceControlOwner` は無視する。既存の `restartAfter` を使う。
- `controlMode=windows-service` かつ `deploy` が存在する: `serviceControlOwner` を必須にする。
- `serviceControlOwner=sys4sys`:
  - deploy 前に sys4sys が停止する。
  - deploy 後に sys4sys が起動する。
  - `restartAfter` は `true` 固定として扱う。
- `serviceControlOwner=script`:
  - `restartAfter=false` を強制する。
  - sys4sys は deploy 前後の stop / start をしない。
- `controlMode=spawn` 以外では、`service.command` をライフサイクルに使わない。
  - P0 では既存 schema 互換のため必須のまま残す。
  - UI では「表示用。外部サービスでは実行しない」と明記する。
  - `SERVICE_COMMAND_ALLOWLIST` は `spawn` と `deploy.command` にだけ適用する。
- 外部サービスの `deploy.command` は、sys4sys API の `/services/:id/restart` を呼ばない。
  - deploy lock により 409 になる。
  - 二重制御の原因になる。
  - 標準ラッパー PS1 の契約に従う。
- 外部サービスのプロセス環境変数は NSSM / WinSW 側で設定する。
  - `services.env` は health check の command 実行や既存互換のための値であり、外部サービス本体には注入されない。
  - `deploy.env` は deploy.command にだけ渡す。
  - UI / docs でこの違いを明記する。

### 3.3 `deploy_requests.snapshot`

承認後にサービス制御方式を変更されると、承認した内容と実行内容がずれる。  
そのため snapshot に次を追加する。

```text
controlMode
serviceName
serviceControlOwner
```

- `canonicalSnapshot()` と `snapshotsEqual()` に含める。
- 旧 snapshot は `controlMode=spawn`、`serviceName=null`、`serviceControlOwner=null` として扱う。
- `deployRequestSnapshotSchema` の新規フィールドは `.default()` または `.optional()` で旧データを読めるようにする。
- 承認時に現在値と一致しなければ 409。
- `deployAuditValue()` にも `serviceControlOwner` を追加する。秘密値は追加しない。

### 3.4 deploy lock

同一サービスの deploy を DB レベルで 1 つに制限する。

部分 unique index:

```sql
CREATE UNIQUE INDEX actions_one_running_deploy
ON actions(service_id)
WHERE type = 'deploy'
  AND (status = 'pending' OR status = 'running');
```

- `beginDeploy()` の insert 時に unique 競合したら 409。
- `finally` で action を succeeded / failed に更新し、lock を解放する。
- API 再起動時は `reconcileDeployments()` が running を failed にする。
  - P0 の基本運用は単一 API インスタンスとする。
  - ただし unique index により、複数インスタンスでも deploy の二重実行は防ぐ。
  - 起動時の reconciliation は `startedAt` が `DEPLOY_STALE_MS` より古い action だけを failed にし、別インスタンスの実行中 deploy を誤って失敗させない。
  - 厳密な lease / heartbeat は P1 の課題とする。
- migration 前に running の deploy が残っていないことを確認する。残っている場合は migration 前に failed へ確定する。

### 3.5 マイグレーション

`apps/api/drizzle/0007_*.sql` を追加する。

内容:

1. `services.control_mode` 追加
2. `services.service_name` 追加
3. `(host_id, service_name)` の部分 unique index 追加
4. `actions` の部分 unique index 追加

`pnpm db:generate` で生成し、SQL を手動レビューする。  
Drizzle が部分 unique index を生成できない場合は、migration SQL を手書きする。  
`status` の `stopping` はアプリケーション enum の追加であり、SQLite の CHECK 制約変更は不要。  
既存データの backfill は行わない（`control_mode='spawn'` で十分）。

### 3.6 リリースとロールバック

1. DB をバックアップする。
2. running / pending の deploy がないことを確認する。
3. migration を適用する。
4. API を更新する。
5. 既存 spawn サービスの start / stop / restart / deploy を確認する。
6. テスト用の外部サービスを 1 件だけ登録し、状態取得と start / stop を確認する。
7. 問題がなければ、サービス単位で `controlMode=windows-service` を有効化する。

ロールバック:

- 外部サービスを停止し、`controlMode=spawn` に戻す。
- 旧 API は追加カラムを無視できるため、DB の追加カラムは残したままコードを戻せる。
- `deploy.serviceControlOwner` は旧 API では未知フィールドとして無視される。
- `actions` の部分 unique index は残しても既存動作に影響しない。

---

## 4. モジュール設計

### 4.1 `apps/api/src/services/service-control.ts`（新規）

SCM 操作のアダプタ。

```ts
export type ExternalServiceState =
  "running" | "stopped" | "starting" | "stopping" | "degraded" | "unknown";

export interface ServiceInspection {
  state: ExternalServiceState;
  pid: number | null;
  exitCode: number | null;
  detail?: string;
}

export interface ServiceController {
  inspect(service: ServiceRow): Promise<ServiceInspection>;
  start(service: ServiceRow): Promise<ServiceInspection>;
  stop(service: ServiceRow): Promise<ServiceInspection>;
  restart(service: ServiceRow): Promise<ServiceInspection>;
}
```

実装:

- `WindowsServiceController`
  - 状態取得は PowerShell CIM で JSON を取得する。
  - `Get-CimInstance Win32_Service` の `Name` / `State` / `ProcessId` / `ExitCode` を使う。
  - サービス名はコマンド文字列へ連結せず、環境変数 `SYS4SYS_SERVICE_NAME` で渡す。
  - start / stop は `sc.exe` を引数配列で実行する。
  - `sc.exe` の exit code をマッピングする。
  - 開始・停止後は `SERVICE_CONTROL_POLL_MS` 間隔で状態を再照会する。
  - タイムアウトは `SERVICE_CONTROL_TIMEOUT_MS`。
- `getServiceController(service)`:
  - `controlMode=windows-service` のとき `WindowsServiceController`
  - それ以外は `null`
- `inspect` 失敗時は `unknown`。例外は API 層で 503 に変換する。

`runFile()` は `@sys4sys/agent` の既存実装を使い、シェル文字列を組み立てない。

### 4.2 `apps/api/src/services/deploy-lock.ts`（新規）

循環 import を避けるため、deploy 状態の照会を独立モジュールに置く。

```ts
export async function hasRunningDeploy(serviceId: string): Promise<boolean>;
export function isLocalDeployRunning(serviceId: string): boolean;
```

- `hasRunningDeploy()` は DB の `actions` を参照する。
- in-memory の `activeDeploys` は即時ガードとして残す。
- manager / monitoring / routes はこのモジュールを参照する。

### 4.3 `apps/api/src/services/manager.ts` の変更

#### startService

- `controlMode=windows-service` の場合は `controller.start()` を呼ぶ。
- `spawn()` は使わない。
- 起動後 `inspect()` して `services.pid` を更新する。
- runtime は `child=null`、`adopted=true` として作成する。
- サービス制御の監査ログを残す。

#### stopService

- 外部サービスは `controller.stop()` を呼ぶ。
- `taskkill` / `signalStop` / `waitForDeath` は使わない。
- 停止後 `inspect()` し、`status=stopped`、`pid=null` にする。
- 503 / 409 のマッピングは controller のエラーに従う。

#### restartService

- 外部サービスは `controller.restart()` を呼ぶ。
- deploy から呼ばれる場合も同じ controller を使う。
- 手動操作の場合は deploy lock を確認し、running なら 409。

#### reconcileServices

- 外部サービスは PID の有無に関係なく必ず `inspect()` する。
- `status=stopped` / `pid=null` でもスキップしない。
- Running なら runtime を adopted で作成し、health timer を開始する。
- Stopped なら status を stopped にし、PID を消す。
- 照会失敗は unknown とし、status / PID を保持する。
- `SERVICE_AUTOSTART_ON_BOOT` の対象から外部サービスを除外する。起動は SCM に任せる。
- `autoStart=true` の外部サービスには警告ログを出す。
- deploy lock があるサービスは、状態の観測だけ行い、status / PID の更新は deploy 側に任せる。
- 外部サービスの `process` health check は SCM 状態を正とし、保存 PID の生死だけで判定しない。

#### runtimeInfo

`controlMode`、`serviceName`、`serviceState` を返せるようにする。  
Web / CLI が「外部サービス」であることを表示できるようにする。

### 4.4 `apps/api/src/services/deploy.ts` の変更

#### 共通

- `runDeploy()` の冒頭で deploy lock を確認する。
- サービスが `windows-service` の場合、`deploy.serviceControlOwner` を検証する。
- deploy 中は `services.status` をフェーズに合わせて `stopping` / `starting` / `running` に更新する。`restarting` は使わない。
- deploy の各フェーズを `[deploy]` ログに出す。
- deploy.command から sys4sys API の service restart を呼ばせない。deploy lock と二重制御の両面で禁止する。
- 外部サービスの `waitForHealthy()` は `unknown` を成功扱いにしない。healthCheck 設定時は `healthy` 必須、未設定時は SCM `Running` 必須とする。

#### `serviceControlOwner=sys4sys`

```text
1. controller.stop()
2. 停止確認
3. deploy.command 実行
4. controller.start()（成功・失敗にかかわらず）
5. 起動確認
6. health check
7. action の最終 status を決定
```

- deploy.command には次の環境変数を渡す。
  - `SYS4SYS_SERVICE_CONTROL=sys4sys`
  - `SYS4SYS_DEPLOY_ACTION_ID`
  - `SYS4SYS_SERVICE_NAME`
- スクリプトには `-NoServiceControl` を付ける運用を推奨する。
- stop がタイムアウト / unknown の場合は deploy.command を開始しない。ファイルロックのままデプロイする事故を防ぐ。
- deploy.command が失敗しても、サービスを停止したままにしない。
  - 既定では `controller.start()` を試みる。
  - 起動に失敗した場合は action を failed にし、`lastError` に起動失敗を記録する。
- health check が失敗した場合は action を failed にする。自動ロールバックは行わない。
- サービス停止中に API が落ちた場合は、起動時に自動起動しない。`reconcileDeployments()` で failed とし、手動対応を要求する。

#### `serviceControlOwner=script`

```text
1. deploy.command 実行
2. sys4sys は stop / start をしない
3. コマンド成功後に health check（読み取りのみ）
4. action の最終 status を決定
```

- `restartAfter` は強制的に false とする。
- deploy.command には `SYS4SYS_SERVICE_CONTROL=script`、`SYS4SYS_DEPLOY_ACTION_ID`、`SYS4SYS_SERVICE_NAME` を渡す。
- スクリプトの終了コードを deploy の成否とする。
- スクリプトが停止・起動・ロールバック・ヘルスチェックを担当する。
- sys4sys の health check は追加確認として行う。失敗してもサービス制御はしない。

#### deploy 失敗時

- `sys4sys` モード: 可能ならサービスを起動し、状態を確認する。起動できなければ failed。
- `script` モード: スクリプトの責任。sys4sys は状態を確認するだけ。
- 監査ログ `service.deploy.failed` に `serviceControlOwner` と `serviceName` を残す。

### 4.5 `apps/api/src/routes/services.ts` の変更

- `serviceCreateSchema` / `serviceUpdateSchema` に `controlMode` / `serviceName` を追加。
- `serviceResponse` に `controlMode` / `serviceName` を追加。
- `deployDetail` / `deploySummary` に `serviceControlOwner` を追加。
- `deployAuditValue` に `serviceControlOwner` を追加。
- `create` / `update` で外部サービスのバリデーションを行う。
- `performAction` の開始前に deploy lock を確認し、409 を返す。
- 外部サービスの start / stop / restart は manager の controller 経由で実行する。
- create / update を含む監査ログに `controlMode` と `serviceName` を追加する。

### 4.6 `apps/api/src/routes/ports.ts` の変更

`ports kill` と kill-token 発行時に、対象ポートが外部サービスに属するか確認する。

- `expectedPorts` にポートが含まれる外部サービスがある場合、409 を返す。
- Problem Details に `serviceId` / `serviceName` / `serviceControlOwner` を含める。
- 利用者には `services stop` を案内する。
- `ports kill` で NSSM の自動再起動を誘発しない。
- デプロイ中のサービスは 409 とする。
- `expectedPorts` が未設定の場合は保護が best-effort になるため、外部サービスでは設定を必須に近い運用ルールとする。

### 4.7 `apps/api/src/monitoring/incidents.ts` の変更

- 自動再起動の前に deploy lock を確認する。
- deploy 中は自動再起動しない。
- 外部サービスの再起動は `restartService()` 経由で controller を使う。
- NSSM の自動復旧と sys4sys の自動再起動が二重にならないよう、`autoRestartPhase=observe` を推奨する。

### 4.8 `packages/shared/src/api.ts` の変更

- `controlModeSchema`
- `serviceName` のバリデーション
- `serviceControlOwnerSchema`
- `deployConfigSchema` に `serviceControlOwner`
- `serviceCreateSchema` / `serviceUpdateSchema` に `controlMode` / `serviceName`
- `serviceListQuerySchema` の status に `stopping`
- `packages/shared/src/ports.ts` の `serviceStatusSchema` に `stopping`
- `deployRequestSnapshotSchema` に `controlMode` / `serviceName` / `serviceControlOwner`

### 4.9 CLI

- `apps/cli/src/types.ts` の `Service` / `DeployConfig` を更新する。
- `apps/cli/src/mcp/schema.ts` の status enum に `stopping` を追加する。
- `apps/cli/src/commands/services.ts` の running 判定に `stopping` を追加する。
- `services get` / `services list` の表示に `controlMode` / `serviceName` を追加する。
- `services create` / `update` は JSON ファイル経由なので schema 追加で入力可能にする。
- 必要なら `--control-mode` / `--service-name` を追加するが、P0 では必須としない。
- `docs/cli-schema.json` を再生成する。
- CLI の schema / output テストを更新する。

### 4.10 Web

- `apps/web/app/services/page.tsx` の型とフォームを更新する。
- `controlMode` / `serviceName` を表示・編集できるようにする。
- `serviceControlOwner` を deploy 設定に追加する。
- 外部サービスでは `restartAfter` を直接編集させず、所有者から導出した説明を表示する。
- `command` は「表示用。外部サービスでは実行しない」と明記する。
- status の union / 色分けに `stopping` を追加する。
- 外部サービスのログは NSSM のファイルログを `log_sources` に登録する必要がある旨を表示する。
- NSSM の `AppStdout` / `AppStderr` / `AppRotateFiles` と、sys4sys の `log_sources` のパスを運用手順に明記する。

### 4.11 標準ラッパー PS1 の契約

NSSM / WinSW の deploy スクリプトは、次の契約に従う標準テンプレートを用意する。

```powershell
[CmdletBinding()]
param(
  [string]$ServiceName = $env:SYS4SYS_SERVICE_NAME,
  [switch]$NoServiceControl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$owner = $env:SYS4SYS_SERVICE_CONTROL

function Test-Sys4SysControlsService {
  return ($owner -eq "sys4sys") -or $NoServiceControl
}

function Wait-ServiceState {
  param(
    [string]$Name,
    [string]$Target,
    [int]$TimeoutSec = 60
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $service = Get-Service -Name $Name -ErrorAction Stop
    if ($service.Status -eq $Target) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "service $Name did not reach $Target"
}

if (-not (Test-Sys4SysControlsService)) {
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($service.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
    Wait-ServiceState -Name $ServiceName -Target "Stopped"
  }
}

# ここでビルド・配置・マイグレーションを行う。
# 失敗時は throw し、必要なら旧成果物へロールバックする。

if (-not (Test-Sys4SysControlsService)) {
  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  if ($service.Status -ne "Running") {
    Start-Service -Name $ServiceName
    Wait-ServiceState -Name $ServiceName -Target "Running"
  }
  # 必要なら HTTP / TCP のヘルスチェックをここで行う。
}
```

契約:

- `SYS4SYS_SERVICE_CONTROL=sys4sys` のとき、スクリプトは stop / start をしない。
- `SYS4SYS_SERVICE_CONTROL=script` のとき、スクリプトが stop / start / health を担当する。
- どちらの場合も sys4sys API の `/services/:id/restart` を呼ばない。
- サービス名は `SYS4SYS_SERVICE_NAME` または引数で受け取り、`nssm.exe` のプロセス名ではなく SCM のサービス名を使う。
- 停止・起動は冪等にする。すでに Stopped / Running なら何もしない。
- `taskkill` を使わない。
- 失敗時は非 0 で終了し、必要ならロールバックする。
- stdout / stderr に秘密値を出さない。
- `apps/demo-api/deploy.ps1` は、この契約に合わせて `-NoRestart` と `-NoServiceControl` の扱いを整理する。

### 4.12 設定値

`apps/api/src/config.ts` に次を追加する。

| 設定                         | 既定値   | 用途                                            |
| ---------------------------- | -------- | ----------------------------------------------- |
| `SERVICE_CONTROL_TIMEOUT_MS` | `30000`  | SCM の start / stop 待ち上限                    |
| `SERVICE_CONTROL_POLL_MS`    | `500`    | SCM 状態の再照会間隔                            |
| `DEPLOY_STALE_MS`            | `900000` | 起動時に failed とみなす deploy の古さ          |
| `SELF_SERVICE_NAME`          | 未設定   | sys4sys 自身の SCM サービス名。自己停止ガード用 |

秘密値ではないため、監査ログや API レスポンスに含めてもよい。ただし `SELF_SERVICE_NAME` は運用情報なので、UI では管理者だけに表示する。

---

## 5. バリデーション

### 5.1 サービス作成・更新

- `controlMode=windows-service` のとき:
  - `serviceName` 必須
  - `host.kind=windows` 必須
  - `serviceName` の形式チェック
  - `(host_id, service_name)` の重複チェック
- `controlMode=spawn` のとき:
  - `serviceName` は null または未指定
  - 既存の `command` allowlist を適用
- `controlMode=windows-service` のとき:
  - `service.command` はライフサイクルに使わない
  - `SERVICE_COMMAND_ALLOWLIST` は適用しない
  - `deploy.command` には allowlist を適用する
- `controlMode` または `serviceName` の変更は、サービスが停止中のときだけ許可する。
  - 実行中に変更すると、古い runtime / PID / SCM サービスを見失う。
  - 実行中に変更要求があった場合は 409 とし、先に stop を案内する。
  - 変更時は runtime をクリアし、次回 reconcile で新しい serviceName を観測する。

### 5.2 deploy 設定

- `controlMode=windows-service` かつ `deploy` がある:
  - `serviceControlOwner` 必須
- `serviceControlOwner=script`:
  - `restartAfter=false` を強制
- `serviceControlOwner=sys4sys`:
  - `restartAfter=true` を強制
- `controlMode=spawn`:
  - `serviceControlOwner` は無視
  - 既存の `restartAfter` を維持

### 5.3 実行時

- deploy 中は手動 start / stop / restart を 409。
- deploy 中は `ports kill` / kill-token を 409。
- deploy 中は自動再起動をスキップ。
- deploy 中は `reconcileServices()` の autoStart をスキップ。
- 外部サービスの `start` / `stop` / `restart` は deploy lock を確認する。
- 内部の deploy オーケストレーションだけが lock を保持したまま controller を呼べる。

---

## 6. セキュリティ

### 6.1 サービス名

- サービス名は DB に登録された値だけを使う。
- `sc.exe` / PowerShell へ渡すときは引数配列または環境変数を使い、シェル文字列を組み立てない。
- サービス名の制御文字・パス区切りを拒否する。
- 管理者だけがサービスを登録・更新できる既存の権限を維持する。

### 6.2 権限

- sys4sys の実行アカウントにサービス制御権限が必要。
- 権限不足は 503 とし、成功扱いにしない。
- ラッパー PS1 が同じアカウントで動く場合、stop / start を完全には禁止できない。
- 完全な強制が必要な場合は、deploy 実行アカウントをサービス制御権限なしにし、sys4sys の privileged broker 経由に限定する。これは P2 の任意 hardening とする。

### 6.3 逸脱検知

- `serviceControlOwner=sys4sys` の deploy 中、サービス状態が期待値（停止中）から外れたら `service.control.violation` を記録する。
- 逸脱時は deploy を failed にし、状態を再確認する。
- `serviceControlOwner=script` では sys4sys が stop / start を呼ばないことをテストで保証する。

### 6.4 監査

- `service.start` / `service.stop` / `service.restart` に `controlMode` / `serviceName` を追加。
- `service.deploy` / `service.deploy.failed` に `serviceControlOwner` を追加。
- `service.control.violation` を追加。
- env / deploy.env の値は監査ログに出さない。
- 外部操作の監査失敗は既存の `tryWriteAudit()` 方針に従う。

### 6.5 自己管理

sys4sys 自身を外部サービスとして管理する場合、API から自分を stop / restart するとレスポンスが返らない。

- P0 では `SELF_SERVICE_NAME` を設定した場合、対象が自分自身なら start / stop / restart / deploy を 409 にする。
- 比較は大文字小文字を無視する。
- 自己デプロイが必要な場合は、sys4sys の外側のオーケストレータから実行する。
- 将来、202 を返して遅延実行する自己再起動を検討する。

---

## 7. 実装フェーズ

### E-01: shared schema

- `controlMode` / `serviceName` / `serviceControlOwner`
- `stopping` status
- deploy request snapshot
- Zod の相関バリデーション
- 単体テスト

### E-02: DB migration

- `services.control_mode`
- `services.service_name`
- 部分 unique index
- `actions` の deploy lock index
- 既存行の互換確認

### E-03: service controller

- `service-control.ts`
- `WindowsServiceController`
- 状態取得、start / stop / restart、タイムアウト、エラーマッピング
- `runFile` を mock した単体テスト

### E-04: manager

- `startService` / `stopService` / `restartService` の外部サービス分岐
- `reconcileServices` の SCM 対応
- runtimeInfo の拡張
- `stopping` の扱い
- 既存 spawn の回帰テスト

### E-05: deploy lock

- `deploy-lock.ts`
- `actions` 部分 unique index
- 手動操作 / port kill / monitoring / autoStart のガード
- `reconcileDeployments()` の stale 判定
- 多重デプロイの競合テスト

### E-06: deploy フロー

- `serviceControlOwner=sys4sys`
- `serviceControlOwner=script`
- 環境変数 `SYS4SYS_SERVICE_CONTROL`
- 失敗時の起動、ヘルスチェック、監査
- deploy 中断時の reconciliation
- 複数インスタンス向けの stale 判定

### E-07: ports / monitoring

- `ports kill` / kill-token の外部サービス保護
- 自動再起動の deploy lock 対応
- `expectedPorts` によるサービス判定
- 監査ログ

### E-08: API routes

- create / update のバリデーション
- service response / deploy response
- action の 409
- エラー Problem Details
- API テスト

### E-09: CLI / Web / docs

- CLI 型・表示・schema 再生成
- Web フォーム・表示
- `docs/openapi.yaml`
- `docs/ER.md` の `services` / `services.deploy` 説明
- `.env.example` と README の環境変数一覧
- NSSM 運用手順
- 標準ラッパー PS1 テンプレート
- `apps/demo-api/deploy.ps1` の `-NoRestart` / `-NoServiceControl` 整理
- README / デプロイ例

### E-10: 手動検証

- NSSM テストサービス
- WinSW またはネイティブサービス
- API 再起動時の adopted
- deploy 成功・失敗・中断
- ログファイル取り込み
- ポート kill 保護

### E-11: 権限分離（任意）

- deploy 実行アカウントをサービス制御権限なしにする
- privileged broker の設計
- ラッパー PS1 の逸脱を物理的に防止

---

## 8. テストマトリクス

| ケース                                               | 期待                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `controlMode=windows-service` で `serviceName` なし  | 422                                                        |
| `controlMode=windows-service` で WSL ホスト          | 422                                                        |
| `serviceName` 重複                                   | 409                                                        |
| `serviceName` に `/` や制御文字                      | 422                                                        |
| 実行中に `controlMode` / `serviceName` を変更        | 409                                                        |
| `serviceControlOwner=script` + `restartAfter=true`   | 422 または false に正規化                                  |
| `serviceControlOwner=sys4sys` + `restartAfter=false` | true に正規化                                              |
| 外部サービスの状態取得                               | SCM の Running / Stopped / Pending を正しくマッピング      |
| `sc start` が 1056                                   | 成功扱い                                                   |
| `sc stop` が 1062                                    | 成功扱い                                                   |
| サービス不存在 1060                                  | failed                                                     |
| アクセス拒否 5                                       | 503                                                        |
| 状態取得タイムアウト                                 | unknown、PID / status 保持                                 |
| 外部サービスの start                                 | spawn / taskkill を呼ばない                                |
| 外部サービスの stop                                  | `taskkill` を呼ばない                                      |
| API 再起動時に SCM が Running                        | adopted、Stopped にしない                                  |
| WSL 不在 + Windows 外部サービス                      | Windows の操作は継続、WSL だけスキップ                     |
| `SERVICE_AUTOSTART_ON_BOOT` + 外部サービス           | sys4sys から起動しない                                     |
| deploy owner=sys4sys                                 | stop → command → start → health の順                       |
| deploy owner=script                                  | sys4sys の stop / start を呼ばない                         |
| deploy script が API restart を呼ぶ                  | 409、二重制御しない                                        |
| deploy 中の手動 start / stop / restart               | 409                                                        |
| deploy 中の ports kill                               | 409                                                        |
| deploy 中の自動再起動                                | スキップ                                                   |
| 同時 deploy 2 件                                     | 1 件だけ実行、もう 1 件は 409                              |
| 起動直後の別インスタンスの deploy                    | stale 判定前は failed にしない                             |
| deploy 失敗 + owner=sys4sys                          | サービスを起動し、action は failed                         |
| deploy 中断 + API 再起動                             | action failed、サービスを勝手に起動しない                  |
| deploy request snapshot の制御方式変更               | 承認時に 409                                               |
| 監査ログに env 値                                    | 含まれない                                                 |
| 自己サービス停止 / deploy                            | 409                                                        |
| NSSM サービス停止                                    | `Stop-Service` / `sc stop` で停止し、`taskkill` を使わない |

---

## 9. 受け入れ条件

- 既存の `spawn` サービスの start / stop / restart / deploy が無回帰。
- WSL の既存機能が無回帰。
- WSL が使えない環境でも、Windows 外部サービスの操作は継続できる。
- 外部サービスの登録・状態表示・start / stop / restart が API / CLI / Web からできる。
- 実行中に `controlMode` / `serviceName` を変更すると 409 になり、runtime を見失わない。
- API 再起動後、SCM で Running の外部サービスを `stopped` と誤判定しない。
- NSSM の自動再起動と sys4sys の操作が二重にならない。
- `serviceControlOwner=sys4sys` の deploy で、sys4sys とスクリプトが同時に stop / start しない。
- `serviceControlOwner=script` の deploy で、sys4sys が stop / start を呼ばない。
- 外部サービスの deploy スクリプトが sys4sys API の restart を呼ばない。
- deploy 中は手動操作・ports kill・自動再起動がブロックされる。
- 外部サービスのログは NSSM のファイルログから取り込める。
- 監査ログに秘密値が出ない。
- multi-instance API でも deploy が二重実行されない。P0 では起動時の stale 判定で別インスタンスの実行中 deploy を誤失敗させない。
- `pnpm format:check` / `pnpm typecheck` / `pnpm test` が成功する。

---

## 10. リスクと対策

| リスク                                           | 影響                   | 対策                                                          |
| ------------------------------------------------ | ---------------------- | ------------------------------------------------------------- |
| SCM の状態取得がロケール依存                     | 誤判定                 | PowerShell CIM の構造化 JSON を使う。数値・状態名をテストする |
| NSSM のラッパー PID をアプリ PID と誤認          | ヘルス誤判定           | PID ではなく SCM 状態と HTTP / TCP を優先する                 |
| `taskkill` で NSSM が自動再起動                  | kill が効かない        | 外部サービスは `sc stop` / `Stop-Service` を使う              |
| deploy スクリプトと sys4sys の二重 stop / start  | 再起動ループ           | `serviceControlOwner` の排他バリデーション + 実行フロー固定   |
| スクリプトが規約に反して stop / start            | 二重制御               | 状態変化の逸脱検知。必要なら権限分離                          |
| deploy スクリプトが API restart を呼ぶ           | 409 / 二重制御         | 標準ラッパーで禁止。deploy lock で拒否                        |
| deploy 中に API が落ちる                         | サービス停止のまま     | `reconcileDeployments()` で failed。自動起動しない            |
| 複数 API インスタンスの起動時 reconciliation     | 実行中 deploy を誤失敗 | `startedAt` の stale 判定。P1 で lease / heartbeat            |
| `actions` の unique index 追加が既存データで失敗 | migration 失敗         | 事前に running deploy を failed に確定する                    |
| 外部サービスなのに `process` health check        | PID 変更で unhealthy   | 外部サービスでは SCM 状態 / HTTP / TCP を使う                 |
| NSSM のログ設定漏れ                              | ログ欠損               | `AppStdout` / `AppStderr` と `log_sources` を運用手順に明記   |
| `autoStart` と SCM の二重起動                    | 起動競合               | 外部サービスでは SCM を唯一の起動主体にする                   |
| 自己停止で API が応答不能                        | 操作失敗               | `SELF_SERVICE_NAME` で 409。将来は遅延実行                    |
| 外部サービスの権限不足                           | start / stop 失敗      | 503 と `lastError`。実行アカウントの権限を運用手順に明記      |

---

## 11. 決定事項

| 項目                                    | 決定                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| NSSM / WinSW / ネイティブサービスの扱い | すべて `windows-service`                                     |
| サービス同一性                          | `serviceName`                                                |
| deploy の stop / start 所有者           | `deploy.serviceControlOwner` で必須化                        |
| 手動 start / stop / restart             | 常に sys4sys controller                                      |
| 外部サービスの起動主体                  | SCM。sys4sys の autoStart は使わない                         |
| 外部サービスの停止手段                  | `sc.exe stop` / `Stop-Service`。通常は `taskkill` を使わない |
| `restartAfter`                          | `spawn` では既存維持。外部では owner から導出                |
| deploy lock                             | `actions` の部分 unique index + DB 照会                      |
| 外部サービスのログ                      | NSSM のファイルログを `log_sources` で取り込む               |
| 自己管理                                | P0 では 409。将来は遅延実行                                  |
| systemd                                 | 今回は非対象。controller interface だけ将来対応可能にする    |

---

## 12. 実装チェックリスト

### P0

- [x] `controlMode` / `serviceName` を shared schema に追加
- [x] `serviceControlOwner` を deploy schema に追加
- [x] `stopping` status を追加
- [x] DB migration と部分 unique index
- [x] `WindowsServiceController` を追加
- [x] 外部サービスの state mapping
- [x] `startService` / `stopService` / `restartService` の外部分岐
- [x] `reconcileServices` の SCM 対応
- [x] deploy lock と手動操作 / 自動再起動のガード
- [x] `serviceControlOwner=sys4sys` の deploy
- [x] `serviceControlOwner=script` の deploy
- [x] deploy request snapshot の制御方式追加
- [x] ports kill / kill-token の外部サービス保護
- [x] `SELF_SERVICE_NAME` による自己管理ガード
- [x] API / CLI / Web の型・表示
- [x] 監査ログ
- [x] 単体テスト / 回帰テスト

### P1

- [ ] 逸脱検知 `service.control.violation`
- [x] deploy 中断時の復旧ポリシー（stale deploy を failed にし、owner=sys4sys の deploy 失敗時は service recovery を試行）
- [x] NSSM / WinSW の運用手順
- [x] `docs/openapi.yaml` / `docs/ER.md` 更新

### P2

- [ ] deploy 実行アカウントの権限分離
- [ ] privileged broker
- [ ] systemd controller
- [ ] Windows Event Log source
- [ ] blue-green / 無停止デプロイ

---

## 13. 最終確認

- [x] `pnpm format:check`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] 既存 spawn サービスの回帰確認（既存テスト成功）
- [x] NSSM 実機で start / stop / restart
- [x] NSSM 実機で deploy owner=sys4sys
- [x] NSSM 実機で deploy owner=script
- [x] API 再起動後の adopted 確認（`services.external.test.ts` の reconcile テスト）
- [ ] deploy 中断時の挙動確認（NSSM / API 停止実機確認）
- [x] NSSM ファイルログの取り込み確認
- [x] NSSM `/crash` によるインシデント生成確認
- [x] `ports kill` の保護確認（ports 保護テスト）
- [x] 監査ログに秘密値がないこと（既存 masking テスト成功）
