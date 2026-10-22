# sys4sys

バックエンド運用管理システム。ポート管理・ログ管理・監視・承認付き自動復旧に加え、ローカル LLM による AI 分析・レポート、監査ログ、保持期間、バックアップまでを提供します。

計画書は [PLAN.md](./PLAN.md)、データモデルは [docs/ER.md](./docs/ER.md)、API 定義は [docs/openapi.yaml](./docs/openapi.yaml) を参照。

## 前提（確定要件）

| 項目       | 決定                                    |
| ---------- | --------------------------------------- |
| 対象環境   | Windows ローカル + WSL                  |
| 監視対象   | 自作 API / ワーカー                     |
| スタック   | TypeScript（pnpm モノレポ）             |
| AI         | ローカル LLM / OpenAI 互換 API / BYOK   |
| 自動再起動 | 段階的自動（observe → approve → auto）  |
| 通知       | メール（SMTP）                          |
| 承認       | UI のみ                                 |
| 利用者     | チーム共有（admin / operator / viewer） |
| ログ保持   | 既定 14 日                              |

## クイックスタート

```powershell
pnpm install
Copy-Item .env.example .env
# .env の ADMIN_PASSWORD を 12 文字以上で設定（推奨）
pnpm dev
```

- API: http://127.0.0.1:8787/api/health
- Web: http://127.0.0.1:3000
- ポートスキャン単体: `pnpm scan` / `pnpm scan --json`

> 起動時に未適用のマイグレーションを自動適用します。`pnpm db:generate` は `apps/api/src/db/schema.ts` を変更したときだけ実行してください。

## 認証

- メール + パスワード（Argon2id、`hash-wasm`）
- セッション Cookie: `sys4sys_session`（HttpOnly / SameSite=Lax / 既定 168 時間）
- 初回起動時に `users` が空なら管理者を 1 人作成
  - `ADMIN_EMAIL` / `ADMIN_PASSWORD` を `.env` に設定（本番では `ADMIN_PASSWORD` 必須）
  - 開発時に `ADMIN_PASSWORD` が空ならランダム生成し、起動ログに一度だけ表示
- ログイン試行制限: `LOGIN_MAX_ATTEMPTS` 回 / `LOGIN_WINDOW_MINUTES` 分（既定 5 回 / 15 分）
- パスワード変更時は現在のセッション以外を無効化
- 変更系リクエストは `Origin` / `Sec-Fetch-Site` を検証（`ALLOWED_ORIGINS`、既定は localhost:3000 / 8787）
- ユーザー管理は admin のみ。最後の有効な admin は降格・無効化できない
- パスワード再設定時は対象ユーザーの全セッションを無効化

認証方式の詳細は [docs/adr/0001-auth.md](./docs/adr/0001-auth.md) を参照。

## ポート管理（M1）

- Windows / WSL を 10 秒ごとにスキャンして 1 つの一覧に表示（WSL は distro 間でネットワーク共有）
- **ポート予約**: `protocol + port` 単位。Windows / WSL をまたいで一意
- **競合検出**: 予約済みエンドポイントに実リスナーが現れたら `conflict` として強調
- **履歴**: 観測された opened / closed を `port_history` に保存。停止操作の実行者も記録
- **プロセス詳細**: PID / PPID / 開始時刻 / 実行パス / コマンドライン / WSL distro
- **停止**: operator 以上。短寿命 HMAC 確認トークン + 監査ログ。PID 4 以下と API 自身は拒否
- **ホスト管理**: Windows は起動時に自動登録、WSL は検出 → 明示登録 → 有効化
- **ユーザー管理**: admin / operator / viewer、有効化・無効化、ロール変更、パスワード再設定

## サービス管理・ログ（M2）

