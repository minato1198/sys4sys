# sys4sys

sys4sys API を操作する CLI です。サービス・ログ・API トークン・デプロイを JSON で扱えます。
CLI は SQLite を直接操作せず、必ず API 経由で実行します。

## インストール

Node.js 22 以上が必要です。

```bash
npm install -g sys4sys@0.2.0
sys4sys version --json
sys4sys doctor --json
```

`npm install -g sys4sys@0.2.0` が成立するのは、tag `v0.2.0` で `Release CLI` workflow が publish 成功した後です。publish 前は `pnpm --filter sys4sys build` と `npm pack ./apps/cli` で配布物を確認できます。

`npx` で試す場合:

```bash
npx sys4sys@0.2.0 --help
npx sys4sys@0.2.0 schema --json
```

リポジトリから実行する場合は依存関係をインストールし、CLI をビルドします。

```bash
pnpm install
pnpm build:cli
pnpm sys4sys -- --help
```

`npm` 配布物には `dist`、`SKILL.md`、`README.md`、`LICENSE` だけが含まれます。`.env`、DB、ログ、テスト、`credentials.json`、ソース、個人パスは含まれません。

## 前提

sys4sys API が起動している必要があります。

```bash
pnpm dev:api
```

リポジトリから実行する場合は `pnpm sys4sys -- <command>` を使います。

```bash
pnpm sys4sys -- --help
```

## 導入確認

```bash
sys4sys version --json
sys4sys doctor --json
sys4sys doctor --strict
```

`doctor` は Node.js、API URL、API の到達性、認証、スコープ、トークン期限、資格情報ファイル、設定ディレクトリを確認します。秘密値は表示しません。API に到達できない場合も結果を返し、`--strict` では警告・エラーを exit 1 にします。

シェル補完を生成できます。

```bash
sys4sys completions bash
sys4sys completions zsh
sys4sys completions fish
sys4sys completions powershell
```

bash / zsh は `eval "$(sys4sys completions bash)"` のように読み込みます。PowerShell は生成されたスクリプトをプロファイルに追加してください。

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
- `services deploy` / `services deploy --request` は `operator` または `admin` が必要です。
- `deploy-requests approve` / `reject` は `approvals:decide` が必要です。即時 deploy と同じ role 制約に加え、要求者と承認者は原則別ユーザーです。
- `approvals approve` / `reject` は `approvals:decide` が必要です。`requestedBy` が自分と一致する承認は 403 になります。監視エンジン由来の `requestedBy = null` は system 承認として扱われます。
- `hosts create` / `hosts update` / `hosts detect` は `hosts:write`、一覧・詳細は `hosts:read` です。`--disable` は非対話で `--yes` が必要です。
- `ports reserve` / `release` / `kill` は `ports:operate`、一覧・履歴は `ports:read` です。
- `incidents ack` / `resolve` / `analyze` は operator / admin 権限と `incidents:write`、一覧・詳細は `incidents:read` です。
- `reports list` / `get` / `export` は `reports:read`、`audit list` は `audit:read`、設定系は `settings:read` / `settings:write` です。
- トークン認証では API のスコープが適用されます。admin ロールでも、トークンに必要なスコープを明示的に付与していないと 403 になることがあります。403 の場合は `requiredScope` と `sys4sys whoami --json` の `scopes` を確認してください。
- `services:secrets`（復号済み env の閲覧）は admin 専用です。CLI の `--show-env` はこの権限がないと成功しません。

## MCP

CLI は MCP（Model Context Protocol）サーバーを内蔵しています。AI クライアントから読み取り専用で使うのが基本です。

```bash
export SYS4SYS_API_URL="https://sys4sys.example.com"
export SYS4SYS_TOKEN="<token>"
sys4sys mcp serve
```

- transport は stdio のみです。
- `SYS4SYS_TOKEN` が必須です。保存済み資格情報・セッション Cookie・対話ログインは使いません。
- stdout は MCP プロトコル専用です。診断は stderr に出力されます。
- 読み取りツールは `whoami`、サービス一覧・詳細、ログ検索、インシデント、承認一覧、Schema です。
- 書き込みツールは `--allow-write`（または `SYS4SYS_MCP_ALLOW_WRITE=true`）と、一致するトークンスコープが必要です。
- 破壊的な書き込みツールは `confirm: true` が必須です。
- deploy は承認が必要な場合に要求を作成するだけで、自動承認しません。自己承認は API が 403 で拒否します。
- MCP 用トークンには管理者の全スコープを渡さず、読み取り専用から始めてください。

