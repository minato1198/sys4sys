# @sys4sys/cli

sys4sys API を操作する CLI です。サービス・ログ・API トークン・デプロイを JSON で扱えます。
CLI は SQLite を直接操作せず、必ず API 経由で実行します。

## 前提

sys4sys API が起動している必要があります。

```bash
pnpm dev:api
```

リポジトリから実行する場合は `pnpm sys4sys -- <command>` を使います。

```bash
pnpm sys4sys -- --help
```

## 認証

### API トークン（推奨）

```powershell
$env:SYS4SYS_API_URL = "http://127.0.0.1:8787"
$env:SYS4SYS_TOKEN = "s4s_..."
```

```bash
export SYS4SYS_API_URL="http://127.0.0.1:8787"
export SYS4SYS_TOKEN="s4s_..."
```

トークンをファイルから読む場合:

```bash
export SYS4SYS_TOKEN_FILE="$HOME/.config/sys4sys/token"
```

### 対話ログイン

```bash
sys4sys auth login
sys4sys auth status --json
sys4sys whoami --json
sys4sys auth logout --revoke-token
```

- `auth login` はメール/パスワードでセッションを作り、資格情報を保存します。既存のトークンや `SYS4SYS_TOKEN` は使いません。
- パスワードは `--password-stdin` または hidden prompt で入力します。
- `auth logout --revoke-token` は保存済みトークンを API で失効してからローカル資格情報を削除します。
- `SYS4SYS_TOKEN` / `SYS4SYS_TOKEN_FILE` は環境変数なので、`auth logout` では失効しません。

資格情報の保存先:

- `SYS4SYS_CONFIG_DIR` が設定されていれば `$SYS4SYS_CONFIG_DIR/credentials.json`
- Windows: `%APPDATA%\sys4sys\credentials.json`
- macOS / Linux: `$XDG_CONFIG_HOME/sys4sys/credentials.json` または `~/.config/sys4sys/credentials.json`

ディレクトリは `0700`、ファイルは `0600` を best-effort で設定します。壊れた資格情報ファイルは自動削除しません。

### 認証情報の優先順位

1. `SYS4SYS_TOKEN`
2. `SYS4SYS_TOKEN_FILE`
3. 保存済みトークン
4. `SYS4SYS_SESSION_COOKIE`
5. 保存済みセッション Cookie
6. `SYS4SYS_EMAIL` + `SYS4SYS_PASSWORD`

`--api` / `SYS4SYS_API_URL` は API URL として別に優先されます。

## トークン管理

```bash
sys4sys tokens list --json
sys4sys tokens list --user <user-id> --json
sys4sys tokens create \
  --name ci \
  --scope services:read \
  --scope logs:read \
  --expires-in 90 \
  --json
sys4sys tokens create --name local --scope services:read,logs:read --save
sys4sys tokens revoke <token-id> --yes
```

- `tokens create` には `tokens:manage` が必要です。
- 新しいトークンのスコープは、操作中のトークンが持つスコープの部分集合である必要があります。
- `--expires-in` は 1〜365 日、既定値 90 日です。
- `--save` は発行したトークンをローカル資格情報に保存します。環境変数のトークンが設定されている場合はそちらが優先されます。
- トークン全文は発行時に一度だけ表示されます。JSON 出力をログに残さないでください。
- 一覧と `auth status` はトークン全文を表示しません。

## 権限

- `services create` / `services update` は `admin` が必要です。
- `services deploy` は `operator` または `admin` が必要です。
- トークン認証では API のスコープが適用されます。403 の場合は `requiredScope` を確認してください。
- `services:secrets`（復号済み env の閲覧）は admin 専用です。CLI の `--show-env` はこの権限がないと成功しません。

## コマンド

```bash
sys4sys whoami --json
sys4sys auth login
sys4sys auth logout --revoke-token
sys4sys auth status --json

sys4sys hosts list --json
sys4sys services list --json
sys4sys services get <id> --json
sys4sys services create --file <path> --dry-run --json
sys4sys services update <id> --file <path> --dry-run --json
sys4sys services deploy <id> --dry-run

sys4sys services start <id> --json
sys4sys services stop <id> --yes --wait --json
sys4sys services restart <id> --yes --wait --json
sys4sys services delete <id> --yes --json
sys4sys services actions <id> --limit 20 --json

sys4sys logs query --service <id> --since 30m --json
sys4sys logs tail --service <id>
sys4sys logs tail --service <id> --json

sys4sys tokens list --json
sys4sys tokens create --name ci --scope services:read --json
sys4sys tokens revoke <token-id> --yes

sys4sys schema --json
sys4sys schema services list --json
```

