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
pnpm db:generate
pnpm db:migrate
pnpm dev
```

- API: http://127.0.0.1:8787/api/health
- Web: http://127.0.0.1:3000
- ポートスキャン単体: `pnpm scan` / `pnpm scan --json`

> `pnpm db:generate` は初回のみ、または `apps/api/src/db/schema.ts` を変更したときに実行します。

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
- [ ] M1: 認証・ロール
- [ ] M1: ポート予約・競合検出
- [ ] M2: サービス管理・ログ収集

## スパイクで判明した重要事項

- WSL 3.x は **distro 間でネットワーク名前空間を共有**する。ポートは `windows` / `wsl` の 2 スコープで扱い、PID の帰属先を `pidScope` に持つ。
- 停止中の distro を `wsl.exe -d` で叩くと起動してしまう。スキャンは `Running` のみ対象。
- WSL のポートは Windows 側に `wslrelay.exe` として現れる。同一ポートが WSL 側にあればフォワーディングと判定。
- `wsl.exe` の出力は UTF-16LE + BOM。BOM / NUL 密度でデコードする。

## スクリプト

| コマンド           | 内容                         |
| ------------------ | ---------------------------- |
| `pnpm dev`         | API + Web を同時起動         |
| `pnpm dev:api`     | API のみ                     |
| `pnpm dev:web`     | Web のみ                     |
| `pnpm scan`        | ポートスキャン（CLI）        |
| `pnpm typecheck`   | 全パッケージの型チェック     |
| `pnpm test`        | テスト（policy など）        |
| `pnpm db:generate` | Drizzle マイグレーション生成 |
| `pnpm db:migrate`  | マイグレーション適用         |
