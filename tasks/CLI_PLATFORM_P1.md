# P1 実装計画 — 運用全面と安全強化

- 親計画: `tasks/CLI_PLATFORM_PLAN.md`
- 前提: P0 完了（トークン、スコープ、サービスライフサイクル、ログ、Schema、SKILL）
- 対象: インシデント、承認、ホスト、ポート、レポート、監査、設定、シークレット、デプロイ承認
- 完了条件: 親計画の **P1 Gate** を満たす。
- ステータス: P1 実装完了。CLI / API / docs / tests / CI 更新済み。full API smoke は temp DB + admin password + local OpenAI-compatible mock で 96/96 確認済み（2026-10-25）

---

## 0. P1 の範囲

### やること

1. 運用者が Web UI と同等の主要操作を CLI で実行できるようにする。
2. 承認・監査・スコープを破壊的操作に徹底する。
3. `env` / `deploy.env` をサーバー側でマスクし、保存時に暗号化する。
4. デプロイ承認ワークフローを追加する。
5. Web UI と既存 API の互換性を維持する（必要な UI 変更を含む）。

### やらないこと

- MCP（P2）。
- npm 配布（P2）。
- 大規模な Web UI の再設計。
- マルチテナント / リモート公開。
- 暗号鍵の自動ローテーション（別 ADR）。

### P1 の安全原則

- 読み取り API は秘密値を返さない。復号値は専用エンドポイント + admin + 監査に限定する。
- 破壊的操作は `--dry-run` と `--yes` を提供する。
- 承認は要求者と別ユーザー。自己承認は既定で禁止。
- 監査ログに秘密値・トークン全文を残さない。
- API の互換性を壊す変更（env マスク）は、Web UI と CLI を同時に更新する。

---

## 1. PR 一覧

| ID    | タイトル                                     | 依存         | 目安 |
| ----- | -------------------------------------------- | ------------ | ---- |
| P1-01 | インシデント CLI                             | P0-04        | 1 PR |
| P1-02 | 承認 CLI と二重決定・自己承認の土台          | P0-04        | 1 PR |
| P1-03 | ホスト管理 CLI                               | P0-04        | 1 PR |
| P1-04 | ポート閲覧・予約・解放 CLI                   | P0-04        | 1 PR |
| P1-05 | ポート kill の二段階 CLI                     | P1-04        | 1 PR |
| P1-06 | レポート CLI                                 | P0-04        | 1 PR |
| P1-07 | 監査ログ CLI                                 | P0-04        | 1 PR |
| P1-08 | 設定 CLI                                     | P0-04        | 1 PR |
| P1-09 | サービス env の読み取りマスク API + Web 対応 | P0-04        | 1 PR |
| P1-10 | サービス env の保存時暗号化                  | P1-09        | 1 PR |
| P1-11 | デプロイ承認ワークフロー                     | P1-02, P1-09 | 1 PR |
| P1-12 | P1 ドキュメント・テスト・CI                  | P1-01..P1-11 | 1 PR |

---

## P1-01 インシデント CLI

### 目的

インシデントの一覧・詳細・ack/resolve・AI 分析を CLI で扱えるようにする。

### 変更

- 追加: `apps/cli/src/commands/incidents.ts`
- 変更: `apps/cli/src/index.ts`
- 変更: `apps/cli/src/commands/registry.ts`
- テスト: `apps/cli/src/commands/incidents.test.ts`

### コマンド

```bash
sys4sys incidents list [--status <status>] [--severity <severity>] \
  [--service <id>] [--limit <n>] [--offset <n>] [--json]
sys4sys incidents get <id> [--json]
sys4sys incidents ack <id> [--note <text>] [--json]
sys4sys incidents resolve <id> [--note <text>] [--yes] [--json]
sys4sys incidents analyze <id> [--json]
sys4sys incidents analysis <id> [--json]
```

### 挙動

- `list`:
  - `/api/incidents?status=&severity=&serviceId=&limit=&offset=`
  - 表: `ID`, `SEVERITY`, `STATUS`, `SERVICE`, `STARTED`, `TITLE`。
  - `total` を stderr に出す（JSON ではレスポンスに含める）。
- `get`:
  - `/api/incidents/:id`。イベント、承認、アクション、最新分析、レポートを表示。
  - 分析結果は長いため、既定では要約 + `--json` で全文。`--full` で全文表示。
- `ack`:
  - `POST /api/incidents/:id/ack`。`--note` は任意。
  - 非破壊的なので `--yes` 不要。
- `resolve`:
  - `POST /api/incidents/:id/resolve`。非対話では `--yes` 必須。
  - `--dry-run` は現在の status と解決予定を表示。
- `analyze`:
  - `POST /api/incidents/:id/analyze`。202 を表示。
  - `--wait` は P2 以降。P1 では `analysis` で確認する。
- `analysis`:
  - `GET /api/incidents/:id/analysis`。

### スコープ

- 読み取り: `incidents:read`
- ack/resolve/analyze: `incidents:write`

### テスト

