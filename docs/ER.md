# ER 図 / データモデル詳細

- 版: 1.2（AI 提案アクション承認モデルを含む）
- 対象: SQLite（初期） / PostgreSQL（将来）
- 正: `PLAN.md` の「6. データモデル」と本ドキュメント

---

## 1. ER 図

```mermaid
erDiagram
    users ||--o{ sessions : "has"
    users ||--o{ audit_logs : "acts"
    users ||--o{ approvals : "decides"
    users ||--o{ deploy_requests : "requests"

    hosts ||--o{ services : "runs"
    hosts ||--o{ log_sources : "provides"
    hosts ||--o{ ports : "pid attribution"

    services ||--o{ log_sources : "emits"
    services ||--o{ incidents : "has"
    services ||--o{ port_reservations : "reserves"
    services ||--o{ actions : "targets"
    services ||--o{ deploy_requests : "requires approval for"
    deploy_requests ||--o| actions : "executes as"

    incidents ||--o{ incident_events : "timeline"
    incidents ||--o{ approvals : "requires"
    incidents ||--o{ incident_action_proposals : "proposes"
    incidents ||--o{ ai_analyses : "analyzed by"
    incidents ||--o{ reports : "generates"
    incidents ||--o{ actions : "executes"
    incident_action_proposals ||--o| approvals : "requested as"
    incident_action_proposals ||--o| actions : "executes as"

    reports ||--o{ report_deliveries : "delivered as"
    policies ||--o{ actions : "governs"

    users {
        text id PK
        text email UK
        text name
        text password_hash
        text role "admin | operator | viewer"
        boolean is_active
        datetime last_login_at
        datetime created_at
    }

    sessions {
        text id PK
        text user_id FK
        text token_hash UK
        datetime expires_at
        text user_agent
        text ip
        datetime created_at
    }

    hosts {
        text id PK
        text kind "windows | wsl"
        text name
        text distro "WSL only"
        text default_user
        boolean enabled
    }

    services {
        text id PK
        text host_id FK
        text name
        text control_mode "spawn | windows-service"
        text service_name "nullable (SCM 名、host 内で case-insensitive unique)"
        json command "string[] (spawn allowlist / windows-service では表示用)"
        text cwd
        json env
        json expected_ports
        json health_check
        json deploy "command / cwd / env / timeoutSec / restartAfter / healthTimeoutSec / requireApproval / serviceControlOwner"
        json depends_on
        boolean auto_start
        text auto_restart_phase "observe | approve | auto"
        text status
        integer pid "Windows PID (WSL は wsl.exe)"
        text pid_scope "nullable"
        datetime last_started_at
        datetime last_exited_at
        integer last_exit_code
        text last_error
        datetime last_deploy_at
        text last_deploy_status "running | succeeded | failed"
        text last_deploy_error
        boolean is_active
        datetime created_at
        datetime updated_at
    }

    ports {
        text id PK
        text scope "windows | wsl"
        text pid_host_id FK "nullable"
        text protocol "tcp | udp"
        text address
        integer port
        integer pid
        integer ppid
        text process_name
        text process_path
        text command_line
        datetime started_at
        text service_id FK "nullable"
        datetime first_seen
        datetime last_seen
    }

    port_history {
        text id PK
        text scope "windows | wsl"
        text pid_host_id FK "nullable"
        text protocol "tcp | udp"
        text address
        integer port
        integer pid
        integer ppid
        text process_name
        text process_path
        text command_line
        datetime started_at
        text service_id FK "nullable"
        datetime opened_at
        datetime closed_at "nullable"
        text released_by "nullable"
    }

    port_reservations {
        text id PK
        text scope "windows | wsl"
        integer port
        text protocol
        text service_id FK
        text note
        datetime created_at
    }

    log_sources {
        text id PK
        text host_id FK
        text service_id FK
        text type "file | stdout | wsl_file | eventlog"
        json config
        boolean enabled
    }

    log_events {
        text id PK
        text host_id FK
        text service_id FK
        datetime ts
        text level
        text stream
        text message
        json fields
        text fingerprint
    }

    incidents {
        text id PK
        text service_id FK
        text fingerprint
        text title
        text severity
        text status "open | acked | approval | resolved"
        datetime started_at
        datetime resolved_at
        text detected_by "rule | health | process | ai"
        integer restart_attempts
        text summary
    }

    incident_events {
        text id PK
        text incident_id FK
        datetime ts
        text type
        json payload
    }

    incident_action_proposals {
        text id PK
        text incident_id FK
        text analysis_id FK "nullable"
        text service_id FK
        text action_type "restart | start | stop | deploy"
        text status "proposed | pending_approval | approved | executing | succeeded | failed | rejected | expired | superseded"
        text risk "low | medium | high"
        real confidence
        text rationale
        json parameters "nullable, command strings are not stored"
        json snapshot "service and incident state at proposal time"
        text dedupe_key
        integer sort_order
        text analysis_requested_by FK "nullable, manual analysis actor for four-eyes"
        text approval_id FK "nullable"
        text action_id FK "nullable"
        datetime created_at
        datetime expires_at
        datetime decided_at "nullable"
        datetime executed_at "nullable"
        text error
    }

    approvals {
        text id PK
        text incident_id FK
        text proposal_id FK "nullable"
        text source "policy | ai | manual"
        json requested_action
        text requested_by FK "nullable, null = system"
        text status "pending | approved | rejected | expired"
        datetime requested_at
        text decided_by FK
        datetime decided_at
        text note
        datetime expires_at "nullable, AI approvals use 30 min TTL"
    }

    deploy_requests {
        text id PK
        text service_id FK
        text requested_by FK
        text status "pending | approved | rejected | expired | executed | failed"
        datetime requested_at
        text decided_by FK
        datetime decided_at
        text note
        text action_id FK "nullable"
        json snapshot "command / cwd / timeoutSec / restartAfter / healthTimeoutSec / envHash / deployEnvHash / controlMode / serviceName / serviceControlOwner"
        datetime expires_at
    }

    ai_analyses {
        text id PK
        text incident_id FK
        text provider
        text model
        text prompt_version
        integer input_tokens
        integer output_tokens
        json result
        real confidence
        integer latency_ms
        datetime created_at
    }

    reports {
        text id PK
        text incident_id FK
        text format "markdown | json"
        text body
        datetime created_at
    }

    report_deliveries {
        text id PK
        text report_id FK
        text channel "email"
        text to_addr
        text status "sent | failed"
        text error
        datetime sent_at
    }

    actions {
        text id PK
        text incident_id FK
        text service_id FK
        text type "start | stop | restart | kill | deploy"
        text status "pending | running | succeeded | failed"
        text requested_by FK
        text approved_by FK
        text policy_id FK
        text proposal_id FK "nullable"
        text approval_id FK "nullable"
        text source "manual | policy | ai_approved"
        datetime started_at
        datetime finished_at
        text error
    }

    policies {
        text id PK
        text name
        json scope
        json rules
        boolean enabled
        integer priority
    }

    audit_logs {
        text id PK
        text actor_user_id FK "nullable for system"
        text actor_label
        text action
        text target
        json before
        json after
        text reason
        text ip
        datetime ts
    }

    settings {
        text key PK
        json value
        datetime updated_at
    }
```

