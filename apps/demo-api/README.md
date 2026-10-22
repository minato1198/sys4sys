# demo-api

sys4sys のサービス管理・ログ・ヘルスチェック・インシデント検知を試すための最小 API です。
依存パッケージはなく、Node.js の標準モジュールだけで動きます。

## デプロイ

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

## 動作確認

1. `/services` で `demo-api` を起動する
2. `http://127.0.0.1:4100/health` が `status: ok` を返すことを確認する
3. `/logs` で Service = `demo-api` を選び、起動ログと heartbeat を確認する
4. `http://127.0.0.1:4100/error` を開き、`/logs` にエラーログが出ることを確認する
5. 必要なら `/crash` を開き、`/incidents` にプロセス異常終了が記録されることを確認する
6. `autoRestartPhase=approve` にした場合、`/approvals` に再起動承認が並ぶ

## 注意

- 同じポート `4100` で二重に起動しないでください
- `expectedPorts` に `4100` を入れると、他サービスが `4100` を予約している場合は起動が `409` で止まります
- このサービスはテスト用です。本番の監視対象にはしないでください
