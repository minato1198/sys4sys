# sys4sys CLI セキュリティ

このドキュメントは `sys4sys` CLI が API トークン、資格情報、秘密値、承認操作、デプロイをどう扱うかを説明する。CLI は sys4sys API を操作するクライアントであり、SQLite を直接操作しない。

## 認証とトークン

- 推奨は `SYS4SYS_TOKEN` または `SYS4SYS_TOKEN_FILE` による Bearer API トークンである。
- `--token` はシェル履歴・プロセス一覧・CI ログに残る可能性があるため使わない。
- `SYS4SYS_TOKEN` を会話、Issue、PR、ログ、コミットに貼らない。
- API トークンはサーバー側で SHA-256 ハッシュとして保存される。CLI は prefix とスコープだけを表示し、全文を再取得できない。
- トークン全文は `tokens create --json` の発行時に一度だけ出力に含まれる。必要なら secret store に保存し、ターミナルログに残さない。
- `tokens:manage` は他ユーザーのトークン管理や強いトークン発行につながる。CI・自動化では必要最小限のスコープで発行する。

資格情報保存:

- `SYS4SYS_CONFIG_DIR` が設定されていれば `$SYS4SYS_CONFIG_DIR/credentials.json`
- Windows 既定: `%APPDATA%\sys4sys\credentials.json`
- macOS / Linux 既定: `$XDG_CONFIG_HOME/sys4sys/credentials.json` または `~/.config/sys4sys/credentials.json`
- `credentials.json` は Git 管理対象外
- Unix ではファイル `0600`、ディレクトリ `0700` を目指す。Windows は ACL を絞れる範囲で絞り、広い場合は警告する
- 共用端末では `sys4sys auth logout` で保存済み資格情報を削除する

## スコープとロール

CLI は API のスコープ検査に依存する。スコープが不足すると exit 3 となり、Problem Details の `requiredScope` を確認できる。

代表的なスコープ:

| 操作                            | 必要なスコープ                                 |
| ------------------------------- | ---------------------------------------------- |
| services list/get/logs/actions  | `services:read`                                |
| services start/stop/restart     | `services:operate`                             |
| services create/update/delete   | `services:write`                               |
| deploy 実行、deploy 要求作成    | `deploy:execute`                               |
| deploy 承認、再起動承認         | `approvals:decide`                             |
| incidents list/get/ack/resolve  | `incidents:read` / `incidents:write`           |
| hosts list/get/detect/create    | `hosts:read` / `hosts:write`                   |
| ports list/history/reserve/kill | `ports:read` / `ports:operate`                 |
| reports list/get/export         | `reports:read`                                 |
| audit list                      | `audit:read`                                   |
| settings get/set/backup         | `settings:read` / `settings:write`             |
| tokens create/list/revoke       | 自分なら認証のみ。他ユーザーは `tokens:manage` |
| secrets 平文取得                | `services:secrets`                             |

CLI はトークンから強いトークンへ昇格する操作を API 側で制限していることを前提にする。`tokens:manage` を持たないトークンで新しいトークンを発行できない。

## 秘密値と env

- 通常の `services list` / `services get` は env 値を返さない。一覧はキー名、詳細は `***` である。
- `--show-env` は admin 権限と `services:secrets` スコープがある場合だけ secrets API を経由して平文値を表示する。常用しない。
- `--show-env` の出力、`env` / `deploy.env` の値、設定ファイルのメールパスワードや AI API key を外部に貼らない。
- サーバー側は env / deploy.env を AES-256-GCM で暗号化し、CLI に暗号文は渡さない。
- `services create/update` は JSON / YAML ファイル経由で env を受け取れる。CLI 出力の dry-run では secret をマスクするが、入力ファイルそのものは Git にコミットしない。
- 復号失敗時は安全なエラーメッセージだけを返し、秘密値や鍵は表示しない。

## 監査ログと `--note`

CLI の destructive / mutating 操作はサーバー側の監査ログに記録されることがある。監査ログは通常 `before` / `after` に秘密値を含めないが、`reason` にはユーザーが入力したメモがそのまま残ることがある。

したがって:

- `--note` にパスワード、API key、トークン、DB 接続文字列を書かない。
- `--note` には service ID、incident ID、変更理由、承認根拠だけを書く。
- 監査ログ閲覧は `audit:read` が必要である。
- 設定の mail / AI 秘密値は GET 応答には出さず、`passwordSet` / `apiKeySet` などの状態だけを返す。