---

## 2. テーブル補足

### 2.1 ポートのスコープ

WSL 3.x では distro 間でネットワーク名前空間が共有されるため、`ports.scope` は `windows` / `wsl` の 2 値。

- `pid_host_id` は「PID を観測できた WSL distro」。他 distro からは `pid=null` に見える
- 停止・再起動は `pid_host_id` の distro 内で実行する
- 同じポートが複数 distro から見えるため、保存時は `(scope, protocol, address, port)` で upsert する
- Windows 側の `wslrelay.exe` は `scope=windows` のまま残し、UI で「WSL フォワーディング」と注記する

### 2.2 サービスの PID と外部サービス同一性

- `control_mode=spawn` のサービスは起動したプロセスの Windows PID を `services.pid` に保存する
- WSL サービスは `wsl.exe` の Windows PID を保存する。`services.pid_scope` は `NULL`
- 停止は `taskkill /PID <pid> /T /F` でプロセスツリーごと行う。WSL でも Linux 側プロセスが終了することを実機確認済み
- `control_mode=windows-service` は NSSM / WinSW / ネイティブの SCM サービスとし、同一性は PID ではなく `service_name` で判定する
- windows-service の PID は SCM 状態から観測する診断情報であり、停止操作では `sc.exe stop` を使い `taskkill` を使わない
- `ports.pid_host_id`（観測できた distro）と `services.pid_scope` は用途が異なる。前者はポートスキャン、後者は旧方式の互換用