## サービス登録・更新

`service.create.json` の `REPLACE_WITH_HOST_ID` と `cwd` は環境に合わせて変更してください。`hostId` は `hosts list` で確認できます。

```bash
sys4sys services create \
  --file apps/cli/examples/service.create.json \
  --dry-run \
  --json
```

```bash
sys4sys services create \
  --file apps/cli/examples/service.create.json \
  --json
```

deploy 設定の更新:

```bash
sys4sys services update <id> \
  --file apps/cli/examples/service.deploy-patch.json \
  --json
```

deploy の事前確認と実行:

```bash
sys4sys services deploy <id> --dry-run
sys4sys services deploy <id> --yes --wait --json
```

## ライフサイクルと確認

- `start` は確認不要です。
- `stop` / `restart` / `delete` / `tokens revoke` / `deploy` は、TTY では確認プロンプトを表示します。
- 非対話環境（CI、AI エージェント、`--json`）では `--yes` が必須です。`--yes` がない場合は exit 2 です。
- `--dry-run` は API を変更しません。対象の確認のため API は読み取ります。
- `services delete` は実行中サービスの場合 API が 409 Conflict を返します。先に停止してください。
- `--wait` は `services actions` をポーリングします。失敗時は exit 5、`--timeout` の既定値は 60 秒です。

## ログ

```bash
sys4sys logs query --service <id> --level error --since 30m --json
sys4sys logs query --host <id> --grep 'ECONNRESET' --limit 100 --json
sys4sys logs query --service <id> --cursor '<cursor>' --json
sys4sys logs tail --service <id>
sys4sys logs tail --service <id> --json --no-reconnect
```

- `--since` は `30s` / `15m` / `2h` / `1d` または ISO 8601 です。
- `--until` は ISO 8601 のみです。
- `--limit` は 1〜500、既定値 100 です。`nextCursor` を `--cursor` に渡して続きを取得します。
- `logs tail` は SSE を受信します。切断時は指数バックオフで再接続し、最大 10 回で停止します。
- `--no-reconnect` は再接続を無効化します。401 / 403 では再接続しません。
- `--json` の tail は NDJSON（1 行 1 JSON）です。Ctrl+C で終了します。
- ログには秘密情報が含まれることがあります。外部へ送る前に内容を確認してください。

## 出力

- `--json` を基本にしてください。人間向けの表は解析に使わないでください。
- `services actions` / `logs query` は `{ "items": [...], "nextCursor": "..." | null }` を返します。
- `--json` のエラーは `{ "error": { "message": "...", "status": 403, "requiredScope": "..." } }` 形式です。
- `env` / `deploy.env` は既定で `***` にマスクされます。表示する場合は `--show-env` を明示してください（`services list` の表には表示しません）。

## 終了コード

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 0    | success                                                       |
| 1    | general error / unexpected error                              |
| 2    | usage error（不正な引数、`--yes` 不足、入力スキーマ違反）     |
| 3    | auth error（401 / 403）                                       |
| 4    | conflict（409）                                               |
| 5    | async failure（デプロイ・ライフサイクルの失敗、タイムアウト） |

## Schema と AI 向けドキュメント

- 機械可読なコマンド契約: [docs/cli-schema.json](../../docs/cli-schema.json)
- AI エージェント向け手順書: [SKILL.md](./SKILL.md)

```bash
pnpm schema:generate
sys4sys schema --json
sys4sys schema services list
```

`schema` の生成物に時刻や秘密値は含めません。CI で差分を検出します。

## 注意

- CLI は SQLite を直接操作せず、必ず API 経由で実行します。
- `command` / `deploy.command` は `SERVICE_COMMAND_ALLOWLIST` に含まれる実行ファイルである必要があります。
- `deploy.env` に秘密情報を直接書かないでください。
- P0 時点ではサーバー側の env マスク・暗号化保存は未実装です。`--show-env` の利用は最小限にしてください。
- インシデント・承認・レポートの CLI は P1 以降です。P0 では Web UI または API を利用してください。
- `credentials.json` は Git 管理対象外です。トークンをコミットしないでください。
