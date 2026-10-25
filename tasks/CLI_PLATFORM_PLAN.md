# sys4sys CLI / AI 連携 実装計画

- 版: v1.4（smoke 確認更新）
- 作成日: 2026-10-24 / 更新日: 2026-10-25
- 対象: `apps/cli`, `apps/api`, `packages/shared`, `docs`
- 基準コミット: `e7bdede feat(cli): add minimal service and deploy CLI`
- ステータス: P0 実装完了。P1 実装完了（インシデント、承認、ホスト、ポート、レポート、監査、設定、シークレット、デプロイ承認、docs/tests/CI）。P2 未実装。full API smoke は temp DB + admin password + local OpenAI-compatible mock で 96/96 確認済み。

---

## 0. この計画の位置づけ

`tasks/PLAN.md` は sys4sys 本体（監視・復旧・レポート）のプロダクト計画である。本計画は、その上に載せる **CLI / AI エージェント連携 / 運用手順の実行計画** を、PR 単位まで分解したものである。

### 0.1 前提

- API が唯一の真実源（source of truth）。CLI は SQLite を直接読まない・書かない。
- 既存の Web UI と API の挙動を壊さない。既存 CLI コマンドは互換維持する。
- 認証は段階移行する。API トークン実装までは、現行のセッション Cookie 認証を維持する。
- `env` / `deploy.env` は既定でマスクする。表示は明示操作（`--show-env`）に限定する。
- 非対話環境の破壊的操作は `--yes` を必須にする。
- 公開リポジトリに実シークレット、ローカル DB、鍵、ログ、個人パスをコミットしない。
- 本計画では実装しない。実装順・変更点・検証方法・完了条件を固定する。

### 0.2 現状ベースライン

| 領域               | 実装済み                                                                | 不足                                                                                  |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| CLI 認証           | `SYS4SYS_EMAIL` / `SYS4SYS_PASSWORD`、`SYS4SYS_SESSION_COOKIE`          | 永続ログイン、API トークン、スコープ、`logout`                                        |
| CLI コマンド       | `whoami`, `hosts list`, `services list/get/create/update/deploy`        | サービス起動/停止/再起動/削除、ログ、インシデント、承認、ポート、レポート、監査、設定 |
| API 認証           | Argon2id、DB セッション、Cookie、3 ロール                               | Bearer トークン、スコープ、トークン管理                                               |
| サービス           | CRUD、start/stop/restart、deploy、health、`recentActions`（最大 20 件） | アクション履歴 API、CLI のライフサイクル操作                                          |
| ログ               | 検索 API、SSE、ソース管理 API                                           | CLI の query/tail、ソース管理 CLI                                                     |
| インシデント       | 一覧/詳細/ack/resolve/analyze/analysis                                  | CLI コマンド                                                                          |
| 承認               | 一覧/approve/reject（インシデント由来）                                 | 二重決定防止、デプロイ承認、CLI                                                       |
| ホスト/ポート      | 一覧/登録/更新/検出、履歴/予約/kill                                     | CLI コマンド、kill の二段階操作                                                       |
| レポート/監査/設定 | API あり                                                                | CLI コマンド、秘密値のサーバー側マスク                                                |
| シークレット       | CLI 側の表示マスク、SMTP/AI キーの暗号化                                | `env` / `deploy.env` のサーバー側マスク・暗号化・監査                                 |
| AI 連携            | なし                                                                    | JSON Schema、`SKILL.md`、MCP                                                          |
| 配布               | `tsx` 実行のみ、`private: true`                                         | `bin`、ビルド、npm 配布、クロスプラットフォーム CI                                    |

> 2026-10-25 時点で P0 実装完了。上のベースライン表は作成時点（`e7bdede`）の状態を指す。P0 に関連する不足項目は解消済みで、残っている不足は主に P1 / P2 である。

---

## 1. ゴールと非ゴール

### 1.1 ゴール

1. AI エージェントが **安全に認証し、サービスとログを操作できる**。
2. 人間の運用者が **Web UI と同等の主要操作を CLI で完結**できる。
3. CLI の契約が **機械可読（JSON Schema）** で、AI が誤用しにくい。
4. 破壊的操作が **確認・監査・スコープ・承認** で統制される。
5. シークレットが **API 応答・ログ・監査・AI 送信** の各経路で漏れにくい。
6. MCP により、AI クライアントから **限定された安全なツール** として利用できる。
7. npm から導入でき、CI で継続的に検証される。

### 1.2 非ゴール

- Web UI の代替を作ること。
- CLI から DB を直接操作すること。
- LLM に任意のシェル実行権限を与えること。
- リモートのマルチテナント SaaS 化。
- 既存の監視・復旧ポリシーエンジンの再設計。
- P0 での MCP 実装（トークンとスキーマの後）。