- **サービス CRUD**: admin が登録・更新・論理削除。起動 / 停止 / 再起動は operator 以上
- **実行**: `cross-spawn` にコマンド配列を渡す（シェル文字列を組み立てない）。`SERVICE_COMMAND_ALLOWLIST` で許可した実行ファイルのみ起動
- **WSL**: `wsl.exe -d <distro> [--cd <cwd>] -- [env K=V...] <cmd> ...` で直接起動。`sh -c` ラッパーは使わない
- **停止**: Windows は `taskkill /PID /T`、猶予後に `/F`。WSL サービスは `wsl.exe` の Windows PID を `taskkill /T /F` して Linux 側プロセスも止める
- **ヘルスチェック**: HTTP / TCP / process / command。失敗が `failures` 回に達すると `degraded`
- **ログ収集**: サービスの stdout / stderr を捕捉。`file`（Windows）と `wsl_file`（WSL）は 1 秒ポーリングで追記分を取り込み
- **ログ検索**: ホスト・サービス・レベル・期間・全文で検索。`/api/logs/stream` で SSE tail
- **保持**: `LOG_RETENTION_DAYS`（既定 14 日）を超えたログを起動時 + 1 時間ごとに削除
- **UI**: `/services`（一覧・起動停止・ヘルス・CRUD）と `/logs`（検索・SSE・ログソース管理）

### M2 関連の環境変数

| 変数                        | 既定値                              | 内容                                           |
| --------------------------- | ----------------------------------- | ---------------------------------------------- |
| `SERVICE_COMMAND_ALLOWLIST` | node / pnpm / python / go / pwsh 等 | カンマ区切りの許可実行ファイル                 |
| `SERVICE_STOP_GRACE_MS`     | `5000`                              | TERM から KILL までの猶予                      |
| `SERVICE_AUTOSTART_ON_BOOT` | `false`                             | API 起動時に `autoStart` サービスを起動        |
| `LOG_TAIL_POLL_MS`          | `1000`                              | ファイル / WSL ファイルのポーリング間隔        |
| `LOG_MAX_LINE_CHARS`        | `8000`                              | 1 行の最大文字数                               |
| `LOG_MAX_TAIL_BYTES`        | `1048576`                           | 1 回の tail で読む最大バイト数                 |
| `LOG_RETENTION_DAYS`        | `14`                                | ログ保持日数の初期値（設定画面の DB 値が優先） |

## 監視・承認付き復旧（M3）

- **検知**: プロセスの異常終了は child process の exit を即時検知。ヘルスチェック失敗が `failures` 回に達すると `degraded` からインシデント化
- **ルール監視**: ハートビート（最後のログからの経過）、エラーログ件数、正規表現パターン。既定ではハートビートとエラー件数ルールは無効（`0`）
- **重複排除**: プロセス異常終了とヘルス劣化は `service-failure:<serviceId>` に集約。同一 fingerprint は既定 10 分間は既存インシデントにイベントを追加
- **インシデント**: `/incidents` で一覧・タイムライン・ack / resolve。10 秒ごとに自動更新
- **承認キュー**: `autoRestartPhase=approve` のサービスは再起動前に承認リクエストを作成。`/approvals` で operator 以上が承認・却下
- **再起動**: 承認後は `actions` に restart を記録して非同期実行し、API は `202` を返す。復旧確認（ヘルスチェック / 3 秒安定）に成功するとインシデントを自動解決
- **自動復旧**: `observe`（通知のみ）/ `approve`（承認後）/ `auto`（安全装置内で自動）。クールダウン、最大試行、クラッシュループ、復旧確認失敗でエスカレーション
- **メール**: 検知・承認待ち・承認・却下・復旧・復旧失敗・エスカレーションを通知。SMTP 未設定時は送信をスキップしてログのみ
- **SMTP 設定**: `/settings`（admin）で登録。DB の設定を env より優先し、パスワードは `SESSION_SECRET` から導出した鍵で AES-256-GCM 暗号化。API は平文を返さない
- **送信先**: `MAIL_RECIPIENTS`。空の場合は有効な admin / operator のメールアドレス
- **ダイジェスト**: `digest5m` は設定値として保存できるが、現時点では即時送信として扱う

### M3 関連の環境変数

