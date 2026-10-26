# API トークンのローテーションと漏洩対応

sys4sys の API トークンは `s4s_` で始まる bearer トークンです。発行時に一度だけ全文が表示され、サーバーにはハッシュだけが保存されます。このドキュメントは、安全な発行・配布・ローテーション・失効の手順を定めます。

## 原則

- 用途・環境・ユーザーごとに別トークンを発行する。
- 最小権限のスコープだけを付与する。管理者の全スコープを CI や MCP に渡さない。
- 有効期限は短くする。既定は 90 日、最大は 365 日。
- トークン全文は発行時に一度だけ表示される。会話・Issue・PR・シェル履歴・CI ログに残さない。
- トークンは Secret Manager に保存し、ファイルに置く場合は権限を絞る。
- 定期的に `tokens list` と監査ログを確認し、不要なトークンを失効する。
- 漏洩が疑われる場合は、調査より先に失効する。

## 発行

```bash
sys4sys tokens create \
  --name ci-prod \
  --scope services:read \
  --scope logs:read \
  --expires-in 30 \
  --json
```

- `tokens create` には `tokens:manage` が必要です。
- 新しいトークンのスコープは、操作中のトークンまたはセッションのスコープの部分集合である必要があります。
- 別ユーザー用に発行する場合は `--user <user-id>` を指定します。
- 発行結果の `token` は一度だけ表示されます。JSON をファイルに保存する場合は、直ちに Secret Manager へ移し、ファイルを削除してください。
- トークン ID と prefix は一覧・失効・監査に使えます。prefix だけならログに残しても全文の漏洩にはなりませんが、取り扱いは最小限にします。

```bash
sys4sys tokens list --json
sys4sys tokens list --user <user-id> --json
sys4sys whoami --json
```

## 配布

### 環境変数

```bash
export SYS4SYS_API_URL="https://sys4sys.example.com"
export SYS4SYS_TOKEN="<token>"
```

- CI では masked secret / Secret Manager から注入する。
- `echo "$SYS4SYS_TOKEN"`、`set -x`、デバッグ出力を避ける。
- トークンを含むコマンドライン引数はプロセス一覧に残ることがあるため、`SYS4SYS_TOKEN` 環境変数か `SYS4SYS_TOKEN_FILE` を使う。

### ファイル

```bash
export SYS4SYS_TOKEN_FILE="$HOME/.config/sys4sys/ci-token"
chmod 600 "$SYS4SYS_TOKEN_FILE"
```

- ファイルは所有者だけが読める権限にする。
- ジョブ終了後に削除する。
- Git 管理対象のリポジトリ内に置かない。

### GitHub Actions の例

リポジトリの Secrets に `SYS4SYS_TOKEN` を登録し、ワークフローで環境変数として渡します。

```yaml
env:
  SYS4SYS_API_URL: https://sys4sys.example.com
  SYS4SYS_TOKEN: ${{ secrets.SYS4SYS_TOKEN }}
```

- `pull_request` からの実行では Secrets を渡さない。
- 承認が必要な deploy を CI から実行しない。`approvals:decide` を CI トークンに付与しない。
- `sys4sys doctor --strict --json` を先頭で実行し、設定漏れを検出する。

## ローテーション

無停止でローテーションする場合は、新トークンを先に配布し、旧トークンを後から失効します。

1. 新しいトークンを発行する。

   ```bash
   sys4sys tokens create --name ci-prod-2026-11 --scope services:read --scope logs:read --expires-in 30 --json
   ```

2. Secret Manager の値を新トークンへ更新する。
3. CI / 運用端末で `whoami` と代表コマンドを実行し、新トークンで成功することを確認する。

   ```bash
   sys4sys whoami --json
   sys4sys services list --json
   ```

4. 旧トークンの ID を確認し、失効する。

   ```bash
   sys4sys tokens list --json
   sys4sys tokens revoke <old-token-id> --yes --json
   ```

5. 監査ログで `token.create` / `token.revoke` と、旧トークンの最終利用を確認する。
6. 旧トークンを含む Secret、ファイル、ジョブ定義を削除する。

トークンの有効期限が近い場合は `doctor` が警告します。保存済みトークンを使っている場合は `sys4sys doctor --json` の `token-expires` を確認し、7 日以内にローテーションしてください。

## 失効

```bash
sys4sys tokens revoke <token-id> --yes --json
```

- 失効は即時です。失効済みトークンでの API 呼び出しは 401 になります。
- `auth logout --revoke-token` は保存済みトークンを失効してからローカル資格情報を削除します。
- 環境変数の `SYS4SYS_TOKEN` は `auth logout` では失効しません。`tokens revoke` を明示的に実行してください。
- 失効後に `sys4sys whoami --json` が 401 になることを確認します。

## 漏洩時の対応

1. 漏洩したトークンを直ちに失効する。

   ```bash
   sys4sys tokens revoke <token-id> --yes --json
   ```

2. 監査ログを確認する。

   ```bash
   sys4sys audit list --limit 200 --json
   sys4sys audit list --action token.create --limit 50 --json
   sys4sys audit list --action service.secrets.reveal --limit 50 --json
   ```

3. 不審な操作（deploy、stop、delete、設定変更、秘密値表示、トークン発行）がないか確認する。
4. 漏洩したトークンと同じスコープ・同じ保存場所を使う他のトークンも失効する。
5. Secret Manager、CI のログ、シェル履歴、Issue、チャット、アーティファクトを確認し、トークン全文を削除する。
6. 必要ならパスワードや他の認証情報もローテーションする。
7. 新しいトークンを最小権限・短い期限で発行し、`whoami` と主要コマンドで確認する。
8. 事象・影響範囲・対応時刻をインシデント記録に残す。トークン全文は記録しない。prefix と ID のみ記録する。

## 管理者・承認者トークンの扱い

- `tokens:manage`、`settings:write`、`services:secrets`、`approvals:decide` は強い権限です。必要なユーザーだけに付与してください。
- deploy の要求者と承認者は別ユーザーにします。自己承認は API が拒否します。
- `--show-env` は監査対象です。利用は障害対応など必要最小限に限定し、出力を保存しないでください。
- MCP には管理者の全スコープを渡さず、読み取り専用トークンから始めてください。詳細は [MCP_SECURITY.md](./MCP_SECURITY.md) を参照してください。
