---
name: sys4sys
description: Operate sys4sys services, hosts, ports, logs, incidents, approvals, reports, audit logs, settings, API tokens, and deployments through the sys4sys CLI. Use when the user asks to inspect service health, read logs, restart services, inspect incidents or approvals, manage ports, run deployments, or manage API tokens in sys4sys.
---

# sys4sys CLI

## When to use

sys4sys CLI は、sys4sys API を安全に操作するためのクライアントです。
次のような依頼で使います。

- サービスの状態・ヘルス・設定を確認する
- ログを検索する、またはリアルタイムに追う
- サービスを開始・停止・再起動する
- インシデント一覧・詳細・ack・resolve・AI 分析キューを確認する
- 監視エンジンやデプロイ承認の承認キューを approve / reject する
- ホスト一覧・詳細・WSL 検出・作成・更新を行う
- ポート一覧・履歴・予約・解放・kill の二段階操作を行う
- レポート一覧・取得・Markdown/JSON エクスポートを行う
- 監査ログと設定（メール / AI / 保持期間 / バックアップ）を確認・更新する
- デプロイを実行する
- API トークンを発行・失効する
- CI / 自動化向けに JSON で結果を得る
- AI クライアントから MCP 経由で読み取り・限定書き込みを行う

P1 の CLI はインシデント・承認・ホスト・ポート・レポート・監査ログ・設定・デプロイ承認に対応しています。P2 では MCP、npm 配布、`doctor`、`version`、シェル補完を追加しました。

## Setup

Node.js 22 以上が必要です。

```bash
npm install -g sys4sys@0.2.0
sys4sys version --json
sys4sys doctor --json
```

`doctor` は Node.js、API URL、API の到達性、認証、スコープ、トークン期限、資格情報ファイル、設定ディレクトリを確認します。秘密値は表示しません。`--strict` は警告・エラーで exit 1 にします。API 不到達でもクラッシュしません。

シェル補完:

```bash
sys4sys completions bash
sys4sys completions zsh
sys4sys completions fish
sys4sys completions powershell
```

## Authentication

### 推奨: 環境変数の API トークン

```bash
export SYS4SYS_API_URL="https://sys4sys.example.com"
export SYS4SYS_TOKEN="s4s_..."
```

- `SYS4SYS_TOKEN` はシェル履歴・会話・Issue・コミットに書かないでください。
- ファイルから読む場合は `SYS4SYS_TOKEN_FILE` を使います。
- トークンは `Authorization: Bearer <token>` として送信されます。

### 対話利用: メール/パスワードでログイン

```bash
sys4sys auth login --api https://sys4sys.example.com
sys4sys auth status --json
sys4sys whoami --json
```

- パスワードは `--password-stdin` または TTY の hidden prompt で入力します。引数では渡しません。
- `auth login` は既存のトークンや `SYS4SYS_TOKEN` を使わず、メール/パスワードでセッションを作ります。
- 資格情報は `SYS4SYS_CONFIG_DIR`、Windows の `%APPDATA%\sys4sys\credentials.json`、macOS/Linux の `$XDG_CONFIG_HOME/sys4sys/credentials.json` に保存されます。
- `auth logout --revoke-token` は保存済みトークンを API で失効してからローカル資格情報を削除します。`SYS4SYS_TOKEN` は失効しません。

### 資格情報の優先順位

1. `SYS4SYS_TOKEN`
2. `SYS4SYS_TOKEN_FILE`
3. 保存済みトークン
4. `SYS4SYS_SESSION_COOKIE`
5. 保存済みセッション Cookie
6. `SYS4SYS_EMAIL` + `SYS4SYS_PASSWORD`

`--api` / `SYS4SYS_API_URL` は API URL として別に優先されます。

## Safety rules