```bash
sys4sys mcp serve --allow-write
```

安全な設定とツール一覧は [docs/cli/MCP_SECURITY.md](../../docs/cli/MCP_SECURITY.md) を参照してください。

## コマンド

```bash
sys4sys whoami --json
sys4sys auth login
sys4sys auth logout --revoke-token
sys4sys auth status --json
sys4sys doctor --json
sys4sys version --json
sys4sys completions bash
sys4sys mcp serve

sys4sys hosts list --json
sys4sys hosts get <host-id> --json
sys4sys hosts detect --json
sys4sys hosts create --kind windows --name local --dry-run --json
sys4sys hosts update <host-id> --enable --json
sys4sys hosts update <host-id> --disable --yes --json

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

sys4sys incidents list --status open --severity error --json
sys4sys incidents get <incident-id> --json
sys4sys incidents ack <incident-id> --note "confirmed" --json
sys4sys incidents resolve <incident-id> --note "done" --yes --json
sys4sys incidents analyze <incident-id> --json

sys4sys approvals list --status pending --json
sys4sys approvals approve <approval-id> --note "restart ok" --yes --json
sys4sys approvals reject <approval-id> --note "not yet" --yes --json

sys4sys ports list --scope windows --json
sys4sys ports list --scope all --protocol tcp --port 3000 --json
sys4sys ports history --scope windows --port 3000 --json
sys4sys ports reserve --scope windows --port 3100 --protocol tcp --service <service-id> --json
sys4sys ports release <reservation-id> --yes --json
sys4sys ports kill 3000 --scope windows --yes --json

sys4sys reports list --incident <incident-id> --json
sys4sys reports get <report-id>
sys4sys reports export <report-id> --output ./report.md

sys4sys audit list --action deploy --limit 50 --json
sys4sys audit list --actor admin --target service:<service-id> --json

sys4sys settings mail get --json
sys4sys settings mail set --file mail.json --yes --json
sys4sys settings ai get --json
sys4sys settings ai set --file ai.json --dry-run --json
sys4sys settings ai test --json
sys4sys settings retention get --json
sys4sys settings retention set --file retention.json --yes --json
sys4sys settings backup --yes

sys4sys deploy-requests list --status pending --json
sys4sys deploy-requests get <request-id> --json
sys4sys services deploy <service-id> --request --note "release" --json
sys4sys deploy-requests approve <request-id> --note "release ok" --yes --wait --timeout 600 --json
sys4sys deploy-requests reject <request-id> --note "blocked" --yes --json

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
- `--limit` は最大 500、既定 100 です。大量ログでは `--service` と `--since` を必ず指定してください。
- `logs tail` の再接続は最大 10 回、バックオフは最大 30 秒です。`--no-reconnect` で無効化できます。

性能目標と制限の詳細は [docs/cli/PERFORMANCE.md](../../docs/cli/PERFORMANCE.md) を参照してください。10 万行の一時 DB を使うベンチマークを手元で実行できます。

```bash
node scripts/bench-cli.mjs --help
node scripts/bench-cli.mjs
```

主な制限:

| 項目                     | 値                 |
| ------------------------ | ------------------ |
| `logs query --limit`     | 最大 500、既定 100 |
| `logs tail` の再接続     | 最大 10 回         |
| `logs tail` のバックオフ | 最大 30 秒         |
| MCP のログ結果           | 最大 200 行        |
| API トークンの最大期限   | 365 日             |
| deploy 要求の期限        | 24 時間（設定可）  |

## インシデント

```bash
sys4sys incidents list --json
sys4sys incidents list --status open --severity error --service <service-id> --limit 50 --json
sys4sys incidents get <incident-id>
sys4sys incidents get <incident-id> --full
sys4sys incidents ack <incident-id> --note "対応中"
sys4sys incidents resolve <incident-id> --note "復旧確認済み" --yes
sys4sys incidents analyze <incident-id> --json
```

- `list` は `status` / `severity` / `service` / `limit` / `offset` で絞り込みます。
- `get` は events / approvals / actions / latest analysis / report を表示します。AI 分析全文が必要な場合は `--full`、または `--json` を使ってください。
- `ack` と `resolve` は `incidents:write` が必要です。`resolve` は非対話環境で `--yes` が必要です。
- `analyze` は AI 分析キューに投入するだけで、分析完了は `incidents get` の `analysis` / `report` で確認します。AI 未設定時は template 分析になることがあります。

## 承認

```bash
sys4sys approvals list --json
sys4sys approvals list --status pending --limit 20 --json
sys4sys approvals approve <approval-id> --note "再起動OK" --yes
sys4sys approvals reject <approval-id> --note "まだ準備未完成" --yes --json
```

- 既定では `pending` を一覧します。
- 承認一覧は `requestedBy` を表示します。`requestedBy = null` は system 由来の承認です。
- `approve` / `reject` は非対話環境で `--yes` が必要です。TTY でも対象のインシデント・サービス・要求アクションを表示します。
- `requestedBy` が操作ユーザーと一致する承認の `approve` は 403 です。監視エンジン由来の `requestedBy = null` は system 承認として許可します。
- 二重決定は 409 です。

## ホスト管理

```bash
sys4sys hosts list --json
sys4sys hosts get <host-id> --json
sys4sys hosts detect --json
sys4sys hosts create --kind windows --name local --dry-run --json
sys4sys hosts create --kind wsl --name Ubuntu --distro Ubuntu-22.04 --json
sys4sys hosts update <host-id> --name renamed --json
sys4sys hosts update <host-id> --disable --yes --json
```

- `hosts detect` は WSL distro を検出します。WSL が見つからない場合は 502 と分かりやすいエラーになります。
- Windows ホストは 1 つだけ登録できます。重複作成は 409 です。
- WSL ホストの作成には `--distro` が必須です。
- `--disable` はサービス停止につながるため、非対話環境で `--yes` が必要です。
- `--dry-run` は入力値を表示するだけで API を変更しません。

## ポート閲覧・予約・解放

```bash
sys4sys ports list --json
sys4sys ports list --scope windows --protocol tcp --port 3000 --grep node --json
sys4sys ports list --reservations --json
sys4sys ports history --scope windows --port 3000 --limit 50 --json
sys4sys ports reserve --scope windows --port 3100 --protocol tcp --service <service-id> --note "dev" --json
sys4sys ports release <reservation-id> --yes --json
```

- `ports list` はスキャンを行うため、環境によっては時間がかかります。
- `conflict` は人間向けの表で `!` 接頭辞を付けます。JSON 出力は `conflict: true` です。
- `history` は `--scope` と `--port` が必須です。
- `reserve` は `--protocol` と `--service` が必須です。競合・使用中は 409 です。
- `release` は非対話環境で `--yes` が必要です。

## ポート kill

```bash
sys4sys ports kill 3000 --scope windows --json
sys4sys ports kill 3000 --scope windows --yes --signal TERM --json
sys4sys ports kill 3000 --scope wsl --yes --signal KILL --pid <pid> --json
```

- 二段階です。まず kill token を取得し、対象 PID / プロセス / 期限を表示します。
- 非対話環境では `--yes` が必要です。
- `--signal` は `TERM` または `KILL` です。既定は `TERM` です。
- トークンが期限切れで 400 / 409 の場合は、`sys4sys ports kill <port> --scope <scope> --yes` を再実行してトークンを再取得してください。

## レポート

```bash
sys4sys reports list --json
sys4sys reports list --incident <incident-id> --limit 20 --json
sys4sys reports get <report-id>
sys4sys reports export <report-id>
sys4sys reports export <report-id> --format md --output ./report.md
sys4sys reports export <report-id> --format json --output ./report.json --force
```

- `--output` を省略すると stdout に出力します。ファイル書き込みは `--output <path>` です。
- 出力ファイルが既に存在する場合は `--force` がないと exit 2 です。
- `reports get` は既定で Markdown 本文を短く表示します。全文が必要な場合は `--full` または `--json` を使ってください。

## 監査ログ

```bash
sys4sys audit list --json
sys4sys audit list --action deploy --limit 50 --json
sys4sys audit list --actor <user-or-monitor> --target service:<service-id> --json
sys4sys audit list --since 2026-10-01T00:00:00Z --until 2026-10-02T00:00:00Z --json
```

- `--since` / `--until` は ISO 8601 です。
- 監査ログの `before` / `after` は秘密値を含めません。env 値やパスワードが監査ログに残っていないことを確認してください。

## 設定

```bash
sys4sys settings mail get --json
sys4sys settings mail set --file mail.json --dry-run --json
sys4sys settings mail set --file mail.json --yes
sys4sys settings ai get --json
sys4sys settings ai set --file - --dry-run < ai.json
sys4sys settings ai set --file ai.json --yes
sys4sys settings ai test --json
sys4sys settings retention get --json
sys4sys settings retention set --file retention.json --yes
sys4sys settings backup --dry-run
sys4sys settings backup --yes
```

- `settings mail set` / `settings ai set` / `settings retention set` / `settings backup` は非対話環境で `--yes` が必要です。
- メールパスワードと AI API key は JSON ファイル経由でのみ送ります。CLI は `--dry-run` 出力でパスワード/API key を `***` にします。
- 設定の GET 応答には秘密値そのものは含まれません。`passwordSet` / `apiKeySet` などの状態だけを表示します。

## デプロイ承認ワークフロー

`deploy.requireApproval` が `true` のサービスでは、即時 deploy が 409 `approval_required` になります。

```bash
sys4sys services deploy <service-id> --dry-run --json
sys4sys services deploy <service-id> --request --note "release 1.2.3"
sys4sys deploy-requests list --status pending --json
sys4sys deploy-requests get <request-id> --json
sys4sys deploy-requests approve <request-id> --note "release ok" --yes --wait --timeout 600 --json
sys4sys deploy-requests reject <request-id> --note "blocked" --yes --json
```

- `services deploy --request` は `POST /api/services/:id/deploy-requests` を作成します。
- 即時 deploy が `approval_required` を返した場合、CLI は exit 4 で `--request` を案内します。
- `pending` 要求が既に存在する場合は 409 と既存 `deployRequestId` を返します。
- 承認は要求者と別ユーザーであることが原則です。`DEPLOY_ALLOW_SELF_APPROVAL=true` の場合だけ自己承認を許可します。
- 承認時に現在の deploy 設定 / env スナップショットが要求作成時から変更されている場合は 409 になります。
- 期限切れ要求は `expired` になり、承認は 409 です。
- 承認成功後は status が `approved` から `executed` / `failed` に遷移します。`--wait` は期限まで status を追跡します。

## 出力

- `--json` を基本にしてください。人間向けの表は解析に使わないでください。
- `services actions` / `logs query` は `{ "items": [...], "nextCursor": "..." | null }` を返します。
- `--json` のエラーは `{ "error": { "message": "...", "status": 403, "requiredScope": "..." } }` 形式です。
- API の `services list` は env / deploy.env の値を返しません。詳細 API は値を `***` にマスクし、キー名だけ返します。
- `--show-env` を付けた `services get`、`services deploy --dry-run`、`--wait` 結果の表示では、admin 権限と `services:secrets` スコープがある場合に限って `GET /api/services/:id/secrets` を呼び、平文 env を表示します。表示前に stderr へ警告し、サーバー側は監査ログを記録します。
- `services list --show-env` は env 値を表示しません。平文 env が必要な場合は対象 ID を指定して `services get --show-env` を使ってください。

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
- 性能と制限: [docs/cli/PERFORMANCE.md](../../docs/cli/PERFORMANCE.md)
- 運用ガイド: [docs/cli/OPERATIONS.md](../../docs/cli/OPERATIONS.md)
- トークンローテーション: [docs/cli/TOKEN_ROTATION.md](../../docs/cli/TOKEN_ROTATION.md)
- MCP の安全性: [docs/cli/MCP_SECURITY.md](../../docs/cli/MCP_SECURITY.md)

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
- サーバー側は通常のサービス応答で env 値をマスクし、env / deploy.env の保存値を AES-256-GCM で暗号化します。CLI は保存暗号文を取得せず、`--show-env` は secrets API 経由でのみ平文値を取得します。`--show-env` の利用は最小限にしてください。
- インシデント・承認・ポート・レポート・監査ログ・設定・デプロイ承認の CLI は P1 で利用可能です。秘密値の取り扱いは `docs/SECURITY.md` と README の secrets 注意事項に従ってください。
- `credentials.json` は Git 管理対象外です。トークンをコミットしないでください。
