# sys4sys

バックエンド運用管理システム。ポート管理・ログ管理・AI 監視による自動復旧／自動レポートを行います。

計画書は [PLAN.md](./PLAN.md)、データモデルは [docs/ER.md](./docs/ER.md)、API 定義は [docs/openapi.yaml](./docs/openapi.yaml) を参照。

## 前提（確定要件）

| 項目       | 決定                                    |
| ---------- | --------------------------------------- |
| 対象環境   | Windows ローカル + WSL                  |
| 監視対象   | 自作 API / ワーカー                     |
| スタック   | TypeScript（pnpm モノレポ）             |
| AI         | ローカル LLM / OpenAI 互換 API / BYOK   |
| 自動再起動 | 段階的自動（observe → approve → auto）  |
| 通知       | メール（SMTP）                          |
| 承認       | UI のみ                                 |
| 利用者     | チーム共有（admin / operator / viewer） |
| ログ保持   | 既定 14 日                              |

## クイックスタート

```powershell
pnpm install
Copy-Item .env.example .env
# .env の ADMIN_PASSWORD を 12 文字以上で設定（推奨）
pnpm dev
```

- API: http://127.0.0.1:8787/api/health
- Web: http://127.0.0.1:3000
- ポートスキャン単体: `pnpm scan` / `pnpm scan --json`

> 起動時に未適用のマイグレーションを自動適用します。`pnpm db:generate` は `apps/api/src/db/schema.ts` を変更したときだけ実行してください。

## 認証

- メール + パスワード（Argon2id、`hash-wasm`）
- セッション Cookie: `sys4sys_session`（HttpOnly / SameSite=Lax / 既定 168 時間）
- 初回起動時に `users` が空なら管理者を 1 人作成
  - `ADMIN_EMAIL` / `ADMIN_PASSWORD` を `.env` に設定（本番では `ADMIN_PASSWORD` 必須）
  - 開発時に `ADMIN_PASSWORD` が空ならランダム生成し、起動ログに一度だけ表示
- ログイン試行制限: `LOGIN_MAX_ATTEMPTS` 回 / `LOGIN_WINDOW_MINUTES` 分（既定 5 回 / 15 分）
- パスワード変更時は現在のセッション以外を無効化
- 変更系リクエストは `Origin` / `Sec-Fetch-Site` を検証（`ALLOWED_ORIGINS`、既定は localhost:3000 / 8787）
- ユーザー管理は admin のみ。最後の有効な admin は降格・無効化できない
- パスワード再設定時は対象ユーザーの全セッションを無効化

認証方式の詳細は [docs/adr/0001-auth.md](./docs/adr/0001-auth.md) を参照。

## ポート管理（M1）

- Windows / WSL を 10 秒ごとにスキャンして 1 つの一覧に表示（WSL は distro 間でネットワーク共有）
- **ポート予約**: `protocol + port` 単位。Windows / WSL をまたいで一意
- **競合検出**: 予約済みエンドポイントに実リスナーが現れたら `conflict` として強調
- **履歴**: 観測された opened / closed を `port_history` に保存。停止操作の実行者も記録
- **プロセス詳細**: PID / PPID / 開始時刻 / 実行パス / コマンドライン / WSL distro
- **停止**: operator 以上。短寿命 HMAC 確認トークン + 監査ログ。PID 4 以下と API 自身は拒否
- **ホスト管理**: Windows は起動時に自動登録、WSL は検出 → 明示登録 → 有効化
- **ユーザー管理**: admin / operator / viewer、有効化・無効化、ロール変更、パスワード再設定

## 構成

```
sys4sys/
├─ apps/
│  ├─ api/        Fastify + Drizzle + SQLite
│  ├─ web/        Next.js ダッシュボード
│  └─ agent/      Windows / WSL ポートスキャン
├─ packages/
│  ├─ shared/     Zod スキーマ・型
│  ├─ policy/     自動再起動の決定論的評価
│  ├─ ai/         OpenAI 互換クライアント・プロンプト・レポート
│  └─ mail/       SMTP 送信
├─ docs/
│  ├─ ER.md
│  ├─ openapi.yaml
│  └─ spike/portscan-findings.md
├─ spike/         検証用スクリプト（M1 スパイク）
└─ PLAN.md
```

## 実装状況

- [x] M0: 要件確定
- [x] M0: ER 図・OpenAPI 定義
- [x] M1 スパイク: Windows + WSL ポートスキャン（[結果](./docs/spike/portscan-findings.md)）
- [x] モノレポ初期化（pnpm workspace / Fastify / Next.js / Drizzle）
- [x] M1: 認証・ロール・セッション
- [x] M1: ポート一覧・予約・競合検出・履歴・プロセス詳細・停止
- [x] M1: ホスト管理・ユーザー管理・CSRF・M1 スモーク
- [ ] M2: サービス管理・ログ収集

## 認証の設計

[ADR 0001](./docs/adr/0001-auth.md) を参照。better-auth ではなく、既存の `users` / `sessions` スキーマに直結する自前実装を採用しています。

## スパイクで判明した重要事項

- WSL 3.x は **distro 間でネットワーク名前空間を共有**する。ポートは `windows` / `wsl` の 2 スコープで扱い、PID の帰属先を `pidScope` に持つ。
- 停止中の distro を `wsl.exe -d` で叩くと起動してしまう。スキャンは `Running` のみ対象。
- WSL のポートは Windows 側に `wslrelay.exe` として現れる。同一ポートが WSL 側にあればフォワーディングと判定。
- `wsl.exe` の出力は UTF-16LE + BOM。BOM / NUL 密度でデコードする。

## スクリプト

| コマンド                           | 内容                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                         | API + Web を同時起動                                            |
| `pnpm dev:api`                     | API のみ                                                        |
| `pnpm dev:web`                     | Web のみ                                                        |
| `pnpm scan`                        | ポートスキャン（CLI）                                           |
| `pnpm typecheck`                   | 全パッケージの型チェック                                        |
| `pnpm test`                        | テスト（policy / auth / 予約 / kill トークン）                  |
| `pnpm db:generate`                 | Drizzle マイグレーション生成                                    |
| `pnpm db:migrate`                  | マイグレーション適用                                            |
| `pnpm --filter @sys4sys/api smoke` | M1 統合スモーク（認証・予約・競合・kill・ロール・ホスト・CSRF） |

### スモークテスト

スモークは実際に一時ポートでリスナーを起動し、予約 → 競合検出 → 確認トークン → kill → 履歴まで検証します。開発 DB を汚さないよう、一時 DB を指定して実行してください。

```powershell
Remove-Item -Force apps/api/data/smoke-m1.db* -ErrorAction SilentlyContinue
$env:DATABASE_URL='./data/smoke-m1.db'
$env:ADMIN_PASSWORD='SmokeTest-Password-123!'
$env:LOG_LEVEL='warn'
pnpm --filter @sys4sys/api smoke
```

`ADMIN_PASSWORD` を設定しない場合、認証以降のチェックはスキップされます。