- 一覧フィルタのクエリマッピング。
- `resolve` の `--yes` 必須。
- `ack` は `--yes` 不要。
- 404 / 409 / 403 の終了コード。
- `--json` が API 形状を保つ。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- incidents list --status open --json
pnpm sys4sys -- incidents get <id>
pnpm sys4sys -- incidents ack <id> --note "確認中"
pnpm sys4sys -- incidents resolve <id> --note "復旧確認" --yes
pnpm sys4sys -- incidents analyze <id>
pnpm sys4sys -- incidents analysis <id> --json
```

### 完了条件

- [x] 一覧/詳細/ack/resolve/analyze/analysis が CLI で動く。
- [x] `resolve` が非対話で `--yes` 必須。
- [x] 分析結果の全文と要約を出し分けられる。

---

## P1-02 承認 CLI と二重決定・自己承認の土台

### 目的

承認キューの確認と approve/reject を CLI で行えるようにし、二重決定と将来の自己承認を防ぐ。

### 変更

- 追加: `apps/cli/src/commands/approvals.ts`
- 変更: `apps/api/src/db/schema.ts`（`approvals.requestedBy` を追加）
- 変更: `apps/api/src/monitoring/incidents.ts`（`createApproval` / `decideApproval`）
- 変更: `apps/api/src/routes/approvals.ts`
- 変更: `packages/shared/src/api.ts`（承認レスポンス型）
- テスト: `apps/cli/src/commands/approvals.test.ts`, `apps/api/src/monitoring/incidents.test.ts`

### DB 変更

```ts
export const approvals = sqliteTable("approvals", {
  // ...
  requestedBy: text("requested_by"), // null = system / legacy
  // ...
});
```

- 既存行は `null` のまま（system 扱い）。
- 監視エンジンが作る承認は `requestedBy = null`。
- 将来の手動承認要求はユーザー ID を入れる。

### API 変更

- `GET /api/approvals` のレスポンスに `requestedBy` を追加。
- `POST /api/approvals/:id/approve` / `reject`:
  - `status = "pending"` の条件付き UPDATE に変更し、二重決定を 409 にする。
  - `approval.requestedBy` がユーザー ID で、実行者と一致する場合は 403（自己承認禁止）。`null` は system なので許可。
  - 決定とアクション作成を同一トランザクションにする（可能なら）。
- スコープ: `approvals:read` / `approvals:decide`。

### コマンド

```bash
sys4sys approvals list [--status pending|approved|rejected|expired] [--limit <n>] [--json]
sys4sys approvals approve <id> [--note <text>] [--yes] [--json]
sys4sys approvals reject <id> [--note <text>] [--yes] [--json]
```

- approve/reject は非対話で `--yes` 必須。
- 承認対象（サービス、インシデント、要求アクション、理由）を表示してから確認する。
- `--json` は API の決定レスポンスを返す。

### テスト

- 一覧の status フィルタ。
- approve/reject の `--yes` 必須。
- 二重 approve が 409。
- 自己承認が 403（requestedBy がユーザーの場合）。
- system 承認は許可。
- 監査に `approval.approved` / `approval.rejected` が残る。

### 検証

```bash
pnpm --filter @sys4sys/api test
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- approvals list --status pending
pnpm sys4sys -- approvals approve <id> --note "原因ログ確認済み" --yes
pnpm sys4sys -- approvals reject <id> --note "影響範囲が大きい" --yes
```

### 完了条件

- [x] 承認キューを CLI で確認・決定できる。
- [x] 二重決定が 409。
- [x] 自己承認の土台（requestedBy）が入り、system 承認は壊れない。

---

## P1-03 ホスト管理 CLI

### 目的

Windows / WSL ホストの一覧・登録・更新・WSL 検出を CLI で行えるようにする。

### 変更

- 変更: `apps/cli/src/commands/hosts.ts`
- 変更: `apps/api/src/routes/hosts.ts`（`GET /hosts/:id` を追加）
- 変更: `packages/shared/src/api.ts`（必要なら）
- テスト: `apps/cli/src/commands/hosts.test.ts`

### コマンド

```bash
sys4sys hosts list [--json]
sys4sys hosts get <id> [--json]
sys4sys hosts detect [--json]
sys4sys hosts create --kind <windows|wsl> --name <name> \
  [--distro <name>] [--user <name>] [--disabled] [--json]
sys4sys hosts update <id> [--name <name>] [--user <name>] \
  [--enable|--disable] [--json]
```

### 挙動

- `list`: 既存。
- `get`: `GET /api/hosts/:id` を追加。存在しなければ 404。
- `detect`: `POST /api/hosts/wsl/detect`。admin のみ。登録済みかどうかを表示。
- `create`:
  - `POST /api/hosts`。WSL は `--distro` 必須。
  - Windows ホストは 1 つだけ。409 を表示。
- `update`:
  - `PATCH /api/hosts/:id`。
  - `--disable` は非対話で `--yes` 必須（サービス停止につながるため）。
  - `--enable` は `--yes` 不要。
- `--dry-run` は create/update で入力を表示するだけ。

### スコープ

- 読み取り: `hosts:read`
- create/update/detect: `hosts:write`

### テスト

- WSL の `--distro` 必須。
- Windows の重複 409。
- `detect` の 502 表示。
- `--disable` の `--yes` 必須。
- `--dry-run` が API を変更しない。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- hosts list --json
pnpm sys4sys -- hosts detect
pnpm sys4sys -- hosts create --kind wsl --name Ubuntu --distro Ubuntu-22.04
pnpm sys4sys -- hosts update <id> --disable --yes
```

