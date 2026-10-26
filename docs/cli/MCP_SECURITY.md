# MCP の安全な設定

sys4sys の MCP サーバーは CLI に同梱され、stdio で動作します。設計の基本は **読み取り先行** です。書き込みは明示フラグ・トークンスコープ・確認引数のすべてが揃った場合だけ有効になります。

## 起動方法

```bash
SYS4SYS_API_URL="https://sys4sys.example.com" \
SYS4SYS_TOKEN="<token>" \
sys4sys mcp serve
```

- transport は `stdio` のみです。HTTP/SSE は公開していません。
- `SYS4SYS_TOKEN` が必須です。保存済み資格情報・セッション Cookie・対話ログインは使いません。
- `SYS4SYS_API_URL` または `--api` で API を指定します。
- stdout は MCP プロトコル専用です。診断・警告は stderr に出力します。
- トークン全文、env の実値、生の秘密値をツール結果に含めません。

書き込みを有効にする場合:

```bash
SYS4SYS_API_URL="https://sys4sys.example.com" \
SYS4SYS_TOKEN="<token>" \
sys4sys mcp serve --allow-write
```

`SYS4SYS_MCP_ALLOW_WRITE=true` でも有効になります。環境変数はクライアント設定に直接書かず、Secret Manager や OS の環境変数から渡してください。

## ツール

### 読み取りツール

読み取りツールは `--allow-write` なしで利用できます。トークンに必要なスコープがあるものだけが一覧に表示されます。

| ツール                   | 必要スコープ     | 内容                              |
| ------------------------ | ---------------- | --------------------------------- |
| `sys4sys_whoami`         | 認証のみ         | ユーザー・ロール・スコープ        |
| `sys4sys_list_services`  | `services:read`  | サービス一覧                      |
| `sys4sys_get_service`    | `services:read`  | サービス詳細（env はキー名のみ）  |
| `sys4sys_query_logs`     | `logs:read`      | マスク済みログ検索（最大 200 行） |
| `sys4sys_list_incidents` | `incidents:read` | インシデント一覧                  |
| `sys4sys_get_incident`   | `incidents:read` | インシデント詳細                  |
| `sys4sys_list_approvals` | `approvals:read` | 承認一覧                          |
| `sys4sys_schema`         | 認証のみ         | CLI コマンド Schema               |

`sys4sys_get_service` は `env` / `deploy.env` の値をキー名だけに置き換えます。`sys4sys_query_logs` は API がマスクしたログを返し、CLI 側でもトークン形式を redact します。

### 書き込みツール

書き込みツールは次のすべてが必要です。

1. `--allow-write` または `SYS4SYS_MCP_ALLOW_WRITE=true`
2. トークンに一致するスコープ
3. `confirm: true`（破壊的操作のツールのみ）

| ツール                           | 必要スコープ       | confirm | 内容                          |
| -------------------------------- | ------------------ | ------- | ----------------------------- |
| `sys4sys_start_service`          | `services:operate` | 必須    | サービス開始                  |
| `sys4sys_stop_service`           | `services:operate` | 必須    | サービス停止                  |
| `sys4sys_restart_service`        | `services:operate` | 必須    | サービス再起動                |
| `sys4sys_deploy_service`         | `deploy:execute`   | 必須    | deploy 実行または承認要求作成 |
| `sys4sys_ack_incident`           | `incidents:write`  | 不要    | インシデント ack              |
| `sys4sys_resolve_incident`       | `incidents:write`  | 必須    | インシデント resolve          |
| `sys4sys_approve_deploy_request` | `approvals:decide` | 必須    | deploy 要求の承認・実行       |
| `sys4sys_reject_deploy_request`  | `approvals:decide` | 必須    | deploy 要求の拒否             |

`confirm` がない場合、サーバーはツールを実行せずエラーを返します。クライアント側の承認 UI と併用してください。

## deploy のポリシー

- `sys4sys_deploy_service` は、サービスの `deploy.requireApproval` が `true` の場合、または引数 `requireApproval: true` の場合、**承認要求を作成するだけ** です。自動承認・自動実行はしません。
- 承認は `sys4sys_approve_deploy_request` で明示的に行います。要求作成と承認を別ツールに分離しています。
- API は要求者と承認者が同じ場合に 403 を返します。MCP から自己承認を迂回することはできません。
- MCP から deploy を自動承認する設定や、`DEPLOY_ALLOW_SELF_APPROVAL=true` を常用する運用は避けてください。
- 承認時は deploy 設定と env のスナップショットが検証されます。期限切れ・設定変更・二重決定は 409 です。

## 推奨構成

### 読み取り専用

```json
{
  "mcpServers": {
    "sys4sys": {
      "command": "sys4sys",
      "args": ["mcp", "serve"],
      "env": {
        "SYS4SYS_API_URL": "https://sys4sys.example.com",
        "SYS4SYS_TOKEN": "<read-only-token>"
      }
    }
  }
}
```

読み取り専用トークンには `services:read`、`logs:read`、`incidents:read`、`approvals:read` など必要な読み取りスコープだけを付与します。

### 書き込みを限定

```json
{
  "mcpServers": {
    "sys4sys": {
      "command": "sys4sys",
      "args": ["mcp", "serve", "--allow-write"],
      "env": {
        "SYS4SYS_API_URL": "https://sys4sys.example.com",
        "SYS4SYS_TOKEN": "<operator-token>"
      }
    }
  }
}
```

- 書き込み用トークンにも `tokens:manage`、`settings:write`、`services:secrets` を付けないでください。
- deploy 承認用のトークンは要求者と別ユーザーにし、必要な場合だけ別 MCP 設定として分離します。
- 可能なら `--allow-write` を使う MCP 設定を別プロファイルにし、通常は読み取り専用プロファイルを使います。

## stdout / stderr

MCP クライアントは stdout を JSON-RPC として読み取ります。CLI のログやシェルの `echo` を stdout に混ぜないでください。

- 起動時の診断、`--allow-write` の警告、エラーは stderr に出力されます。
- ラッパースクリプトを作る場合は、stdout を加工しないでください。
- デバッグ時も `console.log` を MCP プロセス内で使わないでください。

## 秘密値の扱い

- MCP のツール結果は JSON テキストですが、サービス env はキー名のみです。
- `sys4sys_query_logs` は API のマスク済みログを返します。マスク漏れが疑われる場合は、外部 AI へ送る前に内容を確認してください。
- エラー応答は `s4s_...` 形式と bearer ヘッダーを redact します。
- トークン、パスワード、API key、env の実値を MCP のプロンプトや会話に貼らないでください。
- 漏洩が疑われる場合は [TOKEN_ROTATION.md](./TOKEN_ROTATION.md) の手順で直ちに失効してください。

## 監査と運用

- MCP 経由の書き込みも API の監査ログに記録されます。
- `sys4sys audit list --action deploy --limit 50 --json` で deploy 要求・承認を確認できます。
- MCP 用トークンは用途別に発行し、期限を短くし、定期的にローテーションします。
- クライアントの MCP 設定ファイルにトークンを直書きする場合は、ファイル権限を最小化し、Git 管理しないでください。
- MCP のトラブルは `sys4sys doctor --json`、API の `/api/health`、stderr の診断ログで切り分けます。
