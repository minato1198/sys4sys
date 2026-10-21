# ER 図 / データモデル詳細

- 版: 1.0（M0 成果物）
- 対象: SQLite（初期） / PostgreSQL（将来）
- 正: `PLAN.md` の「6. データモデル」と本ドキュメント

---

## 1. ER 図

```mermaid
erDiagram
    users ||--o{ sessions : "has"
    users ||--o{ audit_logs : "acts"
    users ||--o{ approvals : "decides"

    hosts ||--o{ services : "runs"
    hosts ||--o{ log_sources : "provides"
    hosts ||--o{ ports : "pid attribution"

    services ||--o{ log_sources : "emits"
    services ||--o{ incidents : "has"
    services ||--o{ port_reservations : "reserves"
    services ||--o{ actions : "targets"

    incidents ||--o{ incident_events : "timeline"
    incidents ||--o{ approvals : "requires"
    incidents ||--o{ ai_analyses : "analyzed by"
    incidents ||--o{ reports : "generates"
    incidents ||--o{ actions : "executes"

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
        json command "string[] (allowlist)"
        text cwd
        json env
        json expected_ports
        json health_check
        json depends_on
        boolean auto_start
        text auto_restart_phase "observe | approve | auto"
        text status
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
        text detected_by "rule | health | process"
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

    approvals {
        text id PK
        text incident_id FK
        json requested_action
        text status "pending | approved | rejected | expired"
        datetime requested_at
        text decided_by FK
        datetime decided_at
        text note
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
        text type "start | stop | restart | kill"
        text status "pending | running | succeeded | failed"
        text requested_by FK
        text approved_by FK
        text policy_id FK
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

### 2.2 ログの粒度

- `log_events` は 1 行 1 ログ。`ts` は UTC（ISO 8601）で保存
- `host_id` は実行ホスト（Windows / WSL distro）。ポートの `scope` とは別
- 検索用に `message` の全文インデックス（SQLite は FTS5、PostgreSQL は `tsvector`）を用意
- `fingerprint` は正規化したメッセージ（数値・ID・パスをマスク）のハッシュ

### 2.3 インシデントの重複排除

- 同一 `service_id` + `fingerprint` が既定 10 分以内に再発した場合は既存インシデントに `incident_events` を追加
- 解決後も 10 分以内なら再オープン
- `status` 遷移: `open` → `acked` → `approval` → `resolved`（失敗時は `open` に戻す）

### 2.4 承認とアクション

- `approvals.requested_action` は `{ "type": "restart", "service_id": "..." }` のような JSON
- 承認後に `actions` を作成し、実行結果を `actions.status` に反映
- `actions.requested_by` / `approved_by` は `users.id`。システム起因は `NULL` + `audit_logs.actor_label = "system"`

### 2.5 設定の秘密値

- `settings.value` に SMTP パスワードや AI API キーを入れる場合、アプリ層で AES-256-GCM 暗号化した文字列を保存
- 鍵は OS 資格情報ストア（Windows Credential Manager）またはローカル鍵ファイル（`0600` 相当）
- API 応答では常にマスク（`********`）し、`GET /settings/*` で平文を返さない

---

## 3. 制約・インデックス

| テーブル            | 制約 / インデックス                                          |
| ------------------- | ------------------------------------------------------------ |
| `users`             | `email` UNIQUE、`role` CHECK                                 |
| `sessions`          | `token_hash` UNIQUE、`expires_at` INDEX                      |
| `hosts`             | `(kind, distro)` UNIQUE（WSL）、`kind` CHECK                 |
| `services`          | `(host_id, name)` UNIQUE                                     |
| `ports`             | `(scope, protocol, address, port)` UNIQUE、`port` INDEX      |
| `port_history`      | `(scope, port, opened_at)` INDEX、`closed_at` INDEX          |
| `port_reservations` | `(protocol, port)` UNIQUE（Windows / WSL 横断）              |
| `log_events`        | `(host_id, service_id, ts)` INDEX、`(fingerprint, ts)` INDEX |
| `incidents`         | `(fingerprint, started_at)` INDEX、`status` INDEX            |
| `approvals`         | `status` INDEX、`incident_id` INDEX                          |
| `actions`           | `(service_id, started_at)` INDEX                             |
| `audit_logs`        | `(ts)` INDEX、`actor_user_id` INDEX                          |
| `settings`          | `key` PK                                                     |

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