### 完了条件

- [x] ホストの一覧/詳細/登録/更新/検出が CLI で動く。
- [x] 無効化が確認付き。
- [x] WSL 未検出時に分かりやすいエラーになる。

---

## P1-04 ポート閲覧・予約・解放 CLI

### 目的

ポート一覧・履歴・予約・解放を CLI で扱えるようにする。

### 変更

- 追加: `apps/cli/src/commands/ports.ts`
- 変更: `apps/cli/src/index.ts`
- テスト: `apps/cli/src/commands/ports.test.ts`

### コマンド

```bash
sys4sys ports list [--scope all|windows|wsl] [--protocol tcp|udp] \
  [--port <n>] [--service <id>] [--grep <text>] [--json]
sys4sys ports history --scope <windows|wsl> --port <n> \
  [--protocol tcp|udp] [--since <iso>] [--until <iso>] [--limit <n>] [--json]
sys4sys ports reserve --scope <windows|wsl> --port <n> --protocol <tcp|udp> \
  --service <id> [--note <text>] [--json]
sys4sys ports release <reservation-id> [--yes] [--json]
```

### 挙動

- `list`:
  - `GET /api/ports?scope=&protocol=&port=&serviceId=&q=`
  - 表: `SCOPE`, `PROTO`, `PORT`, `PID`, `PROCESS`, `SERVICE`, `STATUS`。
  - `conflict` を強調（色は P2。P1 では `!` などの接頭辞）。
  - API はスキャンを行うため、遅い場合がある旨を README に書く。
- `history`:
  - `GET /api/ports/history?scope=&port=&protocol=&from=&to=&limit=`。
  - 表: `OPENED`, `CLOSED`, `PID`, `PROCESS`, `SERVICE`, `RELEASED BY`。
- `reserve`:
  - `POST /api/ports/reserve`。
  - 競合・使用中は 409。
  - 予約 ID を表示。
- `release`:
  - `DELETE /api/ports/reserve/:id`。
  - 非対話で `--yes` 必須。
- 予約一覧は `ports list` の `reservations` を表示する `--reservations` を追加してもよい（P1 内）。

### スコープ

- 読み取り: `ports:read`
- 予約/解放: `ports:operate`

### テスト

- フィルタのマッピング。
- 409 の表示。
- `release` の `--yes` 必須。
- 履歴の空結果。
- `--json` が API 形状を保つ。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- ports list --scope wsl --json
pnpm sys4sys -- ports history --scope windows --port 3000
pnpm sys4sys -- ports reserve --scope windows --port 3100 --protocol tcp --service <id>
pnpm sys4sys -- ports release <reservation-id> --yes
```

### 完了条件

- [x] 一覧/履歴/予約/解放が CLI で動く。
- [x] 競合が分かりやすく表示される。
- [x] 予約の競合が 409 になる。

---

## P1-05 ポート kill の二段階 CLI

### 目的

ポートを掴んでいるプロセスを、確認トークンを使って安全に停止できるようにする。

### 変更

- 変更: `apps/cli/src/commands/ports.ts`
- テスト: `apps/cli/src/commands/ports-kill.test.ts`

### コマンド

```bash
sys4sys ports kill <port> --scope <windows|wsl> \
  [--pid <pid>] [--pid-scope <scope>] \
  [--signal TERM|KILL] [--force] [--yes] [--json]
```

### フロー

1. `GET /api/ports/:port/kill-token?scope=&pid=&pidScope=` でトークンを取得。
2. 対象（PID、プロセス名、コマンドライン、ポート）を表示。
3. 確認（非対話は `--yes` 必須）。
4. `POST /api/ports/:port/kill` に `{ scope, pidScope, confirmToken, signal, force }` を送る。
5. 202 の action を表示。`--wait` は P2 でもよい（kill は即時性が高い）。

### 安全策

- トークンは CLI 内で取得し、ユーザーに貼らせない。
- トークンの有効期限が切れた場合は再取得を促す（自動再取得はしない）。
- `--force` は `KILL` と併用を推奨。`--force` 単独は API の既定に従う。
- システムプロセス / API 自身は API が 409 で拒否する。CLI はそのまま表示する。
- `--yes` なしの非対話は exit 2。
- kill の前に `ports list` で対象を確認するよう README / SKILL に書く。

### テスト

- トークン取得 → kill の 2 リクエスト。
- 確認トークン不一致 400。
- 期限切れ 400/409。
- `--yes` 必須。
- 409（状態変化）の表示。
- `--json` が action を返す。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- ports kill 3000 --scope windows --yes
pnpm sys4sys -- ports kill 3000 --scope wsl --pid 123 --signal TERM --yes
```

### 完了条件

- [x] 二段階の確認トークンフローが CLI で完結する。
- [x] 非対話で `--yes` 必須。
- [x] 状態変化・期限切れを安全に拒否する。

---

## P1-06 レポート CLI

### 目的

AI レポートの一覧・詳細・エクスポートを CLI で行えるようにする。

### 変更

- 追加: `apps/cli/src/commands/reports.ts`
- 変更: `apps/cli/src/index.ts`
- テスト: `apps/cli/src/commands/reports.test.ts`

### コマンド