| 変数                              | 既定値                  | 内容                                                           |
| --------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `MONITOR_ENABLED`                 | `true`                  | 監視エンジンを起動する                                         |
| `MONITOR_INTERVAL_SEC`            | `15`                    | ルール監視の周期                                               |
| `MONITOR_STARTUP_DELAY_SEC`       | `5`                     | 起動後の初回ルール実行までの待ち時間                           |
| `MONITOR_HEARTBEAT_TIMEOUT_SEC`   | `0`                     | 最後のログからの許容秒数。`0` で無効                           |
| `MONITOR_ERROR_LOG_WINDOW_SEC`    | `300`                   | エラーログ件数の集計ウィンドウ                                 |
| `MONITOR_ERROR_LOG_THRESHOLD`     | `0`                     | ウィンドウ内のエラー件数しきい値。`0` で無効                   |
| `MONITOR_LOG_PATTERN`             | 空                      | 監視する正規表現。空で無効                                     |
| `INCIDENT_DEDUPE_MINUTES`         | `10`                    | 同一 fingerprint の重複排除ウィンドウ                          |
| `AUTO_RESTART_COOLDOWN_SEC`       | `60`                    | 再起動後のクールダウン                                         |
| `AUTO_RESTART_MAX_ATTEMPTS`       | `3`                     | ウィンドウ内の最大再起動試行回数                               |
| `AUTO_RESTART_WINDOW_SEC`         | `600`                   | 試行回数とクラッシュループの集計ウィンドウ                     |
| `AUTO_RESTART_BACKOFF_SEC`        | `10,30,90`              | 自動再起動のバックオフ（秒、カンマ区切り）                     |
| `AUTO_RESTART_VERIFY_TIMEOUT_SEC` | `30`                    | 再起動後の復旧確認タイムアウト                                 |
| `APP_BASE_URL`                    | `http://127.0.0.1:3000` | メール内リンクのベース URL                                     |
| `SMTP_HOST` / `SMTP_PORT`         | 空 / `587`              | SMTP サーバー。設定画面で保存した値が優先                      |
| `SMTP_SECURE` / `SMTP_USER`       | `false` / 空            | TLS / SMTP ユーザー                                            |
| `SMTP_PASS` / `SMTP_FROM`         | 空                      | SMTP パスワード / 送信元                                       |
| `MAIL_RECIPIENTS`                 | 空                      | カンマ区切りの送信先。空なら admin / operator にフォールバック |

## AI 分析・レポート（M4）

- **プロバイダ**: OpenAI 互換 API（LM Studio / Ollama / llama.cpp / vLLM / OpenAI など）。`/settings` で保存した DB 設定を env より優先
- **API キー**: DB 保存時に `SESSION_SECRET` から導出した鍵で AES-256-GCM 暗号化。API は平文を返さず `apiKeySet` のみ返す。BYOK とローカル LLM（キーなし）の両方に対応
- **実行タイミング**: インシデント作成時に非同期キューへ自動投入。`/incidents` の詳細から「AI 分析を実行」で再実行（API は `202`）
- **入力**: インシデント前後のログ（最大 200 行）、マスク済みのタイトル・概要、類似インシデント。`maxInputTokens` に応じてログ行を予算内に削減
- **出力**: JSON スキーマ（severity / category / summary / root_cause_hypothesis / evidence / recommended_actions / confidence / needs_human）を検証して保存
- **レポート**: 分析ジョブが Markdown を生成して `reports` に保存。`/reports` で一覧・プレビュー・Markdown / JSON ダウンロード
- **フォールバック**: AI 未設定、外部送信が無効、日次上限到達、接続失敗、タイムアウト時はルールベースの分析 + Markdown レポートを保存（`provider=template`, `model=rules-v1`）
- **マスキング**: 送信前に Bearer / JWT / API キー / DB URL / パスワード代入 / 秘密鍵ブロックなどをマスク。ログ本文は 1 行 2,000 文字に切り詰め
- **外部送信制御**: `localhost` / `127.0.0.1` / プライベート IP / `*.local` / 短いホスト名はローカル扱い。それ以外のエンドポイントへログを送るには `sendLogsExternally`（または `AI_SEND_LOGS_EXTERNALLY=true`）が必要
- **コスト制御**: 同一 fingerprint の分析結果を 30 分キャッシュ。`dailyRequestLimit` で 1 日の実 LLM リクエスト数を制限。`0` で AI を実質無効化
- **メール送信**: レポートのメール送信・再送は後回し（`POST /reports/:id/send` は未実装）。UI にも送信ボタンは出していません

### ローカル LLM での動作確認

開発時の OpenAI 互換 API は `http://localhost:8081/v1` を使用できます（例: llama.cpp のモデル `Qwen3.8-27B-GSQ-RCO-IQ3_XXS`）。設定画面で Base URL と Model を保存し、「接続テスト」で `/models` を確認してください。

```powershell
# モデル一覧の確認
Invoke-RestMethod http://localhost:8081/v1/models | ConvertTo-Json -Depth 4
```