### 2.3 ログの粒度

- `log_events` は 1 行 1 ログ。`ts` は UTC（ISO 8601）で保存
- `host_id` は実行ホスト（Windows / WSL distro）。ポートの `scope` とは別
- 検索用に `message` の全文インデックス（SQLite は FTS5、PostgreSQL は `tsvector`）を用意
- `fingerprint` は正規化したメッセージ（数値・ID・パスをマスク）のハッシュ

### 2.4 インシデントの重複排除

- 同一 `service_id` + `fingerprint` が既定 10 分以内に再発した場合は既存インシデントに `incident_events` を追加
- プロセスの異常終了とヘルス劣化は同じ原因として `service-failure:<serviceId>` に集約する
- ハートビート / エラーログ / パターン監視は `heartbeat:<serviceId>` / `logs:<serviceId>` / `pattern:<serviceId>:<hash>` を使う
- 解決後も 10 分以内なら再オープン
- `status` 遷移: `open` → `acked` → `approval` → `resolved`（再発・失敗時は `open` に戻す）

### 2.5 承認とアクション

- `approvals.requested_action` は `{ "type": "restart", "serviceId": "...", "reason": "..." }` の JSON
- `approvals.requested_by` は承認要求の作成者。監視エンジン由来は `NULL` で、operator / admin が承認できる。ユーザー起因の要求は自己承認を許可しない
- 承認後に `actions` を作成し、実行結果を `actions.status` に反映。承認 API は `202` を返して非同期に再起動する
- デプロイは `actions.type=deploy`。コマンド実行、`[deploy]` ログ取り込み、必要に応じた再起動とヘルス確認を 1 つの action で扱う
- 復旧確認はヘルスチェック成功 + 安定待ち。ヘルスチェックがないサービスは 3 秒間 `running` を維持できるかで判定する
- `actions.requested_by` / `approved_by` は実装上はメールアドレス文字列。システム起因は `system:auto` / `system:auto-retry`
- 復旧成功時は同一サービスの未解決インシデントも自動解決する

### 2.6 設定の秘密値

- `settings.value` に SMTP パスワードや AI API キーを入れる場合、アプリ層で AES-256-GCM 暗号化した文字列を保存
- 暗号鍵は `SESSION_SECRET` から SHA-256 で導出する。`SESSION_SECRET` を変更すると保存済みパスワードは復号できない
- 保存形式は `v1:<iv>:<tag>:<ciphertext>`（base64）。IV は保存ごとにランダム
- API 応答では平文を返さず、`passwordSet` などのフラグだけを返す
- env の SMTP 設定より DB の `settings.mail` を優先する。送信先が空の場合は有効な admin / operator にフォールバックする

### 2.7 自動再起動の安全装置

- 段階は `services.auto_restart_phase` の `observe` / `approve` / `auto`
- `observe` は通知のみ、`approve` はインシデントごとに `approvals` を作成、`auto` はポリシー評価後に再起動
- クールダウン、ウィンドウ内の最大試行回数、クラッシュループ（同一サービスが短期間に 3 回異常終了）、前回の復旧確認失敗でエスカレーション
- 自動再起動は `AUTO_RESTART_BACKOFF_SEC` の指数バックオフに従う
- 復旧確認に失敗した `auto` の再試行は最大試行回数まで。上限に達したら `critical` に昇格して通知する

### 2.8 AI 分析・レポート・設定キー