```bash
sys4sys reports list [--incident <id>] [--limit <n>] [--offset <n>] [--json]
sys4sys reports get <id> [--json]
sys4sys reports export <id> [--format md|json] [--output <path|->] [--json]
```

### 挙動

- `list`: `/api/reports?incidentId=&limit=&offset=`。表: `ID`, `INCIDENT`, `SERVICE`, `CREATED`, `FORMAT`。
- `get`: `/api/reports/:id`。本文は既定で先頭 40 行。`--full` で全文。
- `export`:
  - `/api/reports/:id/export?format=md|json`。
  - `--output` がファイルなら書き込み、`-` なら stdout。
  - `--output` 省略時は stdout。既存ファイルは上書きしない（`--force` で許可）。
  - `--json` はメタデータ + `content` を返す（ファイル書き込み時は `path`）。
- メール再送は API 未実装のため提供しない。

### スコープ

- `reports:read`

### テスト

- 一覧/詳細のクエリ。
- `export --output` のファイル書き込み。
- 既存ファイルの上書き拒否。
- `--format json` のパース。
- 404。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- reports list --incident <id>
pnpm sys4sys -- reports get <id> --json
pnpm sys4sys -- reports export <id> --format md --output -
```

### 完了条件

- [x] レポートの一覧/詳細/エクスポートが CLI で動く。
- [x] 既存ファイルを誤って上書きしない。
- [x] Markdown / JSON の両方を扱える。

---

## P1-07 監査ログ CLI

### 目的

管理者が監査ログを CLI で検索できるようにする。

### 変更

- 追加: `apps/cli/src/commands/audit.ts`
- 変更: `apps/cli/src/index.ts`
- テスト: `apps/cli/src/commands/audit.test.ts`

### コマンド

```bash
sys4sys audit list [--actor <text>] [--action <text>] [--target <text>] \
  [--since <iso>] [--until <iso>] [--limit <n>] [--offset <n>] [--json]
```

### 挙動

- `GET /api/audit-logs?actor=&action=&target=&from=&to=&limit=&offset=`。
- 表: `TS`, `ACTOR`, `ACTION`, `TARGET`, `REASON`。
- `--json` は `before` / `after` を含む（秘密値が含まれないことは API 側の責任）。
- `--since` は ISO のみ（相対は P0 の `time.ts` を再利用してもよいが、監査では誤解を避けるため ISO 推奨）。
- admin 以外は 403。

### スコープ

- `audit:read`

### テスト

- フィルタのマッピング。
- 403 の表示。
- 空結果。
- `--json` の形状。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- audit list --action service.deploy --since 2026-10-01T00:00:00Z
```

### 完了条件

- [x] 監査ログを主要フィルタで検索できる。
- [x] 秘密値が CLI 出力に含まれない。

---

## P1-08 設定 CLI

### 目的

メール、AI、保持期間、バックアップの設定を CLI で扱えるようにする。

### 変更

- 追加: `apps/cli/src/commands/settings.ts`
- 変更: `apps/cli/src/index.ts`
- テスト: `apps/cli/src/commands/settings.test.ts`

### コマンド

```bash
sys4sys settings mail get [--json]
sys4sys settings mail set --file <mail.json|-> [--yes] [--json]
sys4sys settings mail test [--json]
sys4sys settings ai get [--json]
sys4sys settings ai set --file <ai.json|-> [--yes] [--json]
sys4sys settings ai test [--json]
sys4sys settings retention get [--json]
sys4sys settings retention set --file <retention.json|-> [--yes] [--json]
sys4sys settings backup [--yes] [--json]
```

### 挙動

- `get`:
  - mail: `passwordSet` のみ。パスワードは表示しない。
  - ai: `apiKeySet` のみ。API キーは表示しない。
  - retention: `logDays`。
- `set`:
  - `--file` から JSON を読む。パスワード / API キーを argv で受け取らない。
  - `clearPassword` / `clearApiKey` を受け付ける。
  - `--dry-run` はスキーマ検証と差分表示のみ（P1 で追加）。
  - 非対話は `--yes` 必須。
- `test`:
  - mail / ai の接続テスト。外部通信を行うため、`--yes` は不要だが、結果を表示。
- `backup`:
  - `POST /api/admin/backup`。非対話は `--yes` 必須。
  - バックアップ先パスとサイズを表示。パスは個人パスを含み得るため、`--json` でもそのまま返す（ローカル管理者向け）。

### スコープ

- 読み取り: `settings:read`
- 更新/テスト/バックアップ: `settings:write`

### テスト