- 破壊的・状態変更操作の前に、対象 ID と `--dry-run` の結果を確認してください。
- 非対話環境では `stop` / `restart` / `delete` / `tokens revoke` / `deploy` / `hosts update --disable` / `ports release` / `ports kill` / `incidents resolve` / `approvals approve` / `approvals reject` / `deploy-requests approve` / `deploy-requests reject` / `settings ... set` / `settings backup` に `--yes` が必要です。`--yes` なしは exit 2 です。
- `services delete` は実行中サービスの場合 API が 409 Conflict を返します。先に停止してください。
- サーバー側は通常のサービス一覧・詳細応答で env 値を返しません。一覧ではキー名だけ、詳細では値が `***` になります。保存値はサーバー側で AES-256-GCM 暗号化され、CLI は暗号文を取得しません。`--show-env` は原則使わないでください。使用する場合は admin 権限と `services:secrets` スコープが必要で、CLI は secrets API を経由し、サーバー側は監査ログを記録します。
- ログには秘密情報が含まれることがあります。外部 AI・Issue・PR に貼る前に内容を確認してください。
- 監査ログは秘密値を `before` / `after` に保存しませんが、`reason` に入力メモがそのまま残ることがあります。`--note` にパスワードや API key を入れないでください。
- 設定ファイルのメールパスワードや AI API key は JSON ファイル経由でのみ送ります。`--dry-run` 出力では `***` にマスクされます。
- `approvals approve` は `requestedBy` が自分と一致する場合 403 です。`requestedBy = null` は system 承認です。二重決定は 409 です。
- デプロイ承認は要求者 / 承認者を分離してください。`deploy-requests approve` は `requestedBy` が一致すると 403 です。`DEPLOY_ALLOW_SELF_APPROVAL=true` のときだけ許可されます。
- 承認時に deploy 設定・env スナップショットが変わっている場合や期限切れの場合は 409 です。
- ポート kill は必ずトークン取得後の対象表示を確認してください。期限切れトークンは 400 / 409 になるため再取得が必要です。
- トークン全文は発行時に一度だけ表示されます。標準出力をログに残さないでください。

## Command reference

グローバルオプション: `--api <url>`, `--json`, `--help`, `--version`。`mcp serve` は `--transport stdio` と `--allow-write` を受け付けます。

### 認証・導入確認

```bash
sys4sys auth login --api <url>
sys4sys auth logout --revoke-token
sys4sys auth status --json
sys4sys whoami --json
sys4sys doctor --json
sys4sys doctor --strict --json
sys4sys version --json
```

### ホスト・サービス

```bash
sys4sys hosts list --json
sys4sys services list --json
sys4sys services list --host <host-id> --status running --json
sys4sys services get <id> --json
sys4sys services create --file <path> --dry-run --json
sys4sys services create --file <path> --json
sys4sys services update <id> --file <path> --dry-run --json
sys4sys services update <id> --file <path> --json
```

`services create` / `services update` は admin が必要です。`--file` はサービス作成・更新用 JSON です。

### ライフサイクル

```bash
sys4sys services start <id> --json
sys4sys services stop <id> --dry-run
sys4sys services stop <id> --yes --wait --json
sys4sys services restart <id> --dry-run
sys4sys services restart <id> --yes --wait --json
sys4sys services delete <id> --dry-run
sys4sys services delete <id> --yes --json
sys4sys services actions <id> --limit 20 --json
sys4sys services actions <id> --limit 20 --cursor '<cursor>' --json
```

- `start` は確認不要です。
- `stop` / `restart` / `delete` は TTY では確認プロンプト、非対話では `--yes` が必須です。
- `--wait` は `services actions` をポーリングして完了を待ちます。失敗時は exit 5 です。
- `--timeout <sec>` の既定値は 60 です。

### デプロイ

```bash
sys4sys services deploy <id> --dry-run
sys4sys services deploy <id> --yes --wait --json
```

`deploy` は operator または admin が必要です。失敗時は exit 5 です。

### ログ

```bash
sys4sys logs query --json
sys4sys logs query --service <id> --level error --since 30m --json
sys4sys logs query --host <id> --grep 'ECONNRESET' --since 2026-10-24T00:00:00Z --until 2026-10-24T12:00:00Z --json
sys4sys logs query --service <id> --limit 100 --cursor '<cursor>' --json
sys4sys logs tail --service <id>
sys4sys logs tail --service <id> --json
```

- `--since` は `30s` / `15m` / `2h` / `1d` または ISO 8601 です。
- `--until` は ISO 8601 のみです。
- `logs query` の `--limit` は 1〜500、既定値 100 です。`nextCursor` を `--cursor` に渡して続きを取得します。
- `logs tail` は SSE を受信します。切断時は指数バックオフで再接続し、最大 10 回・バックオフ最大 30 秒で停止します。`--no-reconnect` で無効化できます。
- `logs tail --json` は 1 行 1 JSON（NDJSON）です。Ctrl+C で終了します。
- 401 / 403 では再接続しません。
- 大量ログでは `--service` と `--since` を必ず指定してください。性能と制限は `docs/cli/PERFORMANCE.md` を参照します。

### トークン