スモークでは `SMOKE_AI_BASE_URL` / `SMOKE_AI_MODEL` を指定すると、実際のローカル LLM で分析・レポート生成まで検証します。未指定時は `http://localhost:8081/v1` と `/models` の先頭モデルを使います。

### M4 関連の環境変数

| 変数                      | 既定値                     | 内容                                          |
| ------------------------- | -------------------------- | --------------------------------------------- |
| `AI_BASE_URL`             | `http://127.0.0.1:1234/v1` | OpenAI 互換 API のベース URL（DB 設定が優先） |
| `AI_MODEL`                | 空                         | モデル名。空なら env の AI 設定は無効         |
| `AI_API_KEY`              | 空                         | BYOK 用 API キー                              |
| `AI_MAX_INPUT_TOKENS`     | `8000`                     | プロンプトに含めるログの予算                  |
| `AI_TEMPERATURE`          | `0.2`                      | 生成温度                                      |
| `AI_TIMEOUT_SEC`          | `60`                       | 1 リクエストのタイムアウト                    |
| `AI_DAILY_LIMIT`          | `200`                      | 1 日の実 LLM リクエスト上限。`0` で無効化     |
| `AI_SEND_LOGS_EXTERNALLY` | `false`                    | 非ローカルエンドポイントへのログ送信を許可    |

## 運用強化（M5）

- **監査ログ UI**: `/audit`（admin のみ）。actor / action / target / 期間でフィルタし、変更前後の JSON を確認。20 秒ごとに自動更新
- **保持期間**: `/settings` でログ保持日数を DB に保存。`LOG_RETENTION_DAYS` は初期値として使い、1 時間ごとのクリーンアップが DB 設定を参照
- **バックアップ**: `/settings` の「バックアップを作成」または `pnpm db:backup` で SQLite のオンラインバックアップを `backups/` に作成。`POST /api/admin/backup` は admin のみ
- **復元**: API を停止してから、`apps/api/data/backups/sys4sys-*.db` を `DATABASE_URL` の DB ファイルにコピーし、`-wal` / `-shm` を削除して起動
- **Phase 3 昇格**: `/settings` のチェックリストを確認し、対象サービスを `approve` で運用してから `auto` に変更。クラッシュループ・ポート競合・WSL 停止は自動再起動の対象外
- **監査対象**: 設定変更、承認 / 却下、再起動、kill、レポート生成、バックアップなど。秘密値は監査ログに含めない

## サービスデプロイ（M6）

- **deploy 設定**: サービスごとに `deploy` JSON を保存します。`command`（配列）、`cwd`、`env`、`timeoutSec`（既定 600）、`restartAfter`（既定 true）、`healthTimeoutSec`（既定 120）
- **登録**: admin が `/services` の Edit フォームで Deploy command / CWD / timeout / restartAfter / healthTimeout を入力します。`deploy.ps1 の例を入力` ボタンで PowerShell の例を埋められます
- **実行**: operator 以上が一覧の Deploy ボタン、または `POST /api/services/:id/deploy` で開始します。API は `actions.type=deploy` を作成して `202` を返し、コマンドを非同期実行します
- **ログ**: コマンドの stdout / stderr は `log_events` に `[deploy]` プレフィックス、`fields.source="deploy"`、`fields.actionId` 付きで保存されます。`/logs` で `[deploy]` を検索してください。エラーログ件数・パターン監視からは deploy ログを除外します
- **再起動と確認**: `restartAfter=true` の場合、コマンド成功後に sys4sys がサービスを再起動し、`healthTimeoutSec` の間ヘルスチェックを待ちます。成功すると action は `succeeded`、失敗すると `failed` になり、`services.last_deploy_*` に最終状態が残ります
- **多重実行防止**: 同一サービスのデプロイは in-memory Set と DB の running action で防止します。API 再起動時に running のまま残った deploy は、起動時の reconciliation で failed になります
- **ファイルアップロードなし**: スクリプト本体をアップロードするのではなく、実行コマンドとパスを登録する方式です。既存の `SERVICE_COMMAND_ALLOWLIST` に従うため、`pwsh.exe` / `powershell.exe` を追加済みです
- **deploy.ps1 の注意**: sys4sys 側で再起動する場合はスクリプトに `-NoRestart` を渡してください。`git pull` を含める場合はリポジトリに `origin` が必要です。未設定のときは `-SkipPull` を使います
- **demo-api の例**: `command` は `["pwsh.exe","-NoProfile","-ExecutionPolicy","Bypass","-File","deploy.ps1","-SkipPull","-NoRestart"]`、`cwd` は `apps/demo-api`、`restartAfter=true`、`healthTimeoutSec=120`。詳細は [apps/demo-api/README.md](./apps/demo-api/README.md) を参照してください