---

## 2. 優先度

提案済みの P0 / P1 / P2 を、依存関係に合わせて再整理する。

| 優先度 | テーマ                    | 含む機能                                                                                                  | 提供価値                                                    | 完了条件（Gate）                                        |
| ------ | ------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| **P0** | AI が使える最小運用ループ | API トークン/スコープ、ログイン/プロフィール、サービスのライフサイクル、ログ検索/tail、JSON Schema、SKILL | AI がトークンで認証し、サービスを調査・操作し、ログを読める | P0 Gate を満たす。既存 CLI と Web UI が無回帰           |
| **P1** | 運用全面と安全強化        | インシデント、承認、ホスト、ポート、レポート、監査、設定、シークレット、デプロイ承認                      | 人間の運用操作を CLI で完結し、秘密値と破壊的操作を統制する | P1 Gate を満たす。監査と秘密値のテストが通る            |
| **P2** | エージェント配布と品質    | MCP、npm 配布、クロスプラットフォーム CI、ライブ E2E、doctor/completions                                  | 外部 AI クライアントと導入先で安全に使える                  | P2 Gate を満たす。インストール済みバイナリで E2E が通る |

### 2.1 推奨実行順

1. **P0**: API トークン/スコープ → サービスライフサイクル + ログ → Schema + SKILL
2. **P1**: インシデント/承認 → ホスト/ポート/レポート/監査/設定 → シークレット → デプロイ承認
3. **P2**: MCP → 配布 → クロスプラットフォーム CI/E2E

MCP は必ず P0 のトークン・スコープ・Schema の後にする。MCP が先に進むと、権限の絞り方とツール契約が固まらないまま公開面が増える。

---

## 3. アーキテクチャ決定

### ADR-0002: API トークンとスコープ

- 方式: `Authorization: Bearer <token>`。
- トークン形式: `s4s_<base64url(32 bytes)>`。表示用に先頭 8 文字の prefix を保持する。
- 保存: 全文は保存せず、SHA-256 ハッシュのみ保存する。照合はハッシュの索引検索。
- スコープ: ロールの **部分集合**。トークン作成時にロール上限を超えるスコープは 422。
- セッション: そのロールが持つ全スコープを持つものとして扱う。
- 期限: 既定 90 日、最大 365 日。`expiresAt` 必須。
- 失効: `revokedAt` を立てると即時無効。ユーザー無効化・ロール変更も即時反映。
- 監査: 作成・失効・認証失敗を `audit_logs` に記録する。トークン全文は記録しない。
- 401 と 403 を区別する。スコープ不足は 403 とし、Problem Details に `requiredScope` を含める。

**スコープ一覧**

| スコープ           | 用途                          | viewer | operator | admin |
| ------------------ | ----------------------------- | ------ | -------- | ----- |
| `services:read`    | サービス一覧/詳細/health      | ○      | ○        | ○     |
| `services:write`   | 作成/更新/削除                | -      | -        | ○     |
| `services:operate` | start/stop/restart            | -      | ○        | ○     |
| `services:secrets` | env / deploy.env の復号値取得 | -      | -        | ○     |
| `deploy:execute`   | deploy 実行/承認              | -      | ○        | ○     |
| `logs:read`        | ログ検索/tail                 | ○      | ○        | ○     |
| `logs:manage`      | ログソース管理                | -      | -        | ○     |
| `incidents:read`   | インシデント閲覧              | ○      | ○        | ○     |
| `incidents:write`  | ack/resolve/analyze           | -      | ○        | ○     |
| `approvals:read`   | 承認一覧                      | ○      | ○        | ○     |
| `approvals:decide` | approve/reject                | -      | ○        | ○     |
| `hosts:read`       | ホスト閲覧                    | ○      | ○        | ○     |
| `hosts:write`      | ホスト登録/更新/検出          | -      | -        | ○     |
| `ports:read`       | ポート/履歴/予約閲覧          | ○      | ○        | ○     |
| `ports:operate`    | 予約/解放/kill                | -      | ○        | ○     |
| `reports:read`     | レポート閲覧/export           | ○      | ○        | ○     |
| `audit:read`       | 監査ログ閲覧                  | -      | -        | ○     |
| `settings:read`    | 設定閲覧                      | -      | -        | ○     |
| `settings:write`   | 設定更新/テスト/バックアップ  | -      | -        | ○     |
| `tokens:manage`    | 他ユーザーのトークン管理      | -      | -        | ○     |

補足:

- セッション認証では、自分のトークン作成・失効を `tokens:manage` なしで許可する。ただしスコープは自分のロール以下に限る。
- トークン認証では、`tokens:manage` を持たないトークンは **新しいトークンを作成できない**（読み取り専用トークンから強いトークンへの昇格を防ぐ）。`tokens:manage` を持つトークンでも、作成できるスコープは **自分のロールと発行元トークンのスコープの共通部分** に限る。
- `deploy:execute` は「デプロイを要求できる」権限。承認が必要な場合は別途 `approvals:decide` を持つ第三者が承認する。
- `ports:operate` の kill は CLI 側で二段階（kill-token 取得 → 確認付き kill）を必須にする。

### ADR-0003: CLI の資格情報ストア

- 保存先: `SYS4SYS_CONFIG_DIR` があればそこ、なければ Windows は `%APPDATA%\sys4sys`、macOS/Linux は `$XDG_CONFIG_HOME/sys4sys` または `~/.config/sys4sys`。
- ファイル: `credentials.json`。`{ "apiUrl": "...", "token": "...", "tokenId": "...", "tokenExpiresAt": "...", "sessionCookie": "...", "sessionExpiresAt": "..." }`。
- パーミッション: Unix は `0600`。Windows は `chmod` が効かないため、作成時に ACL を絞れる範囲で絞り、広い場合は警告する。
- 優先順位:
  1. `--api` / `SYS4SYS_API_URL`
  2. `SYS4SYS_TOKEN`
  3. `SYS4SYS_TOKEN_FILE`
  4. 保存済みトークン
  5. `SYS4SYS_SESSION_COOKIE`
  6. 保存済みセッション Cookie
  7. `SYS4SYS_EMAIL` + `SYS4SYS_PASSWORD`
- トークンを `--token` で受け取らない（プロセス一覧・シェル履歴に残るため）。`--token-stdin` または環境変数を使う。
- `auth login` はセッション Cookie を保存する。`tokens create --save` はトークンを保存する。保存時は既存の別方式を消す（混在防止）。
- `auth logout` は保存済み資格情報を削除し、可能なら API の logout / token revoke を呼ぶ。

### ADR-0004: シークレットのマスクと暗号化

- 読み取り経路:
  - `GET /api/services` は `env` / `deploy.env` の値を省略し、キー名だけ返します。`GET /api/services/:id` の値は `"***"` に置換します。
  - 値の有無は `envKeys: string[]` / `deploy.envKeys: string[]` で返します。
  - 復号値が必要な場合は `GET /api/services/:id/secrets`（admin のみ、監査必須）を使う。
  - CLI の `--show-env` はこのエンドポイントを呼ぶ。通常の `services get` では値を出さない。
- 保存経路:
  - `SECRET_ENCRYPTION_KEY` を追加する。未設定の開発環境では `SESSION_SECRET` から導出するが、production では必須にする。
  - `env` の各値、`deploy.env` の各値を AES-256-GCM のエンベロープ（`v1:<iv>:<tag>:<data>`）で暗号化する。
  - 既存の平文データは起動時または明示マイグレーションで暗号化する。冪等にする。
  - 実行時（サービス起動・deploy）だけ復号する。ログ・監査・API 応答には復号値を出さない。
- AI / MCP:
  - AI に送るログは既存の `maskText` を通す。
  - MCP のログ系ツールは既定でマスク済みの結果を返す。`raw` は管理者トークンでも提供しない（将来の明示設定まで保留）。

### ADR-0005: デプロイ承認

- サービス単位の `deploy.requireApproval`（既定 `false`）と、環境既定 `DEPLOY_REQUIRE_APPROVAL_DEFAULT` を追加する。
- `requireApproval=true` の場合、`POST /api/services/:id/deploy` は即時実行せず 409 で「承認が必要」を返す。代わりに `POST /api/services/:id/deploy-requests` を使う。
- 新しい `deploy_requests` テーブル:
  - `id`, `serviceId`, `requestedBy`, `requestedAt`, `status` (`pending|approved|rejected|expired|executed|failed`), `decidedBy`, `decidedAt`, `note`, `actionId`, `snapshot`, `expiresAt`
  - `snapshot` には command / cwd / timeout / restartAfter / healthTimeoutSec のみ。env は含めない。
- 承認は **要求者と別ユーザー** を必須にする（four-eyes）。管理者でも自己承認は不可。例外運用が必要なら `DEPLOY_ALLOW_SELF_APPROVAL=true` を明示的に設定する。
- 承認時にスナップショットが現在の設定と一致することを確認する。変わっていたら 409 で再要求させる。
- CLI:
  - `services deploy <id> --request` で承認要求。
  - `deploy-requests list/get/approve/reject` で承認操作。
  - `services deploy <id>` は `requireApproval=false` のときだけ即時実行。

### ADR-0006: コマンドレジストリと Schema

- CLI のコマンド定義を 1 つのレジストリに集約する。
  - `name`, `summary`, `description`, `positionals`, `options`, `examples`, `mutating`, `requiresConfirmation`, `requiredScopes`, `phase`