- `settings.ai` は `{ baseUrl, model, apiKeyCipher, maxInputTokens, temperature, timeoutSec, dailyRequestLimit, sendLogsExternally }`。`apiKeyCipher` は `v1:<iv>:<tag>:<ciphertext>`
- `settings.retention` は `{ logDays }`。未設定時は `LOG_RETENTION_DAYS` を使う
- `ai_analyses.result` は `analysisResultSchema` の JSON。`provider=openai-compatible` が実 LLM、`template` がルールベースのフォールバック
- 同一 fingerprint の実 LLM 分析は 30 分キャッシュし、`ai_analyses` に履歴を残す
- `reports.body` は Markdown。`format` は現状 `markdown` のみ生成する
- `report_deliveries` は将来のメール送信用。レポート送信 API は未実装
- `audit_logs` は設定変更・承認・再起動・kill・レポート生成・バックアップを記録。秘密値は `before` / `after` に含めない

### 2.9 バックアップ

- `pnpm db:backup` / `POST /api/admin/backup` は better-sqlite3 の online backup を使い、DB と同じディレクトリの `backups/` に `sys4sys-<timestamp>.db` を作成する
- 復元時は API を停止し、`-wal` / `-shm` を削除してからバックアップを `DATABASE_URL` のファイルに戻す

### 2.10 AI 提案アクション

- AI 分析は `recommended_actions` のうち、許可された種別（Phase 1 は `restart` / `start`、`stop` は admin 限定フラグ）だけを `incident_action_proposals` に保存する
- 対象サービスは AI の `target` 文字列ではなく、インシデントの `service_id` を正とする。`target` がサービス名 / ID と一致しない提案は破棄する
- フォールバック分析（`provider=template`）、信頼度不足、期限切れ、重複提案は保存しない
- 実行可能な提案が 1 つ以上ある場合、分析完了時に主提案を選び、`approvals(source=ai, proposal_id=...)` を 1 件だけ自動作成する。自動承認は行わない
- 主提案はサービス状態が `stopped` / `failed` なら `start`、それ以外は `restart` を優先し、次にリスク、信頼度、AI の出力順で選ぶ
- 同一インシデントの pending 承認は 1 件まで。他の提案は `proposed` のまま残り、却下・期限切れ後に明示的に再依頼できる
- 手動分析の実行者は `analysis_requested_by` に保存し、そのユーザーによる自己承認を禁止する。自動分析は `NULL`
- 承認期限は既定 30 分（`AI_ACTION_TTL_MIN`）。期限切れは `approvals` と提案を `expired` にし、インシデントを `open` に戻す
- 高リスク提案は admin のみ承認できる。`stop` は `AI_ACTION_STOP_ENABLED=true` かつ admin のみ
- 承認後は `actions(source=ai_approved, proposal_id, approval_id)` を作成し、既存の deterministic な start / restart / stop 経路だけを実行する。任意コマンドや shell は実行しない
- 実行前・実行開始時にインシデント、提案、承認、サービス、デプロイロック、提案時スナップショットを再検証する。不一致は `expired` / stale とし、再分析を促す
- 失敗時の自動再試行は行わない。成功時は他提案を `superseded`、インシデントを `resolved` にする（`stop` は意図的停止として解決しない）

### 2.11 デプロイ

- `services.deploy` は `{ command, cwd?, env?, timeoutSec, restartAfter, healthTimeoutSec, requireApproval?, serviceControlOwner? }` の JSON。`command` は `SERVICE_COMMAND_ALLOWLIST` に従う
- windows-service の deploy には `serviceControlOwner=sys4sys | script` が必要。`sys4sys` は SCM stop → deploy.command → SCM start → health を実行し、`script` は sys4sys が stop/start しない
- windows-service で `restartAfter` は `sys4sys` なら `true`、`script` なら `false` に正規化される。spawn では `restartAfter` をそのまま使う
- `requireApproval=true` のサービスでは即時 deploy を拒否し、`deploy_requests` の承認を必須にする
- `deploy_requests` は要求作成時点の deploy 設定、control mode / service name / owner、env / deploy.env の SHA-256 ハッシュのみを `snapshot` に保存し、秘密値そのものは保存しない
- 承認時点で現在の deploy 設定・env / deploy.env のハッシュが要求作成時と一致しなければ 409。期限切れ要求も `expired` として 409 で拒否する
- `POST /api/services/:id/deploy` は `actions.type=deploy` を作成して `202` を返し、コマンドを非同期実行する。`deploy.requireApproval=true` の場合は `approval_required` と `deployRequestId` を 409 で返す
- `cwd` を省略した場合は `services.cwd` を使う。Windows ホストでは実行前にディレクトリの存在を確認する
- 実行ログは `log_events` に `[deploy]` プレフィックス、`fields.source="deploy"`、`fields.actionId` 付きで保存する。エラーログ件数・パターン監視の対象からは除外する
- `restartAfter=true` の場合はコマンド成功後にサービスを再起動し、`healthTimeoutSec` の間ヘルスチェックを待つ。失敗時は action と `services.last_deploy_*` を failed にする
- 同一サービスの多重デプロイは in-memory Set と DB の running deploy action の partial unique index で防止する。API 再起動時に `DEPLOY_STALE_MS` より古い running deploy だけ起動時 reconciliation で failed にする
- 手動 start / stop / restart、incident 自動再起動、ports kill は deploy 実行中を 409 で拒否するかスキップする

