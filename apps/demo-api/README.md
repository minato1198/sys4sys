# demo-api

sys4sys のサービス管理・ログ・ヘルスチェック・インシデント検知を試すための最小 API です。
依存パッケージはなく、Node.js の標準モジュールだけで動きます。

## ビルド

```powershell
pnpm install
pnpm demo:build
```

`apps/demo-api/dist/server.js` が生成されます。

## 単体起動

```powershell
pnpm demo:start
```

既定では `127.0.0.1:4100` で待ち受けます。`PORT` / `HOST` で変更できます。

```powershell
Invoke-RestMethod http://127.0.0.1:4100/health
```

## エンドポイント

| Method | Path            | 用途                                       |
| ------ | --------------- | ------------------------------------------ |
| GET    | `/`             | サービス情報                               |
| GET    | `/health`       | ヘルスチェック用。`status=ok` を返す       |
| GET    | `/error`        | 意図的に 500 とエラーログを出す            |
| GET    | `/slow?ms=5000` | 指定ミリ秒だけ応答を遅らせる（最大 30 秒） |
| GET    | `/crash`        | 意図的にプロセスを終了する（exit code 1）  |

`/error` と `/crash` はテスト専用です。`127.0.0.1` にだけバインドされます。

## sys4sys へのサービス登録

`/services` の「新しいサービス」で以下を入力します。

| 項目               | 値                                               |
| ------------------ | ------------------------------------------------ |
| Host               | 起動済みの Windows ホスト                        |
| Name               | `demo-api`                                       |
| Command (JSON)     | `["node.exe","dist/server.js"]`                  |
| CWD                | `C:\path\to\sys4sys\apps\demo-api` |
| Env (JSON)         | `{"PORT":"4100","NODE_ENV":"production"}`        |
| Expected ports     | `4100`                                           |
| Auto restart phase | まず `observe`（慣れたら `approve` / `auto`）    |
| autoStart          | 必要なら ON                                      |
| Health check type  | `http`                                           |
| Health check URL   | `http://127.0.0.1:4100/health`                   |
| Interval / Timeout | `10` 秒 / `3` 秒                                 |
| Failures           | `3`                                              |

登録後に「起動」を押すと、sys4sys が `node.exe dist/server.js` を `cwd` で起動します。
stdout / stderr は自動的にログへ取り込まれます。

## sys4sys 管理下でのデプロイ

`/services` の Edit で `deploy` 設定を登録すると、一覧の Deploy ボタンまたは
`POST /api/services/:id/deploy` から `deploy.ps1` を実行できます。sys4sys が
再起動とヘルス確認まで行うため、スクリプトには `-NoRestart` を渡します。

| 項目           | 推奨値                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Deploy command | `["pwsh.exe","-NoProfile","-ExecutionPolicy","Bypass","-File","deploy.ps1","-SkipPull","-NoRestart"]` |
| Deploy CWD     | `C:\path\to\sys4sys\apps\demo-api`                                                      |
| Timeout (sec)  | `900`                                                                                                 |
| Restart after  | ON                                                                                                    |
| Health timeout | `120`                                                                                                 |

`origin` remote を設定済みで `git pull` も sys4sys から実行したい場合は、`-SkipPull` を外してください。
デプロイの進行状況は `/logs` で `[deploy]` を検索すると確認できます。最終結果はサービスの
`lastDeployStatus` / `lastDeployError` と recent actions に残ります。

## デプロイスクリプト（deploy.ps1）

サービス登録後は `apps/demo-api/deploy.ps1` で、`git pull` からビルド、sys4sys 経由の再起動、ヘルス確認までを1コマンドで実行できます。

```powershell
$env:SYS4SYS_EMAIL = "deployer@example.local"
$env:SYS4SYS_PASSWORD = "..."
.\apps\demo-api\deploy.ps1
```

処理内容:

1. `git fetch` + `git merge --ff-only origin/<branch>`
2. `pnpm install --frozen-lockfile`
3. `pnpm --filter @sys4sys/demo-api typecheck`
4. `pnpm --filter @sys4sys/demo-api build`
5. `POST /api/services/:id/restart` で sys4sys から再起動
6. `status=running` かつ `health=healthy` になるまで待機

ビルドが失敗した場合は再起動しません。稼働中の旧プロセスはそのまま残ります。