- `help` はレジストリから生成する。
- `schema --json` はレジストリ + Zod スキーマから JSON Schema を生成する。
- `docs/cli-schema.json` を生成物としてコミットし、CI で差分がないことを確認する。
- これにより、SKILL と MCP のツール定義が同じ契約を参照できる。

### ADR-0007: MCP は CLI の上に載せる

- 別パッケージを作らず、`sys4sys mcp serve` として CLI 内に実装する。
- 既定は stdio transport。API へは既存の `ApiClient` 経由で接続する。
- ツールは許可リスト方式。読み取り系を先に公開し、書き込み系は P2-02 でスコープと承認を確認してから追加する。
- MCP サーバーはトークン (`SYS4SYS_TOKEN`) を必須にし、対話ログインは使わない。
- MCP の出力にシークレットを含めない。`env` 系は既定でキー名のみ。

---

## 4. 目標コマンド体系

`--json` は全コマンドで利用可能にする。`--dry-run` は変更系で必須、`--yes` は非対話の破壊的操作で必須。

| コマンド                                          | Phase | 変更         | 確認                    | 主なスコープ                                          |
| ------------------------------------------------- | ----- | ------------ | ----------------------- | ----------------------------------------------------- |
| `sys4sys auth login`                              | P0    | ローカル保存 | -                       | -                                                     |
| `sys4sys auth logout`                             | P0    | ローカル削除 | -                       | -                                                     |
| `sys4sys auth status`                             | P0    | -            | -                       | -                                                     |
| `sys4sys whoami`                                  | P0    | -            | -                       | -                                                     |
| `sys4sys tokens list`                             | P0    | -            | -                       | 自分のみ / `tokens:manage`                            |
| `sys4sys tokens create`                           | P0    | API          | トークン表示            | 自分のみ / `tokens:manage`                            |
| `sys4sys tokens revoke`                           | P0    | API          | `--yes`                 | 自分のみ / `tokens:manage`                            |
| `sys4sys services list/get`                       | P0    | -            | `--show-env` は P1      | `services:read`（`--show-env` は `services:secrets`） |
| `sys4sys services create/update`                  | P0    | API          | `--dry-run`             | `services:write`                                      |
| `sys4sys services delete`                         | P0    | API          | `--yes`                 | `services:write`                                      |
| `sys4sys services start/stop/restart`             | P0    | API          | stop/restart は `--yes` | `services:operate`                                    |
| `sys4sys services deploy`                         | P0    | API          | `--yes` / `--request`   | `deploy:execute`                                      |
| `sys4sys services actions`                        | P0    | -            | -                       | `services:read`                                       |
| `sys4sys logs query`                              | P0    | -            | -                       | `logs:read`                                           |
| `sys4sys logs tail`                               | P0    | -            | Ctrl+C                  | `logs:read`                                           |
| `sys4sys logs sources list/create/update/delete`  | P1    | API          | 変更は `--yes`          | `logs:read` / `logs:manage`                           |
| `sys4sys incidents list/get`                      | P1    | -            | -                       | `incidents:read`                                      |
| `sys4sys incidents ack/resolve/analyze`           | P1    | API          | `--yes`                 | `incidents:write`                                     |
| `sys4sys incidents analysis`                      | P1    | -            | -                       | `incidents:read`                                      |
| `sys4sys approvals list`                          | P1    | -            | -                       | `approvals:read`                                      |
| `sys4sys approvals approve/reject`                | P1    | API          | `--yes`                 | `approvals:decide`                                    |
| `sys4sys hosts list/get`                          | P1    | -            | -                       | `hosts:read`                                          |
| `sys4sys hosts create/update/detect`              | P1    | API          | `--yes`                 | `hosts:write`                                         |
| `sys4sys ports list/history`                      | P1    | -            | -                       | `ports:read`                                          |
| `sys4sys ports reserve/release`                   | P1    | API          | `--yes`                 | `ports:operate`                                       |
| `sys4sys ports kill`                              | P1    | API          | 二段階 + `--yes`        | `ports:operate`                                       |
| `sys4sys reports list/get/export`                 | P1    | -            | -                       | `reports:read`                                        |
| `sys4sys audit list`                              | P1    | -            | -                       | `audit:read`                                          |
| `sys4sys settings mail/ai/retention get/set/test` | P1    | API          | `--yes`                 | `settings:read/write`                                 |
| `sys4sys settings backup`                         | P1    | API          | `--yes`                 | `settings:write`                                      |
| `sys4sys deploy-requests list/get/approve/reject` | P1    | API          | `--yes`                 | `deploy:execute` / `approvals:decide`                 |
| `sys4sys schema [command]`                        | P0    | -            | -                       | -                                                     |
| `sys4sys doctor`                                  | P2    | -            | -                       | -                                                     |
| `sys4sys mcp serve`                               | P2    | -            | -                       | トークン必須                                          |
| `sys4sys version`                                 | P2    | -            | -                       | -                                                     |
| `sys4sys completions <shell>`                     | P2    | -            | -                       | -                                                     |

