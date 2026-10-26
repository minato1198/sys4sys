# sys4sys CLI の性能と制限

このドキュメントは、大量ログ・長時間 tail・MCP 利用時の性能目標と制限をまとめたものです。数値は開発機の目安であり、CI では性能測定を実行しません。

## 性能目標

| 項目                               | 目標       | 備考                             |
| ---------------------------------- | ---------- | -------------------------------- |
| `services list`（100 サービス）    | 1 秒以内   | ローカル API、cold start を含む  |
| `logs query`（10 万行、limit 100） | 2 秒以内   | 一時 DB、10 回の中央値           |
| `logs tail` の遅延                 | 1 秒以内   | API の `LOG_TAIL_POLL_MS` に依存 |
| `tokens create`                    | 500ms 以内 | ローカル API                     |
| `--help` / `schema`                | 500ms 以内 | API 不要                         |
| MCP `tools/list`                   | 200ms 以内 | 起動後の一覧取得                 |

CLI の計測値には Node.js の起動と `tsx` の読み込みが含まれます。配布物（`dist/bin.js`）ではさらに短くなります。

## ベンチマーク

`scripts/bench-cli.mjs` は一時ディレクトリに API と SQLite DB を起動し、10 万行のログを投入して `logs query` を 10 回実行します。

```bash
node scripts/bench-cli.mjs --help
node scripts/bench-cli.mjs
pnpm bench:cli
```

オプション:

- `--rows <n>`: 投入するログ行数（既定 100000）
- `--runs <n>`: `logs query` の実行回数（既定 10）
- `--keep`: 一時 DB を残す

出力は Markdown です。中央値が 2000ms 以下なら `pass`、超える場合は `over target` と表示します。結果は PR の説明に貼り、CI には追加しないでください。

## 制限値

制限値は `apps/cli/src/limits.ts` の `CLI_LIMITS` を正とします。値を変更するときはこの表も更新してください。

| 項目                     | 値                  | 備考                                    |
| ------------------------ | ------------------- | --------------------------------------- |
| `logs query --limit`     | 最大 500、既定 100  | API の上限も 500                        |
| `logs tail` の再接続     | 最大 10 回          | `--no-reconnect` で無効化               |
| `logs tail` のバックオフ | 最大 30 秒          | 指数バックオフ                          |
| MCP のログ結果           | 最大 200 行         | `sys4sys_query_logs`                    |
| API トークンの最大期限   | 365 日              | 既定 90 日                              |
| deploy 要求の期限        | 24 時間（1440 分）  | `DEPLOY_REQUEST_TTL_MINUTES` で変更可能 |
| deploy 要求の最大期限    | 10080 分（7 日）    | サーバー設定の上限                      |
| 同時 deploy              | サービスごとに 1 つ | pending 要求の重複は 409                |

## 遅い場合の対処

1. `--service` / `--host` で対象を絞る。
2. `--since` / `--until` で時間範囲を絞る。
3. `--limit` を小さくし、`nextCursor` でページングする。
4. `logs tail` の再接続間隔と API の `LOG_TAIL_POLL_MS` を確認する。
5. MCP では `sys4sys_query_logs` に `serviceId` と `from` / `to` を指定する。
6. API と CLI が別ホストの場合はネットワーク遅延を確認する。