### 認証

`operator` または `admin` の資格情報が必要です。CI ではシークレットから環境変数へ渡してください。

```powershell
$env:SYS4SYS_EMAIL = "deployer@example.local"
$env:SYS4SYS_PASSWORD = "..."
```

ブラウザの `sys4sys_session` Cookie を使うこともできます。

```powershell
.\apps\demo-api\deploy.ps1 -SessionCookie "<token>"
```

認証情報を渡さず `-NoRestart` を指定すると、ビルドだけ実行できます。

### オプション

| Option              | 説明                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `-SkipPull`         | `git pull` を省略する（CI で checkout 済みの場合）                              |
| `-SkipInstall`      | `pnpm install` を省略する                                                       |
| `-RunTests`         | ビルド前に `pnpm test` を実行する                                               |
| `-NoRestart`        | sys4sys API を呼ばず、ビルドだけで終了する                                      |
| `-AllowDirty`       | 追跡対象ファイルに未コミット変更があっても続行する                              |
| `-Branch main`      | pull するブランチ                                                               |
| `-ServiceName`      | sys4sys 上のサービス名（既定: `demo-api`）                                      |
| `-RepoRoot`         | デプロイ対象リポジトリのパス。CI の checkout と実行ディレクトリが違う場合に指定 |
| `-ApiBaseUrl`       | sys4sys API（既定: `http://127.0.0.1:8787`）                                    |
| `-HealthTimeoutSec` | 再起動後のヘルス確認タイムアウト（既定: 120 秒）                                |

### CI/CD の例

`deploy.ps1` は sys4sys と demo-api が動いている Windows ホスト上で実行するのが基本です。CI から実行する場合は、次のどちらかにしてください。

- sys4sys ホストに self-hosted Windows runner を置き、デプロイ対象リポジトリで実行する
- CI の checkout から `-RepoRoot C:\path\to\sys4sys` のように実際のデプロイ先を指定する

GitHub Actions（self-hosted Windows runner）の例:

```yaml
name: deploy-demo-api
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths:
      - "apps/demo-api/**"
      - "pnpm-lock.yaml"
jobs:
  deploy:
    runs-on: [self-hosted, windows]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - name: Deploy
        shell: pwsh
        env:
          SYS4SYS_EMAIL: ${{ secrets.SYS4SYS_EMAIL }}
          SYS4SYS_PASSWORD: ${{ secrets.SYS4SYS_PASSWORD }}
        run: ./apps/demo-api/deploy.ps1 -RepoRoot C:\path\to\sys4sys -RunTests
```

このリポジトリには現時点で `origin` remote が設定されていないため、`git pull` を使う前に remote を追加してください。remote を使わずにデプロイする場合は `-SkipPull` を指定します。

### 失敗時のロールバック

`deploy.ps1` は失敗時に直前のコミットを表示します。ビルド前に失敗した場合は旧プロセスが動き続けるため、そのまま調査できます。再起動後にヘルスチェックが失敗した場合は、表示されたコミットへ戻して再ビルドし、再度デプロイしてください。

```powershell
git checkout <previous-commit>
pnpm install --frozen-lockfile
.\apps\demo-api\deploy.ps1 -SkipPull
```

## 動作確認

1. `/services` で `demo-api` を起動する
2. `http://127.0.0.1:4100/health` が `status: ok` を返すことを確認する
3. `/logs` で Service = `demo-api` を選び、起動ログと heartbeat を確認する
4. `http://127.0.0.1:4100/error` を開き、`/logs` にエラーログが出ることを確認する
5. 必要なら `/crash` を開き、`/incidents` にプロセス異常終了が記録されることを確認する
6. `autoRestartPhase=approve` にした場合、`/approvals` に再起動承認が並ぶ
7. `/services` の Deploy を押し、`lastDeployStatus=succeeded`、`status=running`、`health=healthy` になることを確認する
8. `/logs` で `[deploy]` を検索し、ビルドログと `deploy succeeded` が保存されていることを確認する

## 注意

- 同じポート `4100` で二重に起動しないでください
- `expectedPorts` に `4100` を入れると、他サービスが `4100` を予約している場合は起動が `409` で止まります
- このサービスはテスト用です。本番の監視対象にはしないでください