---

## 3. 制約・インデックス

| テーブル                    | 制約 / インデックス                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                     | `email` UNIQUE、`role` CHECK                                                                                                           |
| `sessions`                  | `token_hash` UNIQUE、`expires_at` INDEX                                                                                                |
| `hosts`                     | `(kind, distro)` UNIQUE（WSL）、`kind` CHECK                                                                                           |
| `services`                  | `(host_id, name)` UNIQUE、`(host_id, lower(service_name))` partial UNIQUE                                                              |
| `ports`                     | `(scope, protocol, address, port)` UNIQUE、`port` INDEX                                                                                |
| `port_history`              | `(scope, port, opened_at)` INDEX、`closed_at` INDEX                                                                                    |
| `port_reservations`         | `(protocol, port)` UNIQUE（Windows / WSL 横断）                                                                                        |
| `log_events`                | `(host_id, service_id, ts)` INDEX、`(fingerprint, ts)` INDEX                                                                           |
| `incidents`                 | `(fingerprint, started_at)` INDEX、`status` INDEX、`service_id` INDEX                                                                  |
| `incident_events`           | `incident_id` INDEX                                                                                                                    |
| `incident_action_proposals` | `(incident_id, status)` INDEX、`(service_id, status)` INDEX、`approval_id` INDEX、`action_id` INDEX、`(incident_id, dedupe_key)` INDEX |
| `approvals`                 | `status` INDEX、`incident_id` INDEX、`proposal_id` INDEX                                                                               |
| `deploy_requests`           | `status` INDEX、`(service_id, requested_at)` INDEX                                                                                     |
| `actions`                   | `(service_id, started_at)` INDEX、`proposal_id` / `approval_id` INDEX、running deploy partial UNIQUE                                   |
| `audit_logs`                | `(ts)` INDEX、`actor_user_id` INDEX                                                                                                    |
| `settings`                  | `key` PK                                                                                                                               |

外部キーは SQLite の `PRAGMA foreign_keys = ON` を前提。削除は原則ソフトデリートではなく、`is_active` / `enabled` で無効化する（ログ・監査の参照整合性を保つ）。

---

## 4. 保持・削除

| データ                                  | 保持                         |
| --------------------------------------- | ---------------------------- |
| `log_events`                            | 既定 14 日。日次で削除ジョブ |
| `incidents` / `reports` / `ai_analyses` | 無期限（手動削除のみ）       |
| `audit_logs`                            | 無期限                       |
| `sessions`                              | 期限切れから 7 日後に削除    |
| `report_deliveries`                     | 90 日                        |

---

## 5. マイグレーション方針

- Drizzle ORM の `drizzle-kit generate` で SQL を生成し、起動時に `migrate()` を実行
- SQLite → PostgreSQL の移行を見据え、以下を避ける
  - SQLite 固有の `AUTOINCREMENT` に依存した ID（ULID / UUID をアプリ側で生成）
  - `json1` 拡張前提の検索（JSON は保存のみ、検索は別カラム）
  - boolean の 0/1 前提（ORM で吸収）