```bash
sys4sys tokens list --json
sys4sys tokens list --user <user-id> --json
sys4sys tokens create --name ci --scope services:read --scope logs:read --expires-in 90 --json
sys4sys tokens create --name ci --scope services:read,logs:read --save
sys4sys tokens revoke <token-id> --yes --json
```

- `tokens create` には `tokens:manage` が必要です。新しいトークンのスコープは、操作中のトークンが持つスコープの部分集合でなければなりません。
- `--expires-in` は 1〜365 日、既定値 90 日です。
- `--save` は発行したトークンをローカル資格情報に保存します。環境変数のトークンが設定されている場合はそちらが優先されます。
- 発行時の JSON にはトークン全文が含まれます。ログに残さないでください。
- 一覧・`auth status` はトークン全文を表示しません。

### インシデント

```bash
sys4sys incidents list --status open --severity error --json
sys4sys incidents get <incident-id> --json
sys4sys incidents get <incident-id> --full
sys4sys incidents ack <incident-id> --note "confirmed"
sys4sys incidents resolve <incident-id> --note "done" --yes
sys4sys incidents analyze <incident-id> --json
```

- `ack` / `resolve` / `analyze` は `incidents:write` が必要です。
- `resolve` は非対話環境で `--yes` が必要です。
- `analyze` は AI 分析キューに投入します。完了は `incidents get` の `analysis` / `report` で確認します。

### 承認

```bash
sys4sys approvals list --status pending --json
sys4sys approvals approve <approval-id> --note "restart ok" --yes
sys4sys approvals reject <approval-id> --note "not yet" --yes --json
```

- `approvals:decide` が必要です。
- `requestedBy` が操作ユーザーと一致する承認の `approve` は 403 です。
- `requestedBy = null` は system 承認として扱います。
- 二重決定は 409 です。

### ホスト管理

```bash
sys4sys hosts get <host-id> --json
sys4sys hosts detect --json
sys4sys hosts create --kind windows --name local --dry-run --json
sys4sys hosts create --kind wsl --name Ubuntu --distro Ubuntu-22.04 --json
sys4sys hosts update <host-id> --disable --yes --json
```

- `hosts create` / `hosts update` / `hosts detect` は `hosts:write` が必要です。
- WSL 作成には `--distro` が必須です。Windows 重複は 409 です。
- `--disable` は非対話環境で `--yes` が必要です。

### ポート

```bash
sys4sys ports list --scope windows --protocol tcp --port 3000 --json
sys4sys ports history --scope windows --port 3000 --json
sys4sys ports reserve --scope windows --port 3100 --protocol tcp --service <service-id> --json
sys4sys ports release <reservation-id> --yes --json
sys4sys ports kill 3000 --scope windows --yes --json
sys4sys ports kill 3000 --scope wsl --yes --signal KILL --pid <pid> --json
```

- `ports list` / `ports history` は `ports:read`、`reserve` / `release` / `kill` は `ports:operate` が必要です。
- `ports list` はスキャンするため環境によって時間がかかります。
- `ports kill` は二段階です。まず kill token を取得して対象 PID / process / expires を確認し、`--yes` で kill を実行します。

### レポート・監査ログ

```bash
sys4sys reports list --incident <incident-id> --json
sys4sys reports get <report-id>
sys4sys reports export <report-id> --format md --output ./report.md
sys4sys audit list --action deploy --limit 50 --json
sys4sys audit list --actor <actor> --target service:<service-id> --json
```

- `reports` は `reports:read`、`audit` は `audit:read` が必要です。
- `reports export` はファイルが存在する場合 `--force` がないと exit 2 です。
- `audit list` の `--since` / `--until` は ISO 8601 です。

### 設定

```bash
sys4sys settings mail get --json
sys4sys settings mail set --file mail.json --dry-run --json
sys4sys settings mail set --file mail.json --yes
sys4sys settings ai get --json
sys4sys settings ai set --file ai.json --yes
sys4sys settings ai test --json
sys4sys settings retention get --json
sys4sys settings retention set --file retention.json --yes
sys4sys settings backup --yes
```

- 読み取りは `settings:read`、更新と backup は `settings:write` が必要です。
- メールパスワードと AI API key は JSON ファイル経由でのみ送ってください。
- 設定 GET には秘密値そのものは含まれません。`passwordSet` / `apiKeySet` などの状態だけを確認してください。

### デプロイ承認

```bash
sys4sys services deploy <service-id> --request --note "release"
sys4sys deploy-requests list --status pending --json
sys4sys deploy-requests get <request-id> --json
sys4sys deploy-requests approve <request-id> --note "release ok" --yes --wait --timeout 600 --json
sys4sys deploy-requests reject <request-id> --note "blocked" --yes --json
```

