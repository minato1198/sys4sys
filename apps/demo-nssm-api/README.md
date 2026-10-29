# demo-nssm-api

sys4sys の外部サービス制御、特に NSSM を使った Windows サービスの deploy 動作を確認するためのデモ API です。

このアプリ自体が NSSM をインストールしたり、NSSM をプロセス管理したりすることはありません。既存の NSSM / SCM サービスを sys4sys に登録して、次の動作を確認します。

- `serviceControlOwner=sys4sys` の deploy
- `serviceControlOwner=script` の deploy
- NSSM 起動済みサービスの API 再起動後 `adopted` 化
- NSSM の stdout / stderr ファイルログ
- deploy 中の手動 stop / restart 拒否

## 前提

- Windows
- Node.js
- pnpm
- NSSM がインストール済みであること
- NSSM サービスのインストール / 削除には管理者 PowerShell が必要

NSSM が見つからない場合は、`-NssmPath` で `nssm.exe` の絶対パスを指定します。

## 1. ビルド

```powershell
pnpm --filter @sys4sys/demo-nssm-api build
```

ローカル起動:

```powershell
pnpm --filter @sys4sys/demo-nssm-api start
```

既定ポートは `4110` です。

Health:

```powershell
Invoke-WebRequest http://127.0.0.1:4110/health -UseBasicParsing
```

テスト用 endpoint は `/error`、`/slow?ms=5000`、`/crash?exitMs=12000` です。`/crash` の運用は後述します。

## 2. NSSM サービスをインストールする

管理者 PowerShell で実行します。

```powershell
.\apps\demo-nssm-api\install-service.ps1
```

NSSM が PATH にない場合:

```powershell
.\apps\demo-nssm-api\install-service.ps1 -NssmPath "C:\tools\nssm\win64\nssm.exe"
```

インストールされるデモ設定:

| 項目              | 値                                              |
| ----------------- | ----------------------------------------------- |
| サービス名        | `sys4sysDemoNssmApi`                            |
| 実行コマンド      | `node.exe dist/server.js`                       |
| AppDirectory      | `apps/demo-nssm-api`                            |
| PORT              | `4110`                                          |
| stdout            | `apps/demo-nssm-api/logs/demo-nssm-api.out.log` |
| stderr            | `apps/demo-nssm-api/logs/demo-nssm-api.err.log` |
| NSSM log rotation | enabled                                         |

サービスを手動起動したい場合:

```powershell
.\apps\demo-nssm-api\install-service.ps1 -Start
```

サービス状態:

```powershell
Get-Service sys4sysDemoNssmApi
Invoke-WebRequest http://127.0.0.1:4110/health -UseBasicParsing
```

## 3. sys4sys へ外部サービスとして登録する

sys4sys の `/services` から作成する場合の設定例:

```json
{
  "hostId": "<windows-host-id>",
  "name": "demo-nssm-api",
  "controlMode": "windows-service",
  "serviceName": "sys4sysDemoNssmApi",
  "command": ["node", "dist/server.js"],
  "expectedPorts": [4110],
  "healthCheck": {
    "type": "http",
    "url": "http://127.0.0.1:4110/health",
    "intervalSec": 15,
    "timeoutSec": 5,
    "failures": 3
  },
  "deploy": {
    "command": [
      "pwsh.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "deploy.ps1"
    ],
    "cwd": "C:\\Users\\STEALTH_ICE\\dev\\sys4sys\\apps\\demo-nssm-api",
    "timeoutSec": 600,
    "healthTimeoutSec": 120,
    "serviceControlOwner": "sys4sys"
  }
}
```

`cwd` は実際にリポジトリが存在する絶対パスへ置き換えてください。

## 4. deploy owner=sys4sys でテストする

sys4sys 側がサービスを停止し、deploy command を実行し、sys4sys 側で起動します。

期待される流れ:

```text
sys4sys: SCM stop
deploy.ps1: build only
sys4sys: SCM start
sys4sys: health wait
```

`deploy.ps1` は `SYS4SYS_SERVICE_CONTROL=sys4sys` を受け取ると、stop / start / health を一切行いません。

確認:

```powershell
Invoke-WebRequest http://127.0.0.1:4110/health -UseBasicParsing
```

`/health` の `build.builtAt` が deploy ごとに更新されていれば、NSSM サービスが新しいビルドで再起動されています。

