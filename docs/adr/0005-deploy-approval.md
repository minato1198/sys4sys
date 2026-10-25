# ADR 0005: デプロイ承認は service 単位で four-eyes を必須にし、env はスナップショットハッシュで保護する

- 日付: 2026-10-25
- 状態: 採用

## 背景

sys4sys の deploy はサービスに任意のコマンドを実行し、`env` / `deploy.env` を注入できる。既存の即時 deploy は operator 権限だけで実行できたが、重要サービスでは「実行する人」と「承認する人」を分離したい。同時に、承認要求作成後に deploy 設定や env が黙って変更されないことも確認したい。

秘密値は DB に保存されており、承認要求や監査ログに平文 env を残してはいけない。

## 決定

**サービス単位の `deploy.requireApproval` と `deploy_requests` テーブルによる four-eyes デプロイ承認**を採用する。

サービス設定:

- `deploy.requireApproval` を追加する。既定値は `DEPLOY_REQUIRE_APPROVAL_DEFAULT`（既定 `false`）
- 既存の即時 deploy は `requireApproval=false` の場合だけ従来通り `POST /api/services/:id/deploy` で実行できる

即時 deploy:

- `requireApproval=true` の場合、`POST /api/services/:id/deploy` は実行せず 409 を返す
- Problem Details に `approval_required` の状況と、既存 pending 要求がある場合は `deployRequestId` を返す
- CLI は exit 4 で `services deploy <id> --request` を案内する

承認要求:

- `POST /api/services/:id/deploy-requests` で pending 要求を作成する
- `deploy_requests` は要求者、期限、status、決定者、決定時刻、memo、action id、snapshot を保存する
- `status` は `pending` / `approved` / `rejected` / `expired` / `executed` / `failed`
- snapshot には command、cwd、timeoutSec、restartAfter、healthTimeoutSec、`envHash`、`deployEnvHash` を保存する
- `envHash` / `deployEnvHash` は要求作成時点の env を安定した JSON 順で SHA-256 ハッシュ化したもので、平文 env も暗号文も保存しない
- 同一サービスに pending 要求が既にある場合は 409 と既存要求 ID を返す
- pending 要求は期限切れになると `expired` になる

承認:

- `POST /api/deploy-requests/:id/approve` は `approvals:decide` を要求する
- 原則として要求者と承認者を別ユーザーにする。`requestedBy` が自分と一致する承認は 403
- 明示的な例外運用が必要な場合だけ `DEPLOY_ALLOW_SELF_APPROVAL=true` を設定する
- 承認時点で現在の deploy 設定・env / deploy.env ハッシュが snapshot と一致しなければ 409
- 期限切れ、二重決定、サービスまたは deploy 設定の消失も 409
- 承認成功後は `approved` になり、deploy action を開始して `executed` / `failed` に遷移する

監視インシデント承認:

- `approvals.requestedBy` を追加し、監視エンジン由来の承認は `null` とする
- 監視由来の `requestedBy=null` は operator / admin どちらも承認できる
- ユーザー起因の承認は要求者と同一ユーザーの approve を 403 で拒否する
- 二重決定は 409

## 理由

- 高リスクな deploy で four-eyes を強制できる
- 承認前に設定や env が変更されていないことを確認できる
- 承認要求と監査ログに env 平文値を残さない
- 既存の即時 deploy を `requireApproval=false` のまま無回帰で維持できる
- Web と CLI が同じ API 契約で承認操作を共有できる

## 代替案

- **`approvals` に deploy 承認を混在させる案**: テーブルは減るが、インシデント再起動承認と deploy 承認で lifecycle と snapshot 意味が異なるため却下
- **即時 deploy 前に `requireApproval` を見るだけにする案**: 承認記録・期限・スナップショットが変わっていないかの確認ができないため却下
- **承認時に現在の env を復号して比較する案**: 比較は正確だが、平文 env を API・CLI・監査に露出させないため、SHA-256 ハッシュだけを保存・比較する
- **管理者の自己承認を常に許可する案**: 単一管理者環境では便利だが four-eyes を壊す。既定では禁止し、明示設定でのみ許可する

## 運用上の注意

- 要求者・承認者・CI トークンは別ユーザーまたは別トークンに分離する
- `DEPLOY_ALLOW_SELF_APPROVAL=true` は単一管理者の開発・緊急運用向けであり、本番では有効にしない
- 承認 memo に env 値、API key、パスワード、トークンを書かない。`reason` は監査ログに残る
- Web / CLI は 409 の `approval_required`、期限切れ、スナップショット変更をユーザーにそのまま表示し、再要求を促す
- deploy 実行自体は `deploy:execute`、承認操作は `approvals:decide` を要求する