### デプロイの確認例

```powershell
# サービス詳細で deploy 設定と最終状態を確認
Invoke-RestMethod http://127.0.0.1:8787/api/services/<serviceId> -WebSession $session |
  Select-Object name, status, lastDeployStatus, lastDeployError, deploy

# デプロイ開始（202）
Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/services/<serviceId>/deploy -WebSession $session

# deploy ログの検索
Invoke-RestMethod "http://127.0.0.1:8787/api/logs?serviceId=<serviceId>&q=%5Bdeploy%5D&limit=100" -WebSession $session
```

## 構成

```
sys4sys/
├─ apps/
│  ├─ api/        Fastify + Drizzle + SQLite（ポート / サービス / ログ / 監視 / AI / レポート / 監査）
│  ├─ web/        Next.js ダッシュボード（Ports / Services / Logs / Incidents / Reports / Approvals / Audit / Settings / Hosts / Users）
│  ├─ agent/      Windows / WSL ポートスキャン・プロセス操作
│  └─ demo-api/   sys4sys のサービス管理を試すための最小 HTTP サービス
├─ packages/
│  ├─ shared/     Zod スキーマ・型
│  ├─ policy/     自動再起動の決定論的評価
│  ├─ ai/         OpenAI 互換クライアント・プロンプト・レポート
│  └─ mail/       SMTP 送信
├─ docs/
│  ├─ ER.md
│  ├─ openapi.yaml
│  └─ spike/portscan-findings.md
├─ spike/         検証用スクリプト（M1 スパイク）
└─ PLAN.md
```

テスト用の管理対象サービスは `apps/demo-api` にあります。ビルド、`/services` への登録、`deploy.ps1` による git pull・再ビルド・sys4sys 経由の再起動手順は [apps/demo-api/README.md](./apps/demo-api/README.md) を参照してください。

## 実装状況

- [x] M0: 要件確定
- [x] M0: ER 図・OpenAPI 定義
- [x] M1 スパイク: Windows + WSL ポートスキャン（[結果](./docs/spike/portscan-findings.md)）
- [x] モノレポ初期化（pnpm workspace / Fastify / Next.js / Drizzle）
- [x] M1: 認証・ロール・セッション
- [x] M1: ポート一覧・予約・競合検出・履歴・プロセス詳細・停止
- [x] M1: ホスト管理・ユーザー管理・CSRF・M1 スモーク
- [x] M2: サービス管理・起動停止・ヘルスチェック（Windows / WSL）
- [x] M2: ログ収集（stdout / stderr / file / WSL file）・検索・SSE tail・保持期間
- [x] M2: Services / Logs UI・M2 スモーク（56 checks、WSL 含む）
- [x] M3: 監視ルール（process exit / health / heartbeat / error log / pattern）・fingerprint 重複排除
- [x] M3: インシデント・承認キュー・ack / resolve・復旧検証・自動再起動の安全装置
- [x] M3: SMTP 設定（暗号化）・即時通知・接続テスト・Incidents / Approvals / Settings UI
- [x] M3: 統合スモーク（69 checks、kill → 検知 → 承認 → 再起動 → 復旧）
- [x] M4: OpenAI 互換クライアント・AI 設定（DB / env / BYOK / 暗号化）・接続テスト
- [x] M4: 非同期分析キュー・JSON 検証・マスキング・fingerprint キャッシュ・日次上限・フォールバック
- [x] M4: Markdown レポート生成・`/reports` 一覧 / プレビュー / MD・JSON ダウンロード・インシデント詳細の AI パネル
- [x] M4: 実ローカル LLM（`localhost:8081`）での分析確認
- [x] M5: 監査ログ UI（`/audit`）・保持期間設定・SQLite バックアップ・Phase 3 昇格チェックリスト
- [x] M4/M5: 統合スモーク（86 checks、AI 分析・レポート・監査・保持期間・バックアップ）
- [x] M6: サービス単位の deploy 設定・非同期デプロイ action・`[deploy]` ログ・再起動 + ヘルス確認
- [x] M6: `/services` の deploy フォーム / 実行ボタン / 最終状態表示、`POST /api/services/:id/deploy`
- [x] M6: demo-api の `deploy.ps1` を API 経由で実行し、再起動・healthy・ログ保存を確認
- [ ] M3+: レポートのメール送信・再送（後回し）