### 4.1 出力規約

- データ系の `--json` は API のレスポンスをそのまま返す（既存互換）。
- エラーは `{ "error": { "message", "status", "title", "detail", "requiredScope?" } }`。
- 一覧系は `items`, `nextCursor`, `total` を標準化する。API が返さない場合は CLI 側で補完しない。
- ログ tail の `--json` は 1 行 1 JSON（NDJSON）にする。通常出力は `ts level service message`。
- 人間向け出力にシークレットを出さない。`--show-env` のときだけ警告を stderr に出す。

### 4.2 終了コード

| コード | 意味                                |
| ------ | ----------------------------------- |
| `0`    | 成功                                |
| `1`    | 一般エラー / API 5xx / ネットワーク |
| `2`    | 入力・スキーマ・使い方の誤り        |
| `3`    | 認証・認可エラー（401/403）         |
| `4`    | 競合（409）                         |
| `5`    | 非同期処理の失敗・タイムアウト      |

---

## 5. 依存関係と実行順

```text
P0-01 コマンドレジストリ
  ├─ P0-02 トークン契約
  │    └─ P0-03 DB/トークンサービス
  │         └─ P0-04 API 認証 + トークン API
  │              ├─ P0-05 CLI 資格情報 + auth
  │              │    └─ P0-06 CLI tokens
  │              ├─ P0-07 サービスアクション API
  │              │    └─ P0-08 サービスライフサイクル CLI
  │              ├─ P0-09 ログ検索 CLI
  │              │    └─ P0-10 ログ tail CLI
  │              └─ P0-11 Schema
  │                   └─ P0-12 SKILL + docs + CI
  │
  ├─ P1-01 インシデント CLI
  ├─ P1-02 承認 CLI + 自己承認防止
  ├─ P1-03 ホスト CLI
  ├─ P1-04 ポート閲覧/予約
  ├─ P1-05 ポート kill
  ├─ P1-06 レポート CLI
  ├─ P1-07 監査 CLI
  ├─ P1-08 設定 CLI
  ├─ P1-09 シークレットの読み取りマスク
  ├─ P1-10 シークレットの保存時暗号化
  └─ P1-11 デプロイ承認
       └─ P1-12 docs/tests/CI

P2-01 MCP 読み取り
  └─ P2-02 MCP 書き込み
P2-03 npm 配布
P2-04 クロスプラットフォーム CI
P2-05 ライブ E2E
P2-06 doctor/completions
P2-07 性能・制限・運用ドキュメント
```

### 5.1 クリティカルパス

`P0-02 → P0-03 → P0-04 → P0-05 → P0-08 → P0-09 → P0-11 → P0-12`

P0-04 が終わるまで CLI のトークン対応は入れられない。P0-05 と P0-06 は P0-04 に強く依存する。P0-07 は P0-04 と独立して進められるが、P0-08 の待機処理が使うため先に入れる。

### 5.2 並列化可能な単位

- P0-09（ログ検索）と P0-07（アクション API）は並列可。
- P1-03 / P1-04 / P1-06 / P1-07 は P0-04 の後なら並列可。
- P1-09 と P1-10 は同じファイル群に触れるため直列。
- P2-03 / P2-04 は P0 完了後なら P2-01 と並列可。

---

## 6. PR 一覧（サマリ）

詳細は `CLI_PLATFORM_P0.md`, `CLI_PLATFORM_P1.md`, `CLI_PLATFORM_P2.md` を参照。合計 **31 PR**（P0: 12、P1: 12、P2: 7）。1 PR は 1 つの目的に限定し、独立性を保つ。

