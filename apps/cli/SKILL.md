---
name: sys4sys
description: Operate sys4sys services, logs, API tokens, and deployments through the sys4sys CLI. Use when the user asks to inspect service health, read logs, restart services, manage API tokens, or run deployments in sys4sys.
---

# sys4sys CLI

## When to use

sys4sys CLI は、sys4sys API を安全に操作するためのクライアントです。
次のような依頼で使います。

- サービスの状態・ヘルス・設定を確認する
- ログを検索する、またはリアルタイムに追う
- サービスを開始・停止・再起動する
- デプロイを実行する
- API トークンを発行・失効する
- CI / 自動化向けに JSON で結果を得る

P0 の CLI にはインシデント・承認・レポートのコマンドはありません。
これらは Web UI または API を利用してください。

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
- 非対話環境では `stop` / `restart` / `delete` / `tokens revoke` / `deploy` に `--yes` が必要です。`--yes` なしは exit 2 です。
- `services delete` は実行中サービスの場合 API が 409 Conflict を返します。先に停止してください。
- `env` / `deploy.env` は既定で `***` にマスクされます。`--show-env` は原則使わないでください。必要な場合も管理者権限・監査・会話への貼り付け禁止を徹底してください。
- ログには秘密情報が含まれることがあります。外部 AI・Issue・PR に貼る前に内容を確認してください。
- トークン全文は発行時に一度だけ表示されます。標準出力をログに残さないでください。
- P1 以降、deploy が承認制になった場合は `--request` を使います（P0 にはありません）。

## Command reference

グローバルオプション: `--api <url>`, `--json`, `--help`。

### 認証

```bash
sys4sys auth login --api <url>
sys4sys auth logout --revoke-token
sys4sys auth status --json
sys4sys whoami --json
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
- `logs tail` は SSE を受信します。切断時は指数バックオフで再接続し、最大 10 回で停止します。`--no-reconnect` で無効化できます。
- `logs tail --json` は 1 行 1 JSON（NDJSON）です。Ctrl+C で終了します。
- 401 / 403 では再接続しません。

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

### Schema

```bash
sys4sys schema --json
sys4sys schema services list --json
sys4sys schema tokens create
```

- `--json` は機械可読なコマンド契約です。AI / MCP はこちらを使います。
- `--md`（既定）は人間向けリファレンスです。
- リポジトリ内の生成物は `docs/cli-schema.json` です。変更後は `pnpm schema:generate` で更新してください。

## JSON output

- `--json` を基本にしてください。人間向け表は解析に使わないでください。
- `services list` は配列、`services get` はオブジェクトです。
- `services actions` / `logs query` は `{ "items": [...], "nextCursor": "..." | null }` です。
- `logs tail --json` はストリームごとに 1 JSON オブジェクトです。
- `--json` のエラーは `{ "error": { "message": "...", "status": 403, "requiredScope": "..." } }` 形式です。
- `env` / `deploy.env` の値は、`--show-env` を明示しない限り `***` です。

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

`dry-run` でコマンド・CWD・タイムアウトを確認します。`env` は表示されません。

### CI 用トークンの発行

```bash
sys4sys tokens create --name ci --scope services:read --scope logs:read --expires-in 30 --json
```

発行したトークンは一度しか表示されません。安全なシークレットストアに保存し、会話やリポジトリに残さないでください。

## Troubleshooting

- **exit 3 + `requiredScope`**: トークンのスコープ不足です。`sys4sys whoami --json` / `sys4sys auth status --json` で現在のスコープを確認し、必要なら `tokens create` で部分集合のトークンを発行します。
- **exit 4 (409)**: サービスが実行中、または状態が競合しています。`services get` で状態を確認し、必要なら停止後に再実行します。
- **exit 2 で `--yes` を求められる**: 非対話環境では `--yes` が必要です。対象を確認してから付与してください。
- **401**: トークンの失効・期限切れ、または API URL の誤りです。`auth status --json` を確認してください。トークン経路では自動再ログインしません。
- **tail が接続を繰り返す**: ネットワークまたは API の状態を確認してください。10 回で停止します。`--no-reconnect` で単発実行できます。
- **資格情報ファイルが壊れている**: CLI は自動削除しません。`sys4sys auth login` で上書きするか、手動で確認してください。

## Do not

- `env` / `deploy.env` の値を会話・Issue・PR・外部 AI に貼らない。
- トークン全文をコミット・ログ出力・シェル履歴に残さない。
- `--show-env` を常用しない。
- 対象サービスを確認せずに `stop` / `restart` / `delete` / `deploy` を実行しない。
- API を直接叩いて CLI の確認・監査を迂回しない。
- 実行中サービスを停止せずに `services delete` しない。
