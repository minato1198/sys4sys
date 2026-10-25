# ADR 0004: サービス env / deploy.env は既定でマスクし、サーバー側で AES-256-GCM 暗号化する

- 日付: 2026-10-25
- 状態: 採用

## 背景

サービスの `env` と `deploy.env` には API key、DB パスワード、シークレットが入れられる。これを Web API、CLI、監査ログ、AI レポート、ログのどこかに平文で出してしまうと、意図しない範囲へ秘密が広がる。

sys4sys はサービス起動や deploy 実行時にだけ env 値が必要であり、通常の閲覧・監査・AI 分析では平文値を必要としない。

## 決定

**読み取りは既定でマスクし、平文値が必要な操作だけを admin + `services:secrets` + 監査付きの別エンドポイントに限定する。**

読み取り:

- `GET /api/services` は `env` / `deploy.env` の値を省略し、キー名だけ返す
- `GET /api/services/:id` は `env` / `deploy.env` の値を `"***"` に置換し、`envKeys` / `deploy.envKeys` でキー名を返す
- 平文値が必要な場合は `GET /api/services/:id/secrets` を使う。admin 権限と `services:secrets` スコープが必要で、成功時も失敗時も監査ログを記録する
- CLI の `--show-env` は secrets API を経由する。通常の `services get` は平文値を出さない

保存:

- `SECRET_ENCRYPTION_KEY` が設定されていればその鍵から AES-256-GCM 鍵を導出し、なければ開発用に `SESSION_SECRET` から導出する
- production では `SECRET_ENCRYPTION_KEY` を必須にする
- `services.env` と `deploy.env` の値を保存前に AES-256-GCM で暗号化する
- 保存形式は `v1:<iv>:<tag>:<ciphertext>`（base64）。IV は保存ごとにランダム
- 既存の平文 env は起動時または明示マイグレーションで暗号化する。冪等にする
- API 応答、監査ログ、CLI 出力には平文値も暗号文も出さない
- サービス起動、deploy 実行、デプロイ要求スナップショット作成時だけサーバー側で復号する
- 復号失敗時は `秘密値の復号に失敗しました` のような安全なメッセージだけ返し、鍵・暗号文・環境変数名の秘密値を露出しない

AI・ログ:

- AI 分析に渡すログ・インシデント本文は `maskText` を通す
- MCP・CLI・レポートなどの外部出力は、明示的な secrets 取得操作以外では平文値を返さない

## 理由

- 秘密値の「閲覧権限」と「実行に使う権限」を分離できる
- DB 漏えい時にも env 値がすぐには読めない
- 監査ログ・CLI 出力・AI prompt への漏えいを防止できる
- Web / CLI / API で同じマスク規則を維持しやすい

## 代替案

- **env を平文保存し、一覧応答だけマスクする案**: 実装は簡単だが DB・バックアップが漏えい源になるため却下
- **Vault / KMS を採用する案**: セキュリティは強いが、初期運用の依存を増やす。まずアプリ内 AES-256-GCM と鍵管理規約で抑え、将来の外部 KMS 移行余地を残す
- **`--show-env` を admin ならいつでも許可する案**: 人間向け管理操作を容易にするが、誤出力が広がりやすい。admin 権限に加えて `services:secrets` スコープと監査を必須にする

## 運用上の注意

- `SESSION_SECRET` を変更すると、`SESSION_SECRET` から導出していた秘密値は復号できなくなる
- production では `SECRET_ENCRYPTION_KEY` を少なくとも 32 文字のランダム値で設定する
- `.env`、DB、バックアップ、`credentials.json`、CLI 出力を Git や Issue にコミットしない
- `--show-env` は常用しない。必要な時だけ一時的に実行し、出力を保存しない
- 監査ログの `reason` にユーザーが入力したメモが残ることがあるため、`--note` に秘密値を書かない