| ID    | タイトル                                     | Phase | 依存         | 主な変更                                                      |
| ----- | -------------------------------------------- | ----- | ------------ | ------------------------------------------------------------- |
| P0-01 | CLI コマンドレジストリとエラーモデル         | P0    | -            | `apps/cli/src/commands/registry.ts`, `help.ts`, `index.ts`    |
| P0-02 | API トークン契約とスコープ定義               | P0    | P0-01        | `packages/shared/src/tokens.ts`, `api.ts`                     |
| P0-03 | `api_tokens` テーブルとトークンサービス      | P0    | P0-02        | `apps/api/src/db/schema.ts`, `auth/tokens.ts`, migration      |
| P0-04 | Bearer 認証・スコープガード・トークン API    | P0    | P0-03        | `auth/guard.ts`, `routes/tokens.ts`, `routes/auth.ts`         |
| P0-05 | CLI 資格情報ストアと auth コマンド           | P0    | P0-04        | `apps/cli/src/auth/store.ts`, `commands/auth.ts`, `client.ts` |
| P0-06 | CLI トークン管理                             | P0    | P0-05        | `commands/tokens.ts`                                          |
| P0-07 | サービスアクション履歴 API                   | P0    | P0-04        | `routes/services.ts`, `shared/api.ts`                         |
| P0-08 | サービスライフサイクル CLI                   | P0    | P0-07        | `commands/services.ts`, `index.ts`                            |
| P0-09 | ログ検索 CLI                                 | P0    | P0-04        | `commands/logs.ts`                                            |
| P0-10 | ログ tail CLI（SSE）                         | P0    | P0-09        | `commands/logs.ts`, `client.ts`                               |
| P0-11 | `schema` コマンドと JSON Schema 生成         | P0    | P0-01        | `commands/schema.ts`, `docs/cli-schema.json`                  |
| P0-12 | `SKILL.md`、CLI ドキュメント、CI 更新        | P0    | P0-11        | `apps/cli/SKILL.md`, `apps/cli/README.md`, CI                 |
| P1-01 | インシデント CLI                             | P1    | P0-04        | `commands/incidents.ts`                                       |
| P1-02 | 承認 CLI と二重決定・自己承認の土台          | P1    | P0-04        | `commands/approvals.ts`, `monitoring/incidents.ts`            |
| P1-03 | ホスト管理 CLI                               | P1    | P0-04        | `commands/hosts.ts`                                           |
| P1-04 | ポート閲覧・予約・解放 CLI                   | P1    | P0-04        | `commands/ports.ts`                                           |
| P1-05 | ポート kill の二段階 CLI                     | P1    | P1-04        | `commands/ports.ts`                                           |
| P1-06 | レポート CLI                                 | P1    | P0-04        | `commands/reports.ts`                                         |
| P1-07 | 監査ログ CLI                                 | P1    | P0-04        | `commands/audit.ts`                                           |
| P1-08 | 設定 CLI                                     | P1    | P0-04        | `commands/settings.ts`                                        |
| P1-09 | サービス env の読み取りマスク API            | P1    | P0-04        | `routes/services.ts`, `shared/api.ts`                         |
| P1-10 | サービス env の保存時暗号化                  | P1    | P1-09        | `settings/crypto.ts`, `services/*`, migration                 |
| P1-11 | デプロイ承認ワークフロー                     | P1    | P1-02        | `deploy_requests`, `routes/deploy-requests.ts`                |
| P1-12 | P1 ドキュメント・テスト・CI                  | P1    | P1-01..P1-11 | docs, smoke, CI                                               |
| P2-01 | MCP 読み取りサーバー                         | P2    | P0-11, P1-09 | `apps/cli/src/mcp/*`                                          |
| P2-02 | MCP 書き込みツールとポリシー                 | P2    | P2-01, P1-11 | `mcp/tools/*`                                                 |
| P2-03 | npm 配布とリリース                           | P2    | P0-12        | `apps/cli/package.json`, release workflow                     |
| P2-04 | クロスプラットフォーム CI とインストール検証 | P2    | P2-03        | `.github/workflows/ci.yml`                                    |
| P2-05 | ライブ E2E テストハーネス                    | P2    | P0, P1       | `apps/cli/test/e2e/*`                                         |
| P2-06 | `doctor` / `version` / 補完                  | P2    | P0-01        | `commands/doctor.ts`, completions                             |
| P2-07 | 性能・制限・運用ドキュメント                 | P2    | P1           | docs, benchmark                                               |

---

## 7. 横断要件

### 7.1 確認と dry-run

- 変更系は `--dry-run` を受け付ける。dry-run は API を変更しないが、存在確認のための読み取りは行ってよい。
- 破壊的操作（stop / restart / delete / kill / approve / reject / settings 更新 / backup）は `--yes` なしの非対話実行を拒否する。
- 対話時は対象・影響・戻し方を stderr に表示してから確認する。
- `--json` 時は確認プロンプトを出さない。`--yes` がなければ exit 2。

### 7.2 監査

- すべての変更系 API は既存の `writeAudit` を呼ぶ。
- CLI は API の監査に任せる。CLI 側で独自の監査ファイルを作らない。
- トークン認証の変更操作は、`actorLabel` をユーザーのメールにし、`after.authMethod = "token"`, `after.tokenId` を残す。トークン全文は残さない。
- `--show-env` / secrets 取得は `service.secrets.reveal` として必ず監査する。

### 7.3 冪等性と競合

- deploy は既存の多重実行防止を維持する。
- 承認は `status = pending` の条件付き UPDATE で二重決定を防ぐ。
- 予約作成は既存の一意制約を維持し、409 を返す。
- CLI の `--wait` はアクション ID で追跡し、別の操作と混同しない。