## 5. deploy owner=script でテストする

sys4sys 側でサービスの deploy 設定を `serviceControlOwner=script` に変更します。

この場合、`deploy.ps1` が次を行います。

```text
deploy.ps1: Stop-Service
deploy.ps1: build
deploy.ps1: Start-Service
deploy.ps1: health wait
sys4sys: stop / start を呼ばない
```

`deploy.ps1` のヘルス確認は既定の `-Port 4110` を使う。sys4sys API 側から deploy を実行すると API の `PORT` 環境変数が deploy.command に継承されることがあるため、ラッパーは汎用 `PORT` を health URL に使わず、明示的なポートまたは `-HealthUrl` を使う。

確認:

- `/logs` で `[deploy]` ログに `serviceControlOwner=script` が現れる。
- sys4sys の action log に `Windows service stopped / started` 相当の sys4sys 発 stop / start が出ない。
- NSSM の AppStdout / AppStderr に service 起動ログが出る。

## 6. API 再起動後の adopted 確認

NSSM でサービスを起動した状態で sys4sys API を再起動します。

sys4sys の service 一覧に NSSM サービスが `running` として表示され、runtime が adopted として扱われます。

```powershell
Get-Service sys4sysDemoNssmApi
Invoke-WebRequest http://127.0.0.1:4110/health -UseBasicParsing
```

sys4sys 側では service 詳細の `runtime.adopted=true` または同等の外部サービス表示を確認できます。

## 7. ログ取り込み

sys4sys の `/logs` に NSSM ファイルログを登録します。

```text
stdout: apps/demo-nssm-api/logs/demo-nssm-api.out.log
stderr: apps/demo-nssm-api/logs/demo-nssm-api.err.log
```

NSSM の `AppStdout` / `AppStderr` と、sys4sys の `log_sources.path` が同じファイルを指していることを確認してください。

## 8. `/crash` でインシデントを発生させる

既定の `/crash` は、まず HTTP health を閉じてから 12 秒後にプロセスを `exit(1)` で終了します。sys4sys の health check がその間隔と失敗回数に間に合えば、`/incidents` に `ヘルスチェックが失敗しました: demo-nssm-api` が現れます。

```powershell
Invoke-WebRequest http://127.0.0.1:4110/crash -UseBasicParsing
```

sys4sys 側の health check を速くするためには、demo-nssm-api の health 設定を例として次のようにします。

```json
{
  "healthCheck": {
    "type": "http",
    "url": "http://127.0.0.1:4110/health",
    "intervalSec": 5,
    "timeoutSec": 2,
    "failures": 2
  }
}
```

インシデントが出れば十分で、NSSM の自動再起動に頼む必要はありません。NSSM の自動再起動が効いて service 自体が Running のままでも、HTTP health が Fail していればインシデントになります。

即時 exit だけでインシデントが出ないことを確認したい場合:

```powershell
Invoke-WebRequest http://127.0.0.1:4110/crash?exitMs=250 -UseBasicParsing
```

## 9. NSSM 自動再起動と sys4sys 自動再起動

NSSM の `AppExit` は既定で `Restart` です。sys4sys の自動再起動と同時に使うと二重復旧になる可能性があります。

デモ運用では、sys4sys 側の `autoRestartPhase` は `observe` または `approve` を推奨します。sys4sys 側でも自動再起動を有効にする場合は、NSSM 側の自動再起動設定と重複しないことを先に確認してください。

## 10. アンインストール

管理者 PowerShell で実行します。

```powershell
.\apps\demo-nssm-api\uninstall-service.ps1
```

ログも削除する場合:

```powershell
.\apps\demo-nssm-api\uninstall-service.ps1 -RemoveLogs
```

NSSM が PATH にない場合:

```powershell
.\apps\demo-nssm-api\uninstall-service.ps1 -NssmPath "C:\tools\nssm\win64\nssm.exe"
```

## 安全上の注意

- `install-service.ps1` と `uninstall-service.ps1` は sys4sys の deploy 中に実行しないでください。
- NSSM のインストール・削除は sys4sys のサービス制御とは独立した管理者操作です。
- sys4sys の deploy 用ラッパーは `taskkill` を使いません。
- `deploy.ps1` は `SYS4SYS_SERVICE_CONTROL=sys4sys` のときに stop / start / health を担当しません。
