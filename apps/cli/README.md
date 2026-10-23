# @sys4sys/cli

sys4sys API を操作する最小CLIです。サービスの登録、deploy設定の登録、deploy実行をJSONで扱えます。

## 前提

sys4sys API が起動している必要があります。

```bash
pnpm dev:api
```

## 認証

既存の `apps/demo-api/deploy.ps1` と同じ環境変数を使います。

```powershell
$env:SYS4SYS_API_URL = "http://127.0.0.1:8787"
$env:SYS4SYS_EMAIL = "admin@example.local"
$env:SYS4SYS_PASSWORD = "..."
```

セッションCookieを直接使う場合:

```powershell
$env:SYS4SYS_SESSION_COOKIE = "<sys4sys_session cookie>"
```

`SYS4SYS_SESSION_COOKIE` は `sys4sys_session=` の有無どちらでも受け付けます。完全な `Set-Cookie` 形式を貼り付けた場合も `sys4sys_session` の値だけを抽出します。

## 権限

- `services create` / `services update` は `admin` が必要です。
- `services deploy` は `operator` または `admin` が必要です。
- それ以外の読み取りコマンドはログイン済みユーザーであれば実行できます。

## 使い方

```bash
pnpm sys4sys -- --help
pnpm sys4sys -- whoami --json
pnpm sys4sys -- hosts list --json
pnpm sys4sys -- services list --json
pnpm sys4sys -- services get <id> --json
```

`service.create.json` の `REPLACE_WITH_HOST_ID` と `cwd` は環境に合わせて変更してください。`hostId` は `hosts list` で確認できます。

サービス登録の事前確認:

```bash
pnpm sys4sys -- services create \
  --file apps/cli/examples/service.create.json \
  --dry-run \
  --json
```

サービス登録:

```bash
pnpm sys4sys -- services create \
  --file apps/cli/examples/service.create.json \
  --json
```

deploy設定の更新:

```bash
pnpm sys4sys -- services update <id> \
  --file apps/cli/examples/service.deploy-patch.json \
  --json
```

deployの事前確認と実行:

```bash
pnpm sys4sys -- services deploy <id> --dry-run
pnpm sys4sys -- services deploy <id> --wait --yes --json
```

## 注意

- `env` / `deploy.env` は既定で `***` にマスクされます。表示する場合は `--show-env` を併用してください（`services list` の表には表示しません）。
- `--dry-run` は API を変更しませんが、`hostId` やサービスIDの存在確認のため API を読み取ります。
- `command` / `deploy.command` は `SERVICE_COMMAND_ALLOWLIST` に含まれる実行ファイルである必要があります。
- `services deploy` は非対話環境では `--yes` が必須です。
- CLIはSQLiteを直接操作せず、必ずAPI経由で実行します。
- `deploy.env` に秘密情報を直接書かないでください。秘密情報の扱いは今後の課題です。