### 7.4 ページネーション

- `logs`: 既存の `cursor`（ts）を使う。
- `incidents` / `reports` / `audit-logs`: 既存の `limit` / `offset` を使う。
- 新設の `service actions` / `deploy-requests`: `limit` + `cursor` を推奨。cursor は `startedAt` / `requestedAt`。
- CLI は `--limit`, `--cursor`, `--offset` をコマンドごとに明示する。無いものを無理に追加しない。

### 7.5 公開リポジトリの衛生

- テスト用トークンはダミー（`s4s_test_...`）を使い、実トークンをコミットしない。
- ドキュメントの例は `<token>`, `<service-id>`, `<host-id>` のプレースホルダにする。
- ローカル DB、`.env`、`credentials.json`、ログ、バックアップをコミットしない。`.gitignore` に `credentials.json` を追加する。
- CI では一時ディレクトリと一時 DB だけを使う。

---

## 8. テスト戦略

| 層             | 対象                                                          | 方法                     | 必須  |
| -------------- | ------------------------------------------------------------- | ------------------------ | ----- |
| Unit           | トークン生成/照合、スコープ判定、期限、暗号化、引数解析       | Node test / Vitest       | P0/P1 |
| Contract       | `schema --json` のスナップショット、Zod と JSON Schema の一致 | Node test                | P0    |
| API            | 認証/認可、トークン CRUD、自己承認防止、マスク                | `app.inject` + 一時 DB   | P0/P1 |
| CLI            | モック fetch によるコマンド別の出力・終了コード・確認         | Node test                | P0/P1 |
| E2E            | API 起動 → ログイン → トークン → CLI 実行                     | 一時 DB / ランダムポート | P2    |
| Security       | 失効/期限切れ/スコープ不足/ロール変更/自己承認/秘密値漏洩     | ネガティブテスト         | P0/P1 |
| Cross-platform | Windows / macOS / Linux のインストールと `--help`             | GitHub Actions matrix    | P2    |

### 8.1 標準検証コマンド

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test
pnpm --filter @sys4sys/web build
pnpm audit --prod
```

API の統合スモーク:

```bash
pnpm --filter @sys4sys/api smoke
```

CLI の Schema 差分:

```bash
pnpm sys4sys -- schema --json > docs/cli-schema.json
git diff --exit-code docs/cli-schema.json
```

P2 以降のインストール E2E:

```bash
pnpm --filter @sys4sys/cli build
npm pack ./apps/cli
npm install --global ./sys4sys-cli-*.tgz
sys4sys --version
sys4sys --help
```

---

## 9. リリースゲート

### P0 Gate

- [x] 管理者が `tokens create` でスコープ付きトークンを作成できる。
- [x] `SYS4SYS_TOKEN` だけで `whoami`, `services list`, `logs query` が動く。
- [x] トークンのスコープ不足が 403、失効が 401 になる。
- [x] `services start/stop/restart/delete` が動き、非対話では `--yes` が必須。
- [x] `services actions` でアクション履歴を追える。
- [x] `logs query` と `logs tail` が動く。tail は Ctrl+C で終了できる。
- [x] `schema --json` が安定し、`SKILL.md` が実際のコマンドと一致する。
- [x] 既存の `services create/update/deploy` と Web UI が無回帰。
- [x] CI の全必須チェックが通る。

> 2026-10-25 時点で local equivalent 検証済み: `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, CLI schema drift なし, `pnpm --filter @sys4sys/cli test`, `pnpm --filter @sys4sys/web build`, `pnpm audit --prod`。GitHub Actions のリモート実行結果は未確認。

### P1 Gate

- [x] インシデントの一覧/詳細/ack/resolve/analyze を CLI で実行できる。
- [x] 承認の一覧/approve/reject を CLI で実行でき、二重決定が拒否される。
- [x] デプロイ承認で自己承認が拒否される。
- [x] ホスト/ポート/レポート/監査/設定の主要操作が CLI で実行できる。
- [x] `services get` の応答に env の値が含まれない。`--show-env` は admin のみで監査される。
- [x] 保存時の env が暗号化され、平文のまま DB に残らない。
- [x] デプロイ承認が要求者と別ユーザーで通り、自己承認・古いスナップショットが拒否される。
- [x] 監査ログにトークン・秘密値・env の値が残らない。
- [x] P1 の CLI テストと API テストが通る。

### P2 Gate

- [ ] MCP 読み取りツールでサービス/ログ/インシデントを参照できる。
- [ ] MCP 書き込みツールは明示設定とスコープがないと公開されない。
- [ ] npm からインストールした `sys4sys` が Windows/macOS/Linux で `--help` と `doctor` を実行できる。
- [ ] ライブ E2E が CI で安定して通る。
- [ ] 配布物にトークン、DB、ログ、個人パスが含まれない。