## デプロイ要求と env ハッシュ

`deploy.requireApproval=true` のサービスでは、CLI は即時 deploy を実行せず `services deploy <service-id> --request` で承認要求を作成する。

`deploy-requests` の snapshot は以下の情報だけを含む:

- `command`
- `cwd`
- `timeoutSec`
- `restartAfter`
- `healthTimeoutSec`
- `envHash`
- `deployEnvHash`

`envHash` / `deployEnvHash` は要求作成時点の env を安定した JSON 順で SHA-256 ハッシュ化したものである。平文 env も暗号文も保存されない。

運用規則:

- 承認は要求者と別ユーザーで行う。`deploy-requests approve` が `requestedBy` と一致する場合は 403 である。
- `DEPLOY_ALLOW_SELF_APPROVAL=true` は明示的な例外設定であり、通常は無効にする。
- 承認時点で現在の deploy 設定・env / deploy.env のハッシュが変わっている場合は 409 である。要求を作り直す。
- 期限切れ要求は `expired` になり、承認できない。
- `--wait` は status が `executed` / `failed` になるまで待つ。失敗・期限切れは exit 5 である。
- 承認 memo に env 値や秘密値を書かない。

## destructive 操作

非対話環境では `--yes` が必要である。`--yes` がない場合は exit 2 で終了する。

代表的な操作:

- `services stop` / `restart` / `delete`
- `deploy`
- `hosts update --disable`
- `ports release`
- `ports kill`
- `incidents resolve`
- `approvals approve` / `reject`
- `deploy-requests approve` / `reject`
- `settings ... set`
- `settings backup`
- `tokens revoke`

安全手順:

1. `--json` で対象 ID と状態を確認する。
2. 可能なら `--dry-run` で実行内容を確認する。
3. `--yes` を付ける。
4. JSON / 監査ログ / service actions で結果を追跡する。

`ports kill` は二段階である。まず kill token を取得して対象 PID / プロセス / 期限を表示し、確認後の `--yes` で実行する。期限切れ token による 400 / 409 は、同じ `ports kill` を再実行して token を再取得する。

## CLI 出力とログ

- JSON 出力をそのまま Issue、外部 AI、公開ダッシュボードに貼らない。
- `--json` には service 名、ID、host 名、ポート、プロセス、エラーメッセージが含まれることがある。個人情報や内部ホスト名が含まれる場合は配信前にマスクする。
- `logs tail` / `logs query` の出力は秘密値を含みうる。`--grep` で絞り、ログ全文をログファイルや CI に保存しない。
- `reports export` はファイル書き込みを明示的に行う。既存ファイルを上書きしない。既存ファイルがある場合は `--force` が必要で、`--force` を CI で乱用しない。
- CLI の終了コードは 0 以外を正常な終了として運用に混ぜない。特に `exit 2`, `exit 3`, `exit 4`, `exit 5` は理由を確認する。

## Git と配布

コミットしてはいけないもの:

- `.env`
- `credentials.json`
- `SYS4SYS_TOKEN_FILE` が指すトークンファイル
- SQLite DB、WAL、SHM
- バックアップ DB
- service env / deploy.env を含む JSON / YAML
- CLI 実行ログ、API 応答ログ、AI 分析ログの生の出力
- 個人 PC の絶対パスを含むテスト出力

配布物に含めてはいけないもの:

- `.env`
- `credentials.json`
- DB / バックアップ / ログ
- 個人パス
- API トークン、セッション Cookie、秘密値を含むテスト fixture

## トラブルシューティング

- **401**: トークン失効、ユーザー無効化、またはセッション切れ。`sys4sys whoami --json` / `sys4sys auth status --json` で確認し、新しい最小スコープのトークンを発行する。
- **403 + `requiredScope`**: スコープ不足。既存トークンを拡大するのではなく、用途別の最小スコープトークンを作り直す。
- **exit 2 + `--yes`**: 非対話環境で確認付き操作を実行しようとしている。対象を確認してから `--yes` を付ける。
- **409 `approval_required`**: サービスの `deploy.requireApproval` が有効。`services deploy <id> --request` で承認要求を作る。
- **403 self approval**: 要求者と同じユーザーで承認しようとしている。別ユーザーまたは別トークンで承認する。
- **env 復号失敗**: 秘密値の復号に失敗した状態。`SESSION_SECRET` / `SECRET_ENCRYPTION_KEY` の変更、マイグレーション失敗、DB 破損を確認する。秘密値を再投入する必要がある可能性がある。
