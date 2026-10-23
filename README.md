# sys4sys

[![CI](https://github.com/minato1198/sys4sys/actions/workflows/ci.yml/badge.svg)](https://github.com/minato1198/sys4sys/actions/workflows/ci.yml)

Windows / WSL 上のバックエンドサービスを、ポート・プロセス・ログ・インシデント・承認・AI レポートの観点から一元管理するセルフホスト型の運用管理システムです。

> 本プロジェクトは開発中です。インターネットへ公開する場合は、HTTPS、認証、シークレット管理、SMTP 設定を必ず確認してください。

## 主な機能

- **ポート管理**: Windows / WSL のリスナー一覧、予約、競合検出、履歴、プロセス詳細、安全な停止
- **サービス管理**: サービスの登録・起動・停止・再起動、ヘルスチェック、ログ収集、SSE tail
- **監視と復旧**: プロセス終了・ヘルス・ハートビート・エラーログ・正規表現ルール、インシデント、承認キュー、段階的自動再起動
- **AI 分析・レポート**: OpenAI 互換 API / ローカル LLM / BYOK、マスキング、フォールバック、Markdown / JSON レポート
- **ガバナンス**: 監査ログ、保持期間、SQLite バックアップ、admin / operator / viewer のロール管理
- **デプロイ**: サービス単位のデプロイコマンド、ログ、再起動とヘルス確認
- **通知**: SMTP メール通知（非ローカル SMTP は STARTTLS または SMTPS を使用）

> このツールはプロセスの停止・再起動・デプロイを実行できます。実行権限と対象サービスを限定して運用してください。

## 技術スタック

| 領域        | 採用技術                             |
| ----------- | ------------------------------------ |
| 言語 / 構成 | TypeScript / pnpm workspace          |
| API         | Fastify / Drizzle ORM / SQLite       |
| Web         | Next.js 15 / React 19 / Tailwind CSS |
| 認証        | Argon2id / セッション Cookie         |
| AI          | OpenAI 互換 API                      |
| メール      | Nodemailer / SMTP                    |

## 必要環境

- Node.js 22 以上
- pnpm 12.14.0
- Windows 10 / 11 + WSL 2（全機能を利用する場合）

Linux / macOS では、一部の Windows / WSL 固有機能は利用できません。

## クイックスタート

```powershell
git clone https://github.com/minato1198/sys4sys.git
cd sys4sys
pnpm install
Copy-Item .env.example .env
# .env を編集
pnpm dev
```

bash の場合:

```bash
cp .env.example .env
pnpm dev
```

- Web: http://127.0.0.1:3000
- API health: http://127.0.0.1:8787/api/health

起動時に未適用のマイグレーションを自動適用します。初回起動時に `users` が空の場合、管理者ユーザーを作成します。本番では `ADMIN_PASSWORD` の設定が必須です。開発環境で未設定の場合はランダムなパスワードが生成されるため、`ADMIN_PASSWORD` を設定してください。

`SESSION_SECRET` は 32 文字以上のランダム値に変更してください。HTTPS で運用する場合は `COOKIE_SECURE=true` を設定します。

## 設定

設定項目の一覧は [`.env.example`](./.env.example) を参照してください。主な設定は以下です。

- `DATABASE_URL`: SQLite データベースのパス
- `SESSION_SECRET`: セッションと保存時暗号化の鍵
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`: 初期管理者（パスワードは 12 文字以上）
- `ALLOWED_ORIGINS`: CSRF / Origin 検証で許可するオリジン
- `SMTP_*` / `MAIL_RECIPIENTS`: メール通知
- `AI_*`: OpenAI 互換 API の接続設定
- `SERVICE_COMMAND_ALLOWLIST`: サービスとして起動を許可する実行ファイル
- `LOG_RETENTION_DAYS`: ログ保持期間の初期値

SMTP、AI、保持期間、バックアップは Web の `/settings` からも設定できます。秘密値は `SESSION_SECRET` から導出した鍵で暗号化して保存されます。

## 画面

- `/`: ダッシュボード
- `/ports`: ポート一覧・予約・競合
- `/services`: サービス管理・デプロイ
- `/logs`: ログ検索・tail
- `/incidents`: インシデント
- `/approvals`: 承認キュー
- `/reports`: AI レポート
- `/audit`: 監査ログ
- `/settings`: SMTP / AI / 保持期間 / バックアップ
- `/hosts`: ホスト管理
- `/admin/users`: ユーザー管理

ロールは `admin`、`operator`、`viewer` の 3 種類です。設定変更とユーザー管理は `admin`、運用操作と承認は `operator` 以上が実行できます。

## 開発

```bash
pnpm typecheck
pnpm test
pnpm --filter @sys4sys/web build
pnpm audit --prod
```

主なスクリプト:

| コマンド                           | 内容                         |
| ---------------------------------- | ---------------------------- |
| `pnpm dev`                         | API と Web を同時起動        |
| `pnpm dev:api`                     | API のみ起動                 |
| `pnpm dev:web`                     | Web のみ起動                 |
| `pnpm scan`                        | ポートスキャン CLI           |
| `pnpm db:generate`                 | Drizzle マイグレーション生成 |
| `pnpm db:migrate`                  | マイグレーション適用         |
| `pnpm db:backup`                   | SQLite バックアップ          |
| `pnpm --filter @sys4sys/api smoke` | 統合スモークテスト           |

スモークテストは一時ポートと一時 DB を使用します。WSL やローカル LLM が利用できない環境では、該当するチェックがスキップされます。

## セキュリティ

- `.env`、データベース、バックアップ、鍵、ログをコミットしないでください。
- 本番では `ADMIN_PASSWORD` を必ず設定し、初回ログイン後に変更してください。
- HTTPS で公開し、`COOKIE_SECURE=true` と適切な `ALLOWED_ORIGINS` を設定してください。
- 非ローカルの SMTP は STARTTLS または SMTPS を使用してください。
- AI の外部ログ送信は既定で無効です。有効化する場合は送信先とマスキングを確認してください。
- 脆弱性を報告する場合は [SECURITY.md](./SECURITY.md) を参照してください。

## 構成

```text
apps/
  api/        Fastify API / SQLite / 監視 / AI / デプロイ
  web/        Next.js ダッシュボード
  agent/      Windows / WSL ポートスキャン・プロセス操作
  demo-api/   サービス管理を試すためのデモ API
packages/
  shared/     Zod スキーマ・共有型
  policy/     自動再起動ポリシー
  ai/         AI クライアント・プロンプト・レポート
  mail/       SMTP 送信
docs/
  ER.md
  openapi.yaml
  adr/
```

## 既知の制限

- Windows / WSL 中心の設計です。Linux / macOS は未検証の機能があります。
- SQLite 単一ノード構成です。高可用性は提供しません。
- AI レポートのメール送信・再送は未実装です。
- 自動再起動は安全装置付きですが、本番導入前に必ず検証環境で確認してください。

## ドキュメント

- [データモデル](./docs/ER.md)
- [OpenAPI](./docs/openapi.yaml)
- [認証 ADR](./docs/adr/0001-auth.md)
- [デモ API](./apps/demo-api/README.md)
- [セキュリティポリシー](./SECURITY.md)

## コントリビュート

Issue / Pull Request を歓迎します。変更を送る前に `pnpm typecheck`、`pnpm test`、`pnpm --filter @sys4sys/web build` が成功することを確認してください。

## ライセンス

MIT ライセンスです。詳細は [LICENSE](./LICENSE) を参照してください。
