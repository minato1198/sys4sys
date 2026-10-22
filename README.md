# sys4sys

バックエンド運用管理システム。ポート管理・ログ管理・監視・承認付き自動復旧を行います（AI レポートは M4）。

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

| 変数                        | 既定値                       | 内容                                    |
| --------------------------- | ---------------------------- | --------------------------------------- |
| `SERVICE_COMMAND_ALLOWLIST` | node / pnpm / python / go 等 | カンマ区切りの許可実行ファイル          |
| `SERVICE_STOP_GRACE_MS`     | `5000`                       | TERM から KILL までの猶予               |
| `SERVICE_AUTOSTART_ON_BOOT` | `false`                      | API 起動時に `autoStart` サービスを起動 |
| `LOG_TAIL_POLL_MS`          | `1000`                       | ファイル / WSL ファイルのポーリング間隔 |
| `LOG_MAX_LINE_CHARS`        | `8000`                       | 1 行の最大文字数                        |
| `LOG_MAX_TAIL_BYTES`        | `1048576`                    | 1 回の tail で読む最大バイト数          |
| `LOG_RETENTION_DAYS`        | `14`                         | ログ保持日数                            |

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

## 構成

```
sys4sys/
├─ apps/
│  ├─ api/        Fastify + Drizzle + SQLite（ポート / サービス / ログ / 監視 / インシデント）
│  ├─ web/        Next.js ダッシュボード（Ports / Services / Logs / Incidents / Approvals / Settings / Hosts / Users）
│  └─ agent/      Windows / WSL ポートスキャン・プロセス操作
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

## 認証の設計

[ADR 0001](./docs/adr/0001-auth.md) を参照。better-auth ではなく、既存の `users` / `sessions` スキーマに直結する自前実装を採用しています。

## スパイクで判明した重要事項

- WSL 3.x は **distro 間でネットワーク名前空間を共有**する。ポートは `windows` / `wsl` の 2 スコープで扱い、PID の帰属先を `pidScope` に持つ。
- 停止中の distro を `wsl.exe -d` で叩くと起動してしまう。スキャンは `Running` のみ対象。
- WSL のポートは Windows 側に `wslrelay.exe` として現れる。同一ポートが WSL 側にあればフォワーディングと判定。
- `wsl.exe` の出力は UTF-16LE + BOM。BOM / NUL 密度でデコードする。

## スクリプト

| コマンド                           | 内容                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev`                         | API + Web を同時起動                                                                |
| `pnpm dev:api`                     | API のみ                                                                            |
| `pnpm dev:web`                     | Web のみ                                                                            |
| `pnpm scan`                        | ポートスキャン（CLI）                                                               |
| `pnpm typecheck`                   | 全パッケージの型チェック                                                            |
| `pnpm test`                        | テスト（policy / auth / 予約 / kill / ログ解析 / 許可リスト / 監視ルール / 暗号化） |
| `pnpm db:generate`                 | Drizzle マイグレーション生成                                                        |
| `pnpm db:migrate`                  | マイグレーション適用                                                                |
| `pnpm --filter @sys4sys/api smoke` | M1 + M2 + M3 統合スモーク（認証・予約・kill・サービス・ログ・監視・承認・WSL）      |

### スモークテスト

スモークは実際に一時ポートでリスナーとサービスを起動し、予約 → 競合検出 → kill → 履歴 → サービス CRUD / 起動 / ログ / ヘルス / 停止まで検証します。さらに M3 として、`approve` モードのサービスを kill → 30 秒以内のインシデント検知 → 承認キュー → operator 承認 → 再起動 → 復旧確認 → resolved まで検証します。WSL ホストが登録されていれば、その distro で `node` または `python3` を使って WSL サービスも検証します。開発 DB を汚さないよう、一時 DB を指定して実行してください。

```powershell
Remove-Item -Force apps/api/data/smoke-m3.db* -ErrorAction SilentlyContinue
$env:DATABASE_URL='./data/smoke-m3.db'
$env:ADMIN_PASSWORD='SmokeTest-Password-123!'
$env:LOG_LEVEL='warn'
pnpm --filter @sys4sys/api smoke
```

`ADMIN_PASSWORD` を設定しない場合、認証以降のチェックはスキップされます。WSL の distro は停止中でも、サービス起動時に `wsl.exe -d` で暗黙起動されます。