- `get` が秘密値を含まない。
- `set` の `--file` 必須。
- `--yes` 必須。
- `clearPassword` / `clearApiKey`。
- 502（接続失敗）の表示。
- バックアップの出力。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- settings mail get --json
pnpm sys4sys -- settings mail set --file mail.json --yes
pnpm sys4sys -- settings mail test
pnpm sys4sys -- settings backup --yes
```

### 完了条件

- [x] 主要設定を CLI で取得・更新・テストできる。
- [x] 秘密値を argv で受け取らない。
- [x] バックアップを CLI から実行できる。

---

## P1-09 サービス env の読み取りマスク API + Web 対応

- ステータス: 実装完了（2026-10-25）

### 目的

API が `env` / `deploy.env` の値を既定で返さないようにし、復号値は監査付きの専用エンドポイントに限定する。

### 変更

- 変更: `apps/api/src/routes/services.ts`
- 変更: `packages/shared/src/api.ts`（レスポンス型）
- 変更: `apps/web/app/services/page.tsx`（編集フォーム）
- 変更: `apps/cli/src/commands/services.ts`（`--show-env` の取得元）
- テスト: `apps/api/src/routes/services.test.ts`, `apps/cli/src/commands/services.test.ts`, Web の手動確認

### API 変更

`GET /api/services/:id`:

```json
{
  "env": { "DATABASE_URL": "***", "LOG_LEVEL": "***" },
  "envKeys": ["DATABASE_URL", "LOG_LEVEL"],
  "deploy": {
    "command": ["pnpm", "deploy"],
    "env": { "API_TOKEN": "***" },
    "envKeys": ["API_TOKEN"]
  }
}
```

- 値は常に `"***"`。キー名は返す。
- `env` が `null` の場合は `null`。
- `deploy` が `null` の場合は `null`。
- `GET /api/services`（一覧）は `env` / `deploy.env` を返さない。CLI の `services list` も env 列を表示しない。Web の編集フォームは `GET /api/services/:id` を追加取得する。
- `GET /api/services/:id/secrets` を追加:
  - admin かつ `services:secrets` スコープが必要。
  - レスポンス: `{ env: Record<string,string> | null, deployEnv: Record<string,string> | null }`。
  - 監査: `service.secrets.reveal`, `target: service:<id>`。
  - `Cache-Control: no-store`。
- 監査ログの `before` / `after` に env を入れない。既存の `deployAuditValue` と同様のヘルパーを `envAuditValue` として追加。
- 書き込み時の `"***"` は **実値として保存しない**。`env` / `deploy.env` の値が `"***"` の場合は 422 で拒否する（マスク値をそのまま保存して秘密値を破壊する事故を防ぐ）。値を変更しない場合は `env` 自体を送らない。

### CLI 変更

- `services get` / `services list` は値を受け取らない。
- `--show-env`:
  - `GET /api/services/:id` の後に `GET /api/services/:id/secrets` を呼ぶ。
  - admin 以外、または `services:secrets` スコープがない場合は API が 403。CLI は「--show-env には admin 権限と services:secrets スコープが必要です」と表示。
  - 表示前に stderr に警告を出す。
- `services deploy --dry-run --show-env` も secrets エンドポイントを使う。
- `services create/update` の入力は従来どおり値を受け付ける（送信時のみ）。

### Web 変更

- 編集フォームを開くときは `GET /api/services/:id` を追加取得し、`envKeys` / `deploy.envKeys` を使う（一覧 API は env を返さないため）。
- 編集フォームの env / deploy.env は、既存値がマスクされている場合:
  - `envKeys` を表示し、値は空欄 + プレースホルダ `"***"`。
  - ユーザーが値を変更しなかった場合、PATCH に `env` を含めない（既存値を保持）。
  - 「Reveal」ボタン（admin のみ）で secrets エンドポイントを呼び、値を表示する。表示したことは監査に残る。
- 新規作成時は従来どおり値を入力できる。
- サービス一覧に env を表示しない。

### 互換性

- API の `env` の値が `"***"` になるため、既存の外部クライアントは影響を受ける。README と CHANGELOG に明記する。
- Web UI を同時に更新する。P1-09 の PR に含める。
- CLI の `--show-env` は API の secrets エンドポイントに切り替える。

### テスト

- `GET /services` に実値が含まれない。
- `GET /services/:id` に実値が含まれない。
- `GET /services/:id/secrets` が admin + `services:secrets` のみ。
- admin でも `services:secrets` のないトークンは 403。
- secrets 取得で監査が書かれる。
- viewer/operator は 403。
- CLI `--show-env` が secrets を呼ぶ。
- `env` に `"***"` を送ると 422。
- Web の編集で値を変更しないと既存値が保持される。
- 監査ログに env の値がない。

### 検証

```bash
pnpm --filter @sys4sys/api test
pnpm --filter @sys4sys/cli test
pnpm --filter @sys4sys/web build
pnpm sys4sys -- services get <id> --json
pnpm sys4sys -- services get <id> --show-env --json
```

### 完了条件

- [x] 通常の API 応答に env の値がない。
- [x] 復号値は admin + 監査付きエンドポイントだけ。
- [x] Web の編集で既存値を壊さない。
- [x] `--show-env` が新しい経路で動く。

---

## P1-10 サービス env の保存時暗号化

### 目的

`services.env` と `services.deploy.env` の値を保存時に暗号化し、DB ファイルに平文を残さない。

### 変更

- 変更: `apps/api/src/config.ts`（`SECRET_ENCRYPTION_KEY`）
- 変更: `.env.example`（`SECRET_ENCRYPTION_KEY` の説明。実値は入れない）
- 変更: `apps/api/src/settings/crypto.ts`（汎用の `encryptValue` / `decryptValue`）
- 追加: `apps/api/src/services/secrets.ts`（env の暗号化・復号・移行）
- 変更: `apps/api/src/routes/services.ts`（保存時に暗号化、実行時に復号）
- 変更: `apps/api/src/services/manager.ts`（起動時の env 復号）
- 変更: `apps/api/src/services/deploy.ts`（deploy env 復号）
- 追加: `apps/api/src/services/secrets.test.ts`
- 追加: `apps/api/src/db/migrations/*`（必要なら）
- 追加: `apps/api/src/db/encrypt-secrets-cli.ts`（任意の移行 CLI）

### 暗号化方式

- `SECRET_ENCRYPTION_KEY` を追加する。
  - production では 32 文字以上の必須。
  - 開発では未設定なら `SESSION_SECRET` から SHA-256 で導出する（既存の `settings/crypto.ts` と同じ考え方）。
- 値ごとに AES-256-GCM:
  - `v1:<iv base64>:<tag base64>:<ciphertext base64>`
- `encryptValue(plain)` / `decryptValue(payload)` を提供する。
- 既に `v1:` で始まる値は復号してから再暗号化しない（冪等）。
- `env` の JSON 形状は維持する:

```json
{
  "DATABASE_URL": "v1:...",
  "LOG_LEVEL": "v1:..."
}
```

- `deploy.env` も同様。

### 保存・読み取り

- 作成/更新時:
  - `env` / `deploy.env` の各値を暗号化して保存する。
  - 既に暗号化済みの値はそのまま（再暗号化しない）。
- 起動/deploy 時:
  - `decryptEnv(service.env)` で復号し、`spawn` に渡す。
  - 復号失敗時はサービス起動/deploy を失敗させ、`lastError` に「秘密値の復号に失敗しました」と記録する（値は出さない）。
- API 応答:
  - P1-09 のマスクを維持。復号値は secrets エンドポイントのみ。
- 監査:
  - env の値・暗号文を記録しない。キー名のみ。

### 既存データの移行

- 起動時に `migratePlaintextEnv()` を実行する。
  - `services.env` / `deploy.env` の値が `v1:` でなければ暗号化して更新する。
  - 冪等。失敗したサービスはログに警告し、起動は継続する（ただしそのサービスの env は平文のままなので、管理者に通知）。
- 大量データでも起動をブロックしないよう、バッチ（例: 100 件）で処理する。
- 手動実行用に `pnpm --filter @sys4sys/api db:encrypt-secrets` を用意する。

### テスト

- 暗号化 → 復号のラウンドトリップ。
- 異なる IV で同じ平文が異なる暗号文になる。
- 改ざんされた暗号文は復号失敗。
- 既存平文の移行が冪等。
- `v1:` で始まる平文（偶然）を二重暗号化しない。※ 値が `v1:` で始まる場合は暗号文とみなす。必要なら `enc:v1:` に変更する。
- サービス起動時に復号値が `spawn` に渡る（モック）。
- deploy 時に復号値が渡る。
- API 応答に暗号文・平文が出ない。
- 監査に値が出ない。

### 検証

```bash
pnpm --filter @sys4sys/api test
pnpm --filter @sys4sys/api db:encrypt-secrets
pnpm --filter @sys4sys/api smoke
```

### 完了条件

- [x] 新規/更新の env が暗号化される。
- [x] 既存データが移行される。
- [x] 起動/deploy が復号値で動く。
- [x] API / 監査 / ログに平文・暗号文が出ない。
- [x] 復号失敗時に安全に失敗する。

---

## P1-11 デプロイ承認ワークフロー

### 目的

デプロイを要求者と承認者で分離し、統制された本番デプロイを可能にする。

### 変更

- 変更: `packages/shared/src/api.ts`（`deployRequestSchema` など）
- 変更: `apps/api/src/db/schema.ts`（`deploy_requests`）
- 追加: `apps/api/src/routes/deploy-requests.ts`
- 変更: `apps/api/src/routes/services.ts`（`requireApproval` 時の 409）
- 変更: `apps/api/src/services/deploy.ts`（承認後の実行）
- 変更: `apps/api/src/config.ts`（`DEPLOY_REQUIRE_APPROVAL_DEFAULT`, `DEPLOY_REQUEST_TTL_MINUTES`, `DEPLOY_ALLOW_SELF_APPROVAL`）
- 変更: `.env.example`（上記の説明。実値は入れない）
- 追加: `apps/cli/src/commands/deploy-requests.ts`
- 変更: `apps/cli/src/commands/services.ts`（`--request`）
- 変更: `apps/web/app/services/page.tsx`（409 の表示と承認待ちへの誘導。最小限）
- テスト: `apps/api/src/routes/deploy-requests.test.ts`, `apps/cli/src/commands/deploy-requests.test.ts`

### サービス設定

`deployConfigSchema` に追加:

```ts
requireApproval: z.boolean().default(false),
```

- 既存の deploy 設定は `false` として扱う。
- 環境既定 `DEPLOY_REQUIRE_APPROVAL_DEFAULT=true` の場合、`requireApproval` が未指定なら true とする（保存時に明示化する）。
- **更新時の注意:** `services update` で `deploy` オブジェクトを送る際、`requireApproval` を省略した場合は既存値を保持する。Zod の `default(false)` によって意図せず false に戻らないよう、更新用スキーマでは `optional` にしてマージする。

### テーブル

```ts
export const deployRequests = sqliteTable(
  "deploy_requests",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "approved",
        "rejected",
        "expired",
        "executed",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    note: text("note"),
    actionId: text("action_id"),
    snapshot: text("snapshot", { mode: "json" })
      .$type<DeployRequestSnapshot>()
      .notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    index("deploy_requests_status_idx").on(table.status),
    index("deploy_requests_service_idx").on(table.serviceId, table.requestedAt),
  ],
);
```

`DeployRequestSnapshot`:

```ts
{
  command: string[];
  cwd: string | null;
  timeoutSec: number;
  restartAfter: boolean;
  healthTimeoutSec: number;
  envHash: string;       // env のキーと値の正規化ハッシュ（値は保存しない）
  deployEnvHash: string; // deploy.env の正規化ハッシュ（値は保存しない）
}
```

- `env` / `deploy.env` の値そのものは保存しない。代わりに、キーと値から作った SHA-256 を保存し、承認時に現在値と比較する。
- ハッシュは `SECRET_ENCRYPTION_KEY` ではなく、固定の正規化（キー昇順 + JSON）で計算する。値の変更を検知できればよい。暗号化移行後も同じ結果になるよう、**復号後の平文**で計算する。
- スナップショット全体を保存し、承認時に現設定と比較する。

### API

| メソッド | パス                                | 説明                          | スコープ           |
| -------- | ----------------------------------- | ----------------------------- | ------------------ |
| `POST`   | `/api/services/:id/deploy-requests` | 承認要求                      | `deploy:execute`   |
| `GET`    | `/api/deploy-requests`              | 一覧（status, limit, offset） | `deploy:execute`   |
| `GET`    | `/api/deploy-requests/:id`          | 詳細                          | `deploy:execute`   |
| `POST`   | `/api/deploy-requests/:id/approve`  | 承認 + 実行                   | `approvals:decide` |
| `POST`   | `/api/deploy-requests/:id/reject`   | 却下                          | `approvals:decide` |

- `POST /api/services/:id/deploy` は:
  - `requireApproval=false`: 従来どおり即時実行。
  - `requireApproval=true`: 409 `approval_required`。`deployRequestId` があれば返す。
- 要求:
  - 実行中の deploy がある場合は 409。
  - `pending` の要求が既にある場合は 409（既存 ID を返す）。
  - 期限は既定 24 時間。
- 承認:
  - `status = pending` の条件付き UPDATE。
  - `requestedBy !== actor.id`。`DEPLOY_ALLOW_SELF_APPROVAL=true` のときだけ許可。
  - 現在の deploy 設定と `snapshot` を比較。command / cwd / timeout / restartAfter / healthTimeoutSec / envHash / deployEnvHash が変わっていたら 409。
  - `beginDeploy` + `runDeploy` を実行し、`actionId` を保存。status は `approved` → `executed` / `failed` に遷移。
  - 監査 `deploy.request.approve` / `deploy.request.reject`。
- 却下:
  - `status = rejected`。監査。
- 期限切れ:
  - 一覧取得時または日次で `pending` かつ `expiresAt < now` を `expired` に更新。

### CLI

```bash
sys4sys services deploy <id> --request [--note <text>] [--json]
sys4sys deploy-requests list [--status pending] [--limit <n>] [--offset <n>] [--json]
sys4sys deploy-requests get <id> [--json]
sys4sys deploy-requests approve <id> [--note <text>] [--yes] [--json]
sys4sys deploy-requests reject <id> [--note <text>] [--yes] [--json]
```

- `services deploy <id>` が 409 `approval_required` を返したら、`--request` を案内する。
- `approve` は非対話で `--yes` 必須。対象サービス・コマンド・要求者・期限を表示する。
- `reject` も `--yes` 必須。
- `--wait` は承認後の action を追跡する（P0-08 の待機処理を再利用）。

### Web

- deploy ボタンが 409 `approval_required` を受けたら:
  - 「承認が必要です」と表示。
  - 既存の承認待ち ID があれば `/approvals` へ誘導。
- 承認 UI の完全対応は P2 以降。P1 では API/CLI を正とし、Web はエラー表示のみ。

### テスト

- `requireApproval=false` は従来どおり即時実行。
- `requireApproval=true` は 409 + `approval_required`。
- 要求の重複 409。
- 自己承認 403。
- 別ユーザー承認で deploy が実行される。
- スナップショット変更で 409。
- 期限切れで 409 / expired。
- 二重承認 409。
- 監査に要求・承認・却下が残る。
- CLI の `--request` / approve / reject。

### 検証

```bash
pnpm --filter @sys4sys/api test
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- services update <id> --file deploy-approval.json
pnpm sys4sys -- services deploy <id> --request --note "リリース 1.2.3"
pnpm sys4sys -- deploy-requests list --status pending
pnpm sys4sys -- deploy-requests approve <request-id> --yes
```

### 完了条件

- [x] 承認が必要なサービスでは即時 deploy が拒否される。
- [x] 別ユーザーが承認すると deploy が実行される。
- [x] 自己承認・古いスナップショット・二重承認が拒否される。
- [x] 既存の即時 deploy が無回帰。
- [x] Web が 409 を分かりやすく表示する。

---

## P1-12 P1 ドキュメント・テスト・CI

### 目的

P1 の変更をドキュメント・テスト・CI に反映し、運用可能な状態にする。

### 変更

- 変更: `apps/cli/README.md`（全コマンド、認証、スコープ、秘密値）
- 変更: `apps/cli/SKILL.md`（P1 コマンド、承認、秘密値の扱い）
- 変更: `docs/openapi.yaml`（新規 API: tokens, deploy-requests, secrets, service actions）
- 変更: `docs/ER.md`（`api_tokens`, `deploy_requests`, `approvals.requested_by`）
- 変更: `docs/adr/`（0002 tokens, 0003 credentials, 0004 secrets, 0005 deploy approval）
- 変更: `apps/api/src/smoke.ts`（P1 の統合チェック）
- 変更: `.github/workflows/ci.yml`（P1 テスト、Schema 差分）
- 追加: `apps/cli/docs/SECURITY.md`（トークン・秘密値の運用）

### テスト追加

- トークン失効後の CLI 操作が 401。
- スコープ不足の CLI 操作が 403。
- env マスクと secrets 取得。
- 暗号化移行後のサービス起動。
- デプロイ承認の E2E。
- 監査ログに秘密値がない。
- Web のサービス編集（手動 or Playwright は P2）。

### CI

```yaml
- name: CLI schema is up to date
  run: |
    pnpm schema:generate
    git diff --exit-code docs/cli-schema.json

- name: CLI tests
  run: pnpm --filter @sys4sys/cli test

- name: API tests
  run: pnpm --filter @sys4sys/api test
```

### 検証

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm --filter @sys4sys/web build
pnpm --filter @sys4sys/api smoke
pnpm audit --prod
```

### 完了条件

- [x] 全 P1 コマンドが README / SKILL に記載されている。
- [x] OpenAPI / ER が実装と一致する。
- [x] P1 の統合スモークが通る。
- [x] CI が Schema 差分と P1 テストを実行する。

---

## 2. P1 の実装順

1. `P1-09` 読み取りマスク + Web 対応（秘密値の土台）
2. `P1-10` 保存時暗号化
3. `P1-01` インシデント CLI
4. `P1-02` 承認 CLI + 二重決定
5. `P1-03` ホスト CLI
6. `P1-04` ポート閲覧/予約
7. `P1-05` ポート kill
8. `P1-06` レポート CLI
9. `P1-07` 監査 CLI
10. `P1-08` 設定 CLI
11. `P1-11` デプロイ承認
12. `P1-12` docs/tests/CI

P1-01 / P1-03 / P1-04 / P1-06 / P1-07 / P1-08 は P1-09/P1-10 と並列可。ただし P1-11 は P1-02 と P1-09 の後。

---

## 3. P1 のテストマトリクス

| ケース                                                      | 期待       |
| ----------------------------------------------------------- | ---------- |
| viewer が incidents ack                                     | 403        |
| operator が incidents resolve                               | 202        |
| 非対話 resolve（`--yes` なし）                              | exit 2     |
| 自己承認（deploy）                                          | 403        |
| 二重承認                                                    | 409        |
| スナップショット変更後の承認                                | 409        |
| `services get` に env 実値                                  | 含まれない |
| `services get --show-env`（operator）                       | 403        |
| `services get --show-env`（admin、`services:secrets` なし） | 403        |
| `services get --show-env`（admin + `services:secrets`）     | 値 + 監査  |
| 暗号文の改ざん                                              | 復号失敗   |
| 平文 env の移行                                             | 冪等       |
| 監査ログに env 値                                           | 含まれない |
| ポート kill のトークン期限切れ                              | 400/409    |
| 設定 get にパスワード/API キー                              | 含まれない |

---

## 4. P1 のリスクと戻し方

| リスク                         | 戻し方                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| env マスクで Web 編集が壊れる  | P1-09 で Web を同時更新。値を変更しない PATCH は env を送らない  |
| 暗号化移行で起動できない       | 移行を冪等・バッチ化。失敗サービスは平文のまま起動し、警告を出す |
| 鍵変更で復号不能               | `SECRET_ENCRYPTION_KEY` を固定。ローテーションは別 ADR           |
| デプロイ承認で既存運用が止まる | 既定 `false`。環境変数で段階的に有効化                           |
| 自己承認禁止で緊急対応できない | `DEPLOY_ALLOW_SELF_APPROVAL=true` を明示した場合のみ許可         |
| 監査ログの肥大化               | 既存の保持期間・ページングを維持。P2 で監査保持を検討            |

---

## 5. P1 完了チェックリスト

- [x] P1-01 インシデント CLI
- [x] P1-02 承認 CLI + 二重決定
- [x] P1-03 ホスト CLI
- [x] P1-04 ポート閲覧/予約
- [x] P1-05 ポート kill
- [x] P1-06 レポート CLI
- [x] P1-07 監査 CLI
- [x] P1-08 設定 CLI
- [x] P1-09 env 読み取りマスク + Web
- [x] P1-10 env 保存時暗号化
- [x] P1-11 デプロイ承認
- [x] P1-12 docs/tests/CI
- [x] `pnpm format:check && pnpm typecheck && pnpm test` が通る
- [x] `pnpm --filter @sys4sys/web build` が通る
- [x] `pnpm --filter @sys4sys/api smoke` が通る（temp DB + admin password + local OpenAI-compatible mock で 96/96）
- [x] Web UI のサービス編集・deploy が無回帰（web build + service masking/deploy env tests + CLI deploy テスト）
- [x] 公開リポジトリに secrets / DB / 個人パスがない（git status / git diff で DB・鍵・実 secrets・個人パス混入なし）
