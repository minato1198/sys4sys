# sys4sys CLI 運用ガイド

このドキュメントは、sys4sys CLI を開発機・CI・運用端末へ導入し、日常運用・障害対応・アップグレードを行うための手順です。秘密値のローテーションは [TOKEN_ROTATION.md](./TOKEN_ROTATION.md)、MCP は [MCP_SECURITY.md](./MCP_SECURITY.md) を参照してください。

## 導入

### npm から導入

Node.js 22 以上が必要です。

```bash
npm install -g sys4sys@0.2.0
sys4sys version --json
sys4sys doctor --json
```

`npx` で試す場合は、グローバル環境を変更せずに実行できます。

```bash
npx sys4sys@0.2.0 doctor --json
npx sys4sys@0.2.0 schema --json
```

リポジトリから開発版を使う場合:

```bash
pnpm install
pnpm build:cli
pnpm sys4sys -- --help
```

### 初期設定

```bash
export SYS4SYS_API_URL="https://sys4sys.example.com"
export SYS4SYS_TOKEN="<token>"
sys4sys whoami --json
```

- `SYS4SYS_TOKEN` は Secret Manager や CI のマスク済み変数に保存してください。
- 対話端末では `sys4sys auth login` も使えます。
- 設定ディレクトリを分離する場合は `SYS4SYS_CONFIG_DIR` を指定します。
- `SYS4SYS_TOKEN` は保存済み資格情報より優先されます。

### 導入確認

```bash
sys4sys doctor --json
sys4sys doctor --strict
sys4sys version --json
sys4sys schema --json
```

`doctor` は Node.js のバージョン、API URL、API の到達性、認証、スコープ、トークン期限、資格情報ファイルの権限、設定ディレクトリの書き込み可否を確認します。`--strict` を付けると警告またはエラーで exit 1 になります。API に到達できない場合もクラッシュせず、チェック結果を返します。

秘密値は表示されません。トークンは prefix のみ、設定値はマスク済みで表示されます。

## 日常運用

### 状態確認

```bash
sys4sys services list --json
sys4sys services get <service-id> --json
sys4sys logs query --service <service-id> --level error --since 30m --json
sys4sys incidents list --status open --json
sys4sys deploy-requests list --status pending --json
```

`services list` は 100 サービス程度まで 1 秒以内を目標にしています。大量のログを扱う場合は `--since` と `--service` を必ず指定してください。

### 変更操作

```bash
sys4sys services restart <service-id> --dry-run
sys4sys services restart <service-id> --yes --wait --json
sys4sys services actions <service-id> --limit 10 --json
```

- 非対話環境では `--yes` が必須です。
- `--wait` はアクション完了まで待ち、失敗時は exit 5 です。
- 実行前に `--dry-run` と対象 ID を確認してください。
- 設定変更・deploy・削除は監査ログに記録されます。

### デプロイ承認

要求者と承認者を分離してください。

```bash
sys4sys services deploy <service-id> --request --note "release 1.2.3" --json
sys4sys deploy-requests list --status pending --json
sys4sys deploy-requests approve <request-id> --note "approved" --yes --wait --json
```

- `deploy.requireApproval: true` のサービスは即時 deploy できません。
- 自己承認は API が 403 で拒否します。`DEPLOY_ALLOW_SELF_APPROVAL=true` は緊急時だけ使用してください。
- 要求には deploy 設定と env のスナップショットが含まれます。承認までに設定が変わった場合は 409 です。
- 要求の期限は既定で 24 時間です。期限切れは `expired` になり、再要求が必要です。
- 同時に有効な deploy 要求はサービスごとに 1 つです。

### バックアップと監査

```bash
sys4sys audit list --action deploy --limit 50 --json
sys4sys audit list --action service.secrets.reveal --limit 50 --json
sys4sys settings backup --yes
```

`--show-env` による秘密値の表示は監査ログに残ります。定期棚卸しの対象にしてください。

## CI での利用

CI では対話ログインを使わず、専用トークンを Secret Manager から注入します。

```bash
export SYS4SYS_API_URL="https://sys4sys.example.com"
export SYS4SYS_TOKEN="$SYS4SYS_CI_TOKEN"
sys4sys whoami --json
```

- トークンは CI の masked secret に保存し、`echo` や `set -x` で表示しないでください。
- 可能なら `SYS4SYS_TOKEN_FILE` を使い、実行後に削除してください。
- 権限は最小限にします。参照だけなら `services:read` / `logs:read`、deploy なら `deploy:execute` を追加します。
- `approvals:decide` は自動化用トークンに付与しないでください。承認は別ユーザー・別ジョブに分離します。
- `sys4sys doctor --strict` をジョブの先頭に置くと、URL・認証・スコープの設定漏れを早期に検出できます。
- `--json` を基本にし、人間向け表をパースしないでください。

## 障害時の切り分け

1. `sys4sys doctor --json` で Node.js / API URL / API / 認証 / スコープ / 設定ディレクトリを確認する。
2. API の `/api/health` と API ログを確認する。
3. 401 の場合は `sys4sys auth status --json` とトークン期限を確認する。トークン経路では自動再ログインしません。
4. 403 の場合は `requiredScope` と `sys4sys whoami --json` の `scopes` を確認する。
5. 409 の場合はサービス状態、重複 deploy 要求、承認の二重決定、ポート競合を確認する。
6. `logs tail` が再接続を繰り返す場合は API の SSE とネットワークを確認する。10 回で停止します。
7. 秘密値の漏洩が疑われる場合は [TOKEN_ROTATION.md](./TOKEN_ROTATION.md) の漏洩対応へ進む。

## アップグレードとロールバック

```bash
npm view sys4sys version
npm install -g sys4sys@<version>
sys4sys version --json
sys4sys doctor --json
```

- 本番 CI ではバージョンを固定してください。
- 問題がある場合は直前のバージョンへ戻し、`doctor` と主要コマンドを再確認します。
- CLI の破壊的変更は `sys4sys schema --json` の `schemaVersion` とリリースノートで確認します。

## 関連ドキュメント

- [性能と制限](./PERFORMANCE.md)
- [トークンのローテーションと漏洩対応](./TOKEN_ROTATION.md)
- [MCP の安全な設定](./MCP_SECURITY.md)
- [CLI README](../../apps/cli/README.md)