## 認証の設計

[ADR 0001](./docs/adr/0001-auth.md) を参照。better-auth ではなく、既存の `users` / `sessions` スキーマに直結する自前実装を採用しています。

## スパイクで判明した重要事項

- WSL 3.x は **distro 間でネットワーク名前空間を共有**する。ポートは `windows` / `wsl` の 2 スコープで扱い、PID の帰属先を `pidScope` に持つ。
- 停止中の distro を `wsl.exe -d` で叩くと起動してしまう。スキャンは `Running` のみ対象。
- WSL のポートは Windows 側に `wslrelay.exe` として現れる。同一ポートが WSL 側にあればフォワーディングと判定。
- `wsl.exe` の出力は UTF-16LE + BOM。BOM / NUL 密度でデコードする。

## スクリプト

| コマンド                           | 内容                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                         | API + Web を同時起動                                                                                       |
| `pnpm dev:api`                     | API のみ                                                                                                   |
| `pnpm dev:web`                     | Web のみ                                                                                                   |
| `pnpm scan`                        | ポートスキャン（CLI）                                                                                      |
| `pnpm typecheck`                   | 全パッケージの型チェック                                                                                   |
| `pnpm test`                        | テスト（policy / auth / 予約 / kill / ログ解析 / 許可リスト / 監視ルール / 暗号化 / マスキング）           |
| `pnpm db:generate`                 | Drizzle マイグレーション生成                                                                               |
| `pnpm db:migrate`                  | マイグレーション適用                                                                                       |
| `pnpm db:backup`                   | SQLite のオンラインバックアップを `backups/` に作成                                                        |
| `pnpm --filter @sys4sys/api smoke` | M1〜M5 統合スモーク（認証・予約・kill・サービス・ログ・監視・承認・AI・レポート・監査・バックアップ・WSL） |

### スモークテスト

スモークは実際に一時ポートでリスナーとサービスを起動し、予約 → 競合検出 → kill → 履歴 → サービス CRUD / 起動 / ログ / ヘルス / 停止まで検証します。さらに M3 として、`approve` モードのサービスを kill → 30 秒以内のインシデント検知 → 承認キュー → operator 承認 → 再起動 → 復旧確認 → resolved まで検証します。M4/M5 では、ローカル OpenAI 互換 API で AI 分析 → レポート生成 → 一覧 / 詳細 / MD・JSON エクスポート、監査ログ、保持期間、バックアップまで検証します。WSL ホストが登録されていれば、その distro で `node` または `python3` を使って WSL サービスも検証します。開発 DB を汚さないよう、一時 DB を指定して実行してください。

```powershell
$vars = @{}; Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $vars[$matches[1]] = $matches[2].Trim() }
}
$env:ADMIN_EMAIL = $vars['ADMIN_EMAIL']
$env:ADMIN_PASSWORD = 'SmokeTest-Password-123!'
$env:DATABASE_URL = './data/smoke-m4.db'
$env:LOG_LEVEL = 'warn'
$env:SMOKE_AI_BASE_URL = 'http://localhost:8081/v1'
$env:SMOKE_AI_MODEL = 'Qwen3.8-27B-GSQ-RCO-IQ3_XXS'
Remove-Item -Force apps/api/data/smoke-m4.db* -ErrorAction SilentlyContinue
Remove-Item -Force apps/api/data/backups/*.db -ErrorAction SilentlyContinue
pnpm --filter @sys4sys/api smoke
```

`ADMIN_PASSWORD` を設定しない場合、認証以降のチェックはスキップされます。ローカル LLM が起動していない場合、`local OpenAI-compatible API is reachable` が失敗し、AI 分析・レポート・監査・保持期間・バックアップのチェックはスキップされます（M1〜M3 は継続）。WSL の distro は停止中でも、サービス起動時に `wsl.exe -d` で暗黙起動されます。