- `deploy.requireApproval` が `true` のサービスでは即時 deploy が 409 `approval_required` になります。
- `services deploy <service-id> --request` で承認要求を作成します。
- 承認は `approvals:decide` が必要です。要求者と承認者は原則別ユーザーです。
- 承認時に deploy 設定・env スナップショットが変わっている場合、期限切れ、または二重決定は 409 です。
- `--wait` は要求 status が `executed` / `failed` になるまで追跡します。失敗時は exit 5 です。

### MCP

```bash
export SYS4SYS_API_URL="https://sys4sys.example.com"
export SYS4SYS_TOKEN="<token>"
sys4sys mcp serve
sys4sys mcp serve --allow-write
```

- transport は stdio のみです。
- `SYS4SYS_TOKEN` が必須で、保存済み資格情報・セッション Cookie・対話ログインは使いません。
- stdout は MCP プロトコル専用です。診断は stderr に出します。
- 既定は読み取り専用です。書き込みは `--allow-write` または `SYS4SYS_MCP_ALLOW_WRITE=true`、一致するトークンスコープ、必要な `confirm: true` が揃った場合だけ有効です。
- deploy は承認が必要な場合に要求を作成するだけで、自動承認しません。自己承認は API が 403 で拒否します。
- MCP 用トークンは読み取り専用から始め、`tokens:manage` / `settings:write` / `services:secrets` を付けないでください。
- 詳細は `docs/cli/MCP_SECURITY.md` を参照します。

### Schema

```bash
sys4sys schema --json
sys4sys schema services list --json
sys4sys schema tokens create
```

- `--json` は機械可読なコマンド契約です。AI / MCP はこちらを使います。
- `--md`（既定）は人間向けリファレンスです。
- リポジトリ内の生成物は `docs/cli-schema.json` です。変更後は `pnpm schema:generate` で更新してください。

## Limits

- `logs query --limit`: 最大 500、既定 100。
- `logs tail`: 再接続 最大 10 回、バックオフ最大 30 秒。
- MCP のログ結果: 最大 200 行。
- API トークンの最大期限: 365 日。既定 90 日。
- deploy 要求の期限: 既定 24 時間、サーバー設定で最大 7 日。
- 同時 deploy 要求: サービスごとに 1 つ。
- 制限値の正は `apps/cli/src/limits.ts`、詳細は `docs/cli/PERFORMANCE.md`。

## JSON output

- `--json` を基本にしてください。人間向け表は解析に使わないでください。
- `services list` は配列、`services get` はオブジェクトです。
- `services actions` / `logs query` は `{ "items": [...], "nextCursor": "..." | null }` です。
- `logs tail --json` はストリームごとに 1 JSON オブジェクトです。
- `--json` のエラーは `{ "error": { "message": "...", "status": 403, "requiredScope": "..." } }` 形式です。
- `services list` は env 値を返しませんでした。`services get` の `env` / `deploy.env` は `***` マスクまたはキー名のみです。`--show-env` は admin 権限と `services:secrets` スコープがある場合だけ secrets API 経由で平文値を表示します。

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | success                                                                 |
| 1    | general error / unexpected error                                        |
| 2    | usage error（不正な引数、`--yes` 不足、入力スキーマ違反）               |
| 3    | auth error（401 / 403。`requiredScope` を確認）                         |
| 4    | conflict（409。実行中サービスの削除など）                               |
| 5    | async failure（デプロイ・ライフサイクルアクションの失敗、タイムアウト） |

## Common workflows

### サービス異常の調査

```bash
sys4sys services list --json
sys4sys services get <id> --json
sys4sys logs query --service <id> --level error --since 30m --json
```

`services get` の `health`、`lastError`、`lastDeployStatus` と、ログの `nextCursor` を確認します。

### 安全な再起動

```bash
sys4sys services get <id> --json
sys4sys services restart <id> --dry-run
sys4sys services restart <id> --yes --wait --json
sys4sys services actions <id> --limit 10 --json
```

対象 ID・名前・現在の状態を確認してから実行します。失敗時は exit 5 と action の `error` を確認します。

### ログ追跡

```bash
sys4sys logs tail --service <id> --level error
```

長時間の追跡は Ctrl+C で終了します。自動化では `--json --no-reconnect` を使い、必要に応じて `SIGTERM` で停止します。

### デプロイ

```bash
sys4sys services deploy <id> --dry-run
sys4sys services deploy <id> --yes --wait --json
```

