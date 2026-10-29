# 外部サービス（NSSM / WinSW / ネイティブ Windows サービス）運用

- 版: v1.0
- 対象: `controlMode=windows-service`
- 前提: sys4sys は Windows SCM のサービスを安全に監視・操作するが、NSSM / WinSW のインストールや設定変更は行わない。

## 1. 基本方針

外部サービスでは、サービス起動時の PID や親子関係に依存しない。sys4sys は Windows SCM 上のサービス名を同一性として扱う。

| 項目                  | 意味                                                       |
| --------------------- | ---------------------------------------------------------- |
| `controlMode`         | `spawn` または `windows-service`                           |
| `serviceName`         | SCM のサービス名。NSSM ラッパー名ではなく SCM 上の表示名   |
| `deploy.command`      | ビルド・配置・マイグレーションなどのコマンド               |
| `serviceControlOwner` | deploy 中の stop / start 所有者。`sys4sys` または `script` |

手動の `start` / `stop` / `restart` は、`serviceControlOwner` にかかわらず sys4sys が担当する。`serviceControlOwner` は deploy 中の自動停止・起動の所有者だけを決定する。

## 2. サービス登録

UI または CLI でサービスを作成する。

```json
{
  "hostId": "<windows-host-id>",
  "name": "demo-api",
  "controlMode": "windows-service",
  "serviceName": "MyDemoApiService",
  "command": ["unused"],
  "expectedPorts": [3101],
  "healthCheck": {
    "type": "http",
    "url": "http://127.0.0.1:3101/health",
    "intervalSec": 15,
    "timeoutSec": 5,
    "failures": 3
  },
  "deploy": {
    "command": ["pwsh.exe", "-NoProfile", "-File", "deploy.ps1"],
    "cwd": "C:\\srv\\demo-api",
    "timeoutSec": 600,
    "healthTimeoutSec": 120,
    "serviceControlOwner": "sys4sys"
  }
}
```

検証項目:

- `host.kind=windows` であること。
- `serviceName` が空でないこと。
- 同じホスト内で `serviceName` が重複していないこと。大文字・小文字は無視して一意性を検査する。
- deploy を設定する場合 `serviceControlOwner` があること。
- `SERVICE_COMMAND_ALLOWLIST` は `deploy.command` にだけ適用する。`command` は表示用であり外部サービスの起動には使わない。
- `autoStart` は外部サービスでは使用しない。SCM のスタートアップ種別が起動を管理する。

## 3. deploy ownership

### 3.1 `serviceControlOwner=sys4sys`

sys4sys は次の流れを実行する。

```text
SCM stop -> deploy.command -> SCM start -> health wait
```

- `restartAfter` は常に `true` に正規化される。
- stop が確認できるまで deploy.command を実行しない。
- deploy.command が失敗しても、可能なら sys4sys はサービスを再起動する。
- deploy スクリプトは `SYS4SYS_SERVICE_CONTROL=sys4sys` を受け取り、stop / start / health を担当しない。

### 3.2 `serviceControlOwner=script`

deploy スクリプトが stop / start / health を担当する。

```text
deploy.command（スクリプト内で stop / build / start / health）
```

- sys4sys は deploy 開始時と終了時にサービスを停止・起動しない。
- `restartAfter` は常に `false` に正規化される。
- deploy 完了後、sys4sys は SCM 状態と設定済み health check で成功・失敗を判定する。

### 3.3 二重制御を防ぐための環境変数

sys4sys は deploy.command に次を渡す。

| 変数                       | 例          | 用途                                    |
| -------------------------- | ----------- | --------------------------------------- |
| `SYS4SYS_DEPLOY_ACTION_ID` | action UUID | deploy ログ・action との照合            |
| `SYS4SYS_SERVICE_CONTROL`  | `sys4sys`   | 所有者が sys4sys であることを示す       |
| `SYS4SYS_SERVICE_CONTROL`  | `script`    | 所有者が deploy script であることを示す |
| `SYS4SYS_SERVICE_NAME`     | `MyDemoApi` | SCM サービス名                          |

ラッパーは `SYS4SYS_SERVICE_CONTROL=sys4sys` のとき、`Stop-Service` / `Start-Service` / `sc.exe` / `POST /services/:id/restart` を実行してはいけない。

## 4. 標準ラッパー契約

実装例は [deploy-wrapper.ps1](./examples/deploy-wrapper.ps1)。

必須ルール:

- サービス名は `SYS4SYS_SERVICE_NAME` または明示的な引数で受け取る。
- `SYS4SYS_SERVICE_CONTROL=sys4sys` のとき stop / start をスキップする。
- `SYS4SYS_SERVICE_CONTROL=script` のときだけ stop / start / health を実行する。
- すでに Stopped / Running なら追加操作しない。
- `taskkill` を使わない。
- `POST /api/services/:id/restart` を呼ばない。
- health URL は `-HealthUrl` またはサービス固有のポート引数で明示する。sys4sys deploy 環境に継承された汎用 `PORT` をそのまま health URL に使わない。
- 失敗時は非 0 で終了する。
- stdout / stderr に秘密値を出さない。