---

## 10. リスクと対策

| リスク                             | 影響                       | 対策                                                                            |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| トークン漏洩                       | なりすまし・操作権限の悪用 | 短い期限、スコープ最小化、失効、監査、ログへの非出力、`--token` 禁止            |
| スコープ設計の複雑化               | 実装ミス・UI との不整合    | ロールを上限にした単純な積集合。`requireScope` を 1 箇所に集約                  |
| セッション Cookie とトークンの混在 | CSRF・権限判定の混乱       | Bearer を優先し、Cookie は Bearer がない場合のみ。CSRF は Cookie 経路だけに適用 |
| env の復号値漏洩                   | 重大                       | 既定マスク、専用エンドポイント、admin 限定、監査、AI/MCP へ渡さない             |
| 暗号鍵の変更                       | 復号不能                   | `SECRET_ENCRYPTION_KEY` を固定。ローテーションは別 ADR。開発時の導出を明示      |
| デプロイ承認の形骸化               | 統制の無効化               | 自己承認禁止、スナップショット照合、期限、監査                                  |
| MCP の過剰公開                     | 意図しない操作             | 読み取り先行、許可リスト、スコープ、破壊的ツールは既定で非公開                  |
| Windows の資格情報パーミッション   | ローカル漏洩               | ACL best-effort、警告、環境変数/トークンファイルの推奨                          |
| ログ量・tail の負荷                | CLI/API の性能劣化         | `limit`、`--since`、レベル/サービス絞り込み、バックプレッシャー                 |
| 既存 CLI の互換破壊                | 利用者・CI の停止          | 既存コマンドと JSON 形状を維持。新規は追加のみ                                  |

---

## 11. 未決事項

実装前に決める。既定案を併記する。

| 項目                               | 既定案                                                 | 決定期限 |
| ---------------------------------- | ------------------------------------------------------ | -------- |
| トークン作成を一般ユーザーに許すか | 自分のみ許可。他ユーザーは admin                       | P0-02    |
| `auth login` の保存方式            | セッション Cookie を保存。トークンは明示作成           | P0-05    |
| `SECRET_ENCRYPTION_KEY` の必須化   | production は必須、開発は SESSION_SECRET 導出          | P1-09    |
| デプロイ承認の既定                 | `false`（既存挙動維持）。環境変数で一括有効化          | P1-11    |
| 自己承認の例外                     | 既定で禁止。`DEPLOY_ALLOW_SELF_APPROVAL=true` のみ許可 | P1-11    |
| MCP の transport                   | まず stdio。HTTP は P3 以降                            | P2-01    |
| npm パッケージ名                   | `@sys4sys/cli` を公開するか `sys4sys` にするか         | P2-03    |
| 完了通知                           | CLI はポーリング。Webhook は将来                       | P1-12    |

---

## 12. 実行チェックリスト

### 着手前

- [x] `tasks/PLAN.md` の M6 完了状態と本計画の前提が一致している。
- [x] `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` が通る。
- [x] `apps/api/src/smoke.ts` の既存チェック数と実行方法を確認する。
- [x] 公開リポジトリに secrets / DB / 個人パスがないことを確認する。

### P0

- [x] P0-01 コマンドレジストリ
- [x] P0-02 トークン契約
- [x] P0-03 DB/トークンサービス
- [x] P0-04 Bearer 認証 + トークン API
- [x] P0-05 CLI 資格情報 + auth
- [x] P0-06 CLI tokens
- [x] P0-07 サービスアクション API
- [x] P0-08 サービスライフサイクル CLI
- [x] P0-09 ログ検索 CLI
- [x] P0-10 ログ tail CLI
- [x] P0-11 Schema
- [x] P0-12 SKILL + docs + CI

### P1

- [x] P1-01 インシデント CLI
- [x] P1-02 承認 CLI + 二重決定・自己承認の土台
- [x] P1-03 ホスト CLI
- [x] P1-04 ポート閲覧/予約
- [x] P1-05 ポート kill
- [x] P1-06 レポート CLI
- [x] P1-07 監査 CLI
- [x] P1-08 設定 CLI
- [x] P1-09 読み取りマスク
- [x] P1-10 保存時暗号化
- [x] P1-11 デプロイ承認
- [x] P1-12 docs/tests/CI

### P2

- [ ] P2-01 MCP 読み取り
- [ ] P2-02 MCP 書き込み
- [ ] P2-03 npm 配布
- [ ] P2-04 クロスプラットフォーム CI
- [ ] P2-05 ライブ E2E
- [ ] P2-06 doctor/completions
- [ ] P2-07 性能・運用ドキュメント