`dry-run` でコマンド・CWD・タイムアウトを確認します。既定では env は表示されません。`--show-env` は admin 権限と `services:secrets` スコープがある場合だけ secrets API 経由で平文値を表示します。

### 承認制デプロイ

```bash
sys4sys services deploy <id> --request --note "release 1.2.3"
sys4sys deploy-requests list --status pending --json
sys4sys deploy-requests approve <request-id> --note "release ok" --yes --wait --timeout 600 --json
```

`services deploy` が 409 `approval_required` を返した場合は exit 4 で `--request` が案内されます。要求作成後は承認者を変えて `deploy-requests approve` を実行します。期限切れ・スナップショット変更・二重決定は 409 です。

### インシデントと承認

```bash
sys4sys incidents list --status open --severity error --json
sys4sys incidents get <incident-id> --json
sys4sys logs query --service <service-id> --level error --since 30m --json
sys4sys approvals list --status pending --json
sys4sys approvals approve <approval-id> --note "restart ok" --yes
```

`requestedBy` が自分と一致する承認は approve できません。system 承認 (`requestedBy = null`) は許可されます。

### CI 用トークンの発行

```bash
sys4sys tokens create --name ci --scope services:read --scope logs:read --expires-in 30 --json
```

発行したトークンは一度しか表示されません。安全なシークレットストアに保存し、会話やリポジトリに残さないでください。

## Troubleshooting

- **まず `sys4sys doctor --json`**: Node.js、API URL、API 到達性、認証、スコープ、トークン期限、資格情報、設定ディレクトリを確認します。秘密値は表示されません。
- **exit 3 + `requiredScope`**: トークンのスコープ不足です。`sys4sys whoami --json` / `sys4sys auth status --json` で現在のスコープを確認し、必要なら `tokens create` で部分集合のトークンを発行します。
- **exit 4 (409)**: サービスが実行中、承認が二重決定、ポート予約競合、Windows ホスト重複、または deploy 承認が必要な状態です。対象 ID と status を確認してください。
- **`approval_required`**: 対象サービスの `deploy.requireApproval` が `true` です。`sys4sys services deploy <service-id> --request` で承認要求を作成してください。
- **self approval 403**: 承認要求者と承認者が同じです。承認できる別ユーザーのトークン/セッションで `deploy-requests approve` を実行してください。
- **ports kill expired token**: `sys4sys ports kill <port> --scope <scope> --yes` を再実行して新しい確認トークンを取得してください。
- **exit 2 で `--yes` を求められる**: 非対話環境では `--yes` が必要です。対象を確認してから付与してください。
- **401**: トークンの失効・期限切れ、または API URL の誤りです。`auth status --json` を確認してください。トークン経路では自動再ログインしません。
- **tail が接続を繰り返す**: ネットワークまたは API の状態を確認してください。10 回で停止します。`--no-reconnect` で単発実行できます。
- **資格情報ファイルが壊れている**: CLI は自動削除しません。`sys4sys auth login` で上書きするか、手動で確認してください。
- **MCP の書き込みツールが出ない**: `--allow-write` とトークンスコープを確認してください。`sys4sys_whoami` でスコープを確認できます。
- **MCP の stdout が壊れる**: ラッパーやプロセス内で stdout にログを書いていませんか。診断は stderr に出してください。

## References

- `docs/cli/PERFORMANCE.md`: 性能目標・制限・ベンチマーク
- `docs/cli/OPERATIONS.md`: 導入・CI・障害時の切り分け・アップグレード
- `docs/cli/TOKEN_ROTATION.md`: トークン発行・配布・失効・漏洩対応
- `docs/cli/MCP_SECURITY.md`: MCP の安全な設定とツール一覧
- `docs/cli-schema.json`: 機械可読なコマンド契約

## Do not

- `env` / `deploy.env` の値を会話・Issue・PR・外部 AI に貼らない。
- `--note` に秘密値・API key・トークンを書かない。監査ログの `reason` に残ることがあります。
- トークン全文をコミット・ログ出力・シェル履歴に残さない。
- `--show-env` を常用しない。
- 対象サービスを確認せずに `stop` / `restart` / `delete` / `deploy` を実行しない。
- API を直接叩いて CLI の確認・監査を迂回しない。
- 実行中サービスを停止せずに `services delete` しない。
- 同一ユーザーで `deploy-requests approve` などの自己承認を常用しない。
- 期限切れまたはスナップショット変更後の deploy 承認を無理に通そうしない。