## 5. NSSM / WinSW への登録

sys4sys 自体が NSSM をインストール・削除することはない。既存の SCM サービスを登録・監視する。

```powershell
nssm install MyDemoApiService "C:\\Program Files\\nodejs\\node.exe" "C:\\srv\\demo-api\\dist\\server.js"
nssm set MyDemoApiService AppDirectory "C:\\srv\\demo-api"
nssm set MyDemoApiService AppStdout "C:\\srv\\logs\\MyDemoApiService.out.log"
nssm set MyDemoApiService AppStderr "C:\\srv\\logs\\MyDemoApiService.err.log"
nssm set MyDemoApiService AppRotateFiles 1
nssm set MyDemoApiService AppRotateOnline 1
nssm set MyDemoApiService AppRotateBytes 10485760
nssm set MyDemoApiService Start SERVICE_AUTO_START
```

WinSW を使う場合は、XML の `<name>` とサービス ID を sys4sys の `serviceName` に一致させる。

このリポジトリには、NSSM 制御と deploy owner を実機確認するための `demo-nssm-api` がある。運用手順は [apps/demo-nssm-api/README.md](../apps/demo-nssm-api/README.md) を参照する。

## 6. ログ取り込み

外部サービスは sys4sys の spawn stdout/stderr パイプを使わない。NSSM のファイルログまたは WinSW ログを `log_sources` に登録して取り込む。

- NSSM stdout: `AppStdout`
- NSSM stderr: `AppStderr`
- NSSM 回転: `AppRotateFiles`、`AppRotateOnline`、`AppRotateBytes`

sys4sys 側の `log_sources.path` は、NSSM が書き出すファイルと同じパスを指すようにする。サービスログが UI に見えない場合は、NSSM のログ設定と `log_sources` の host / path を照合する。

## 7. ヘルスチェック

外部サービスでは HTTP / TCP health check を推奨する。`process` health check は SCM の Running / Paused 状態を参照し、NSSM ラッパー PID ではなく SCM 状態を使う。

インシデント検知は次のどちらかで発生する。

- HTTP / TCP health check が `failures` 回数だけ連続で失敗する。
- sys4sys が Running / degraded と認識している外部サービスが、deploy lock でも sys4sys 側 stop でもなく SCM 上 stopped になった。

NSSM の `AppExit=Restart` で SCM 自体が Running のままアプリだけ異常終了する場合、health check が downtime を拾える間隔と失敗回数にしておく必要がある。例として `intervalSec=5`、`timeoutSec=2`、`failures=2` を使う。

推奨:

- `healthCheck.type=http`
- `expectedPorts` に SCM が listen するポートを登録
- NSSM 自体の自動復旧を使う場合、sys4sys の `autoRestartPhase` は `observe` または `approve` にして二重再起動を避ける

## 8. デプロイ中の安全装置

- 同一サービスで deploy action が pending / running の間、`actions_one_running_deploy` の partial unique index により別の deploy を作成できない。
- deploy 中の `POST /services/:id/start`、`/stop`、`/restart` は 409。
- deploy 中の incident 自動再起動はスキップする。
- deploy 中の外部サービスポートに対する `POST /ports/:port/kill-token`、`POST /ports/:port/kill` は 409。Problem Details に `serviceId`、`serviceName`、`serviceControlOwner` を返す。
- API 再起動時は stale deploy reconciliation を service reconciliation より先に実行する。`DEPLOY_STALE_MS` より古い deploy action だけ failed にする。

## 9. sys4sys 自身の保護

`SELF_SERVICE_NAME` に sys4sys 自身の SCM サービス名を設定すると、次の API 操作を拒否する。

- `POST /services/:id/stop`
- `POST /services/:id/restart`
- `POST /services/:id/deploy`
- `POST /services/:id/deploy-requests`
- 承認済み deploy request の実行

sys4sys 自身を停止・再起動する場合は、SCM、NSSM、または sys4sys の外側にあるオーケストレータから実行する。

## 10. 運用チェックリスト

- [ ] SCM でサービスが起動済み、または deploy 前に停止可能であることを確認した。
- [ ] sys4sys の `serviceName` が `Get-Service` の名前と完全一致している。
- [ ] deploy.command の allowlist と cwd が正しい。
- [ ] `serviceControlOwner` が運用方針と一致している。
- [ ] ラッパーが `SYS4SYS_SERVICE_CONTROL` を尊重する。
- [ ] NSSM / WinSW のログファイルが `log_sources` へ登録されている。
- [ ] NSSM 自動復旧と sys4sys 自動再起動が二重にならない。
- [ ] sys4sys 自身を運用する場合は `SELF_SERVICE_NAME` が設定されている。
