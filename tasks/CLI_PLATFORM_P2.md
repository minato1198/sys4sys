# P2 実装計画 — エージェント配布と品質

- 親計画: `tasks/CLI_PLATFORM_PLAN.md`
- 前提: P0 / P1 完了
- 対象: MCP、npm 配布、クロスプラットフォーム CI、ライブ E2E、doctor/completions、性能・運用ドキュメント
- 完了条件: 親計画の **P2 Gate** を満たす。
- ステータス: 未実装（2026-10-25 時点で未着手）

---

## 0. P2 の範囲

### やること

1. MCP サーバーを CLI 内に実装し、AI クライアントから安全なツールとして使えるようにする。
2. `sys4sys` を npm からインストールできるようにする。
3. Windows / macOS / Linux の CI とインストール検証を追加する。
4. 実 API を起動するライブ E2E を追加する。
5. `doctor` / `version` / シェル補完を追加する。
6. 大量ログ・tail・トークン認証の性能と制限を文書化する。

### やらないこと

- リモート MCP（HTTP/SSE）の一般公開。需要が出たら別計画。
- Web UI の承認画面の全面改修。
- マルチテナント / クラウド配布。
- 自動アップデート機構。

### P2 の安全原則

- MCP は **読み取り先行**。書き込みは明示フラグ + スコープ + 確認引数。
- MCP の stdout はプロトコル専用。ログは stderr。
- MCP にトークン全文・env 実値・生ログの秘密値を渡さない。
- 配布物に `.env`、DB、ログ、`credentials.json`、個人パスを含めない。
- E2E は一時ディレクトリ・一時 DB・ランダムポートだけを使う。

---

## 1. PR 一覧

| ID    | タイトル                                     | 依存         | 目安 |
| ----- | -------------------------------------------- | ------------ | ---- |
| P2-01 | MCP 読み取りサーバー                         | P0-11, P1-09 | 1 PR |
| P2-02 | MCP 書き込みツールとポリシー                 | P2-01, P1-11 | 1 PR |
| P2-03 | npm 配布とリリース                           | P0-12        | 1 PR |
| P2-04 | クロスプラットフォーム CI とインストール検証 | P2-03        | 1 PR |
| P2-05 | ライブ E2E テストハーネス                    | P0, P1       | 1 PR |
| P2-06 | `doctor` / `version` / シェル補完            | P0-01        | 1 PR |
| P2-07 | 性能・制限・運用ドキュメント                 | P1           | 1 PR |

---

## P2-01 MCP 読み取りサーバー

### 目的

AI クライアント（MCP 対応）から、sys4sys のサービス・ログ・インシデントを読み取り専用で参照できるようにする。

### 変更

- 追加: `apps/cli/src/mcp/server.ts`
- 追加: `apps/cli/src/mcp/tools/read.ts`
- 追加: `apps/cli/src/mcp/schema.ts`（P0-11 の Schema を利用）
- 追加: `apps/cli/src/commands/mcp.ts`
- 変更: `apps/cli/src/index.ts`
- 変更: `apps/cli/package.json`（MCP SDK 依存）
- テスト: `apps/cli/src/mcp/server.test.ts`

### 依存

- `@modelcontextprotocol/sdk`（バージョンは実装時に固定）
- 既存の `ApiClient` を再利用する。MCP 専用の HTTP 実装は作らない。

### コマンド

```bash
sys4sys mcp serve [--transport stdio] [--allow-write]
```

- 既定は `stdio`。
- `SYS4SYS_TOKEN` を必須にする。保存済み資格情報・対話ログインは使わない。
- `SYS4SYS_API_URL` / `--api` で API を指定。
- `--allow-write` は P2-02 で有効化。P2-01 では無視するか「未実装」を返す。
- stdout には MCP プロトコルだけを書く。診断ログは stderr。

### ツール（読み取り）

| ツール名                 | 説明                             | 必要スコープ     |
| ------------------------ | -------------------------------- | ---------------- |
| `sys4sys_whoami`         | 認証ユーザー・スコープ確認       | 認証のみ         |
| `sys4sys_list_services`  | サービス一覧                     | `services:read`  |
| `sys4sys_get_service`    | サービス詳細（env はキー名のみ） | `services:read`  |
| `sys4sys_query_logs`     | ログ検索（マスク済み）           | `logs:read`      |
| `sys4sys_list_incidents` | インシデント一覧                 | `incidents:read` |
| `sys4sys_get_incident`   | インシデント詳細                 | `incidents:read` |
| `sys4sys_list_approvals` | 承認一覧                         | `approvals:read` |
| `sys4sys_schema`         | コマンド Schema                  | 認証のみ         |

### 入力スキーマ

- P0-11 の `docs/cli-schema.json` と Zod スキーマから生成する。
- MCP の `inputSchema` は JSON Schema。
- 例:

```json
{
  "name": "sys4sys_query_logs",
  "description": "Search sys4sys logs. Secrets are masked. Prefer serviceId and time range.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "serviceId": { "type": "string" },
      "level": {
        "type": "string",
        "enum": ["debug", "info", "warn", "error", "fatal"]
      },
      "q": { "type": "string" },
      "from": { "type": "string", "format": "date-time" },
      "to": { "type": "string", "format": "date-time" },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 200,
        "default": 50
      }
    }
  }
}
```

### 出力

- `content: [{ type: "text", text: "<JSON>" }]` を基本にする。
- 大きすぎる結果は先頭 N 件 + `nextCursor` を返す。MCP のコンテキストを圧迫しない。
- ログは P1 のマスク済み経路を使う。`raw` オプションは提供しない。
- サービス詳細の `env` はキー名のみ。`deploy.env` も同様。
- エラーは MCP のエラーとして返し、スタックトレースを含めない。

### スコープによるツール公開

- `whoami` で取得したスコープに基づき、利用できないツールは `tools/list` に出さない。
- 実行時に 403 が返った場合もエラーを返す（ツール一覧の漏れ対策）。
- 読み取り専用トークンでは書き込みツールが一切見えない。

### テスト

- MCP クライアント SDK で `tools/list` を取得し、読み取りツールが含まれる。
- `sys4sys_query_logs` が API のクエリを正しく組み立てる。
- スコープ不足のツールが一覧に出ない。
- 401/403 が MCP エラーになる。
- stdout に診断ログが混ざらない。
- サービス詳細に env 実値が出ない。

### 検証

```bash
pnpm --filter @sys4sys/cli test
SYS4SYS_TOKEN=<token> pnpm sys4sys -- mcp serve
```

クライアント側の手動確認:

```json
{ "method": "tools/list" }
```

### 完了条件

- [ ] MCP 読み取りツールが動く。
- [ ] スコープに応じてツールが絞られる。
- [ ] env / ログの秘密値が漏れない。
- [ ] stdout がプロトコル専用になっている。

---

## P2-02 MCP 書き込みツールとポリシー

### 目的

AI クライアントから限定的な操作を実行できるようにする。ただし既定では無効にし、明示設定とスコープを必須にする。

### 変更

- 追加: `apps/cli/src/mcp/tools/write.ts`
- 変更: `apps/cli/src/mcp/server.ts`
- 変更: `apps/cli/src/commands/mcp.ts`
- 変更: `apps/cli/SKILL.md`
- テスト: `apps/cli/src/mcp/write.test.ts`

### 有効化

```bash
sys4sys mcp serve --allow-write
```

- `--allow-write` がない場合、書き込みツールは `tools/list` に出さない。
- トークンに必要なスコープがない場合も出さない。
- 環境変数 `SYS4SYS_MCP_ALLOW_WRITE=true` でも有効化できるが、CLI フラグを優先する。
- 監査と事故防止のため、起動時に stderr へ「書き込みツールが有効」と警告する。

### ツール（書き込み）

| ツール名                         | 説明                 | 必要スコープ       | 追加の確認      |
| -------------------------------- | -------------------- | ------------------ | --------------- |
| `sys4sys_start_service`          | サービス開始         | `services:operate` | `confirm: true` |
| `sys4sys_stop_service`           | サービス停止         | `services:operate` | `confirm: true` |
| `sys4sys_restart_service`        | 再起動               | `services:operate` | `confirm: true` |
| `sys4sys_deploy_service`         | deploy 実行/要求     | `deploy:execute`   | `confirm: true` |
| `sys4sys_ack_incident`           | インシデント ack     | `incidents:write`  | 不要            |
| `sys4sys_resolve_incident`       | インシデント resolve | `incidents:write`  | `confirm: true` |
| `sys4sys_approve_deploy_request` | デプロイ承認         | `approvals:decide` | `confirm: true` |
| `sys4sys_reject_deploy_request`  | デプロイ却下         | `approvals:decide` | `confirm: true` |

### 確認引数

MCP には対話プロンプトがないため、破壊的ツールは入力に `confirm: true` を要求する。

```json
{
  "serviceId": "svc_...",
  "confirm": true
}
```

- `confirm` がない / false なら、実行せず「確認が必要です」というエラーを返す。
- これは人間の確認の代替ではない。MCP クライアント側の承認 UI と併用する前提を docs に書く。

### デプロイ承認との連携

- `sys4sys_deploy_service`:
  - `requireApproval=false`: `confirm: true` で即時実行。
  - `requireApproval=true`: 承認要求を作成し、`deployRequestId` を返す。**自動承認しない**。
- `sys4sys_approve_deploy_request` は別ツール。自己承認は API が拒否する。
- MCP の 1 セッションで要求と承認を完結させないよう、SKILL に「承認は別ユーザー/別セッションで行う」と書く。

### 出力

- API の action / approval レスポンスを JSON で返す。
- `--wait` は既定 false。MCP のタイムアウトを避けるため、必要なら `sys4sys_get_service` で状態確認する。
- 失敗時は action の `error` を含める。スタックトレースは出さない。

### テスト

- `--allow-write` なしで書き込みツールが出ない。
- スコープ不足で出ない。
- `confirm` なしで実行されない。
- 自己承認が 403。
- deploy 承認要求が作られ、自動実行されない。
- 監査が API 側に残る。
- MCP 経由の stop/restart が action を返す。

### 検証

```bash
pnpm --filter @sys4sys/cli test
SYS4SYS_TOKEN=<operator-token> pnpm sys4sys -- mcp serve --allow-write
```

### 完了条件

- [ ] 書き込みツールが既定で無効。
- [ ] スコープ + `confirm` + `--allow-write` の三条件が揃わないと実行されない。
- [ ] deploy 承認が自動化されない。
- [ ] SKILL に MCP の安全な使い方が書かれている。

---

## P2-03 npm 配布とリリース

### 目的

`sys4sys` を npm からインストールし、`sys4sys` コマンドとして実行できるようにする。

### 変更

- 変更: `apps/cli/package.json`
- 追加: `apps/cli/tsup.config.ts`（または `tsc` ビルド設定）
- 追加: `apps/cli/src/bin.ts`（シバン付きエントリ）
- 追加: `.github/workflows/release.yml`
- 変更: `package.json`（`build:cli`, `pack:cli`）
- 追加: `apps/cli/LICENSE`（ルートの MIT をコピー）
- 変更: `README.md`（インストール手順）

### パッケージ名

- 第一候補: `sys4sys`（npm で利用可能か確認）
- 利用不可なら `@sys4sys/cli`
- 決定は P2-03 の最初に済ませ、README / release workflow に反映する。

### package.json の目標

```json
{
  "name": "sys4sys",
  "version": "0.2.0",
  "private": false,
  "type": "module",
  "bin": { "sys4sys": "./dist/bin.js" },
  "main": "./dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./schema": "./dist/schema.js"
  },
  "files": ["dist", "SKILL.md", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsup",
    "prepack": "pnpm build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^<pinned>",
    "zod": "^4.1.12"
  }
}
```

- `@sys4sys/shared` はワークスペース専用のため、ビルド時にバンドルする。
- `@modelcontextprotocol/sdk` は MCP の実行時依存として残す（バンドルする場合は `files` とライセンスを確認する）。
- `tsx` は devDependency のみ。配布物に含めない。
- `bin.js` の先頭に `#!/usr/bin/env node` を付ける。
- `files` を allowlist にし、`.env`、DB、ログ、テスト、`credentials.json` を含めない。
- `npm pack --dry-run` で内容を確認する。

### ビルド

- `tsup` で `src/bin.ts` を ESM にバンドル。
- `@sys4sys/shared` をバンドルし、`zod` は external（dependency として配布）。
- Node 22 を target にする。
- sourcemap は配布しない（サイズ削減）。必要なら `--sourcemap` を別途。

### リリース

`.github/workflows/release.yml`:

- トリガー: `v*` タグ。
- 権限: `contents: write`, `id-token: write`（provenance）。
- 手順:
  1. checkout
  2. pnpm / Node 22
  3. `pnpm install --frozen-lockfile`
  4. `pnpm typecheck && pnpm test`
  5. `pnpm --filter @sys4sys/cli build`
  6. `npm pack` で内容確認
  7. `npm publish --provenance --access public`
  8. GitHub Release 作成
- `NPM_TOKEN` は GitHub Secrets。リポジトリにコミットしない。
- バージョンは `package.json` を手動で更新、または Changesets を導入する。P2-03 では手動 + タグで開始し、Changesets は任意。

### インストール検証

```bash
pnpm --filter @sys4sys/cli build
npm pack ./apps/cli
npm install --global ./sys4sys-*.tgz
sys4sys --version
sys4sys --help
sys4sys schema --json > /dev/null
```

- グローバルインストール後に API なしで動くコマンド（`--help`, `--version`, `schema`）を確認する。
- `auth login` など API が必要なものは P2-05 の E2E で確認する。

### テスト

- `npm pack --dry-run` のファイル一覧に禁止ファイルがない。
- `dist/bin.js` にシバンがある。
- `node dist/bin.js --help` が動く。
- `npm install` 後の `sys4sys` が動く。
- `package.json` の `files` が期待どおり。

### 検証

```bash
pnpm --filter @sys4sys/cli build
npm pack --dry-run ./apps/cli
node apps/cli/dist/bin.js --help
```

### 完了条件

- [ ] npm パッケージとしてビルド・pack できる。
- [ ] `bin` が動く。
- [ ] 配布物に禁止ファイルがない。
- [ ] リリース workflow がタグで動く（dry-run 可）。

---

## P2-04 クロスプラットフォーム CI とインストール検証

### 目的

Windows / macOS / Linux で CLI がインストール・実行できることを継続的に検証する。

### 変更

- 変更: `.github/workflows/ci.yml`
- 追加: `.github/workflows/cli-matrix.yml`（重い場合）
- 追加: `scripts/verify-cli-package.mjs`

### CI マトリクス

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
    node: [22]
```

手順:

1. checkout
2. pnpm / Node
3. `pnpm install --frozen-lockfile`
4. `pnpm typecheck`
5. `pnpm test`
6. `pnpm --filter @sys4sys/cli build`
7. `npm pack ./apps/cli`
8. 一時ディレクトリに `npm install --prefix <tmp> ./sys4sys-*.tgz`
9. `<tmp>/node_modules/.bin/sys4sys --version`（Windows は `.bin/sys4sys.cmd`。クロスプラットフォームには `npx --prefix <tmp> sys4sys --version` または `node <tmp>/node_modules/sys4sys/dist/bin.js` を使う）
10. `--help`
11. `schema --json` をファイルに書き、JSON としてパース
12. パッケージ内容の禁止ファイルチェック

### コスト制御

- すべての PR で 3 OS を回すと高いため:
  - `verify`（Linux）は必須。
  - `cli-matrix` は `main` への push と `release` タグ、または `paths` フィルタ（`apps/cli/**`, `packages/shared/**`）で実行。
  - PR では Linux のみ、週次で全 OS。
- 実行時間を測り、必要ならキャッシュを追加。

### Windows 固有

- パスにスペースを含む一時ディレクトリでテストする。
- `npm.cmd` / `pnpm.cmd` の解決。
- `credentials.json` のパーミッション警告がクラッシュしないこと。
- `SIGINT` の扱い（tail のテストはモックで可）。

### macOS 固有

- `~/.config` の代わりに `SYS4SYS_CONFIG_DIR` を必ず使う。
- ケースセンシティブなファイル名（`Credentials.json` との衝突なし）。

### テスト

- 3 OS で `--version` / `--help` / `schema` が成功。
- パッケージに `.env` / DB / ログ / `credentials.json` がない。
- 失敗時にログが分かりやすい。

### 検証

```bash
pnpm --filter @sys4sys/cli build
node scripts/verify-cli-package.mjs
```

### 完了条件

- [ ] 3 OS の CI が安定して通る。
- [ ] インストール済みバイナリで基本コマンドが動く。
- [ ] 配布物の禁止ファイルチェックが自動化されている。

---

## P2-05 ライブ E2E テストハーネス

### 目的

実際の API を起動し、CLI の認証・サービス操作・ログ・承認をエンドツーエンドで検証する。

### 変更

- 追加: `apps/cli/test/e2e/harness.ts`
- 追加: `apps/cli/test/e2e/auth.e2e.test.ts`
- 追加: `apps/cli/test/e2e/services.e2e.test.ts`
- 追加: `apps/cli/test/e2e/logs.e2e.test.ts`
- 追加: `apps/cli/test/e2e/deploy-approval.e2e.test.ts`
- 変更: `apps/cli/package.json`（`test:e2e`）
- 変更: `.github/workflows/ci.yml`（E2E ジョブ）

### ハーネス

- 一時ディレクトリを作成する。
- 環境変数:
  - `DATABASE_URL=<tmp>/e2e.db`
  - `SESSION_SECRET=<random>`
  - `SECRET_ENCRYPTION_KEY=<random>`
  - `ADMIN_EMAIL=admin@example.local`
  - `ADMIN_PASSWORD=<random>`
  - `MONITOR_ENABLED=false`
  - `LOG_LEVEL=warn`
  - `PORT=0` または空きポート
  - `SYS4SYS_CONFIG_DIR=<tmp>/config`
- `buildApp()` を import して `listen({ port: 0, host: "127.0.0.1" })`。
- 実際の URL を CLI に `--api` で渡す。
- テスト終了時に `app.close()`、子プロセス停止、一時ディレクトリ削除。
- 実トークンはテスト内で生成し、ログに出さない。

### シナリオ

1. **認証**
   - `auth login` → `whoami` → `tokens create` → `SYS4SYS_TOKEN` で `whoami`。
   - 失効 → 401 → exit 3。
2. **サービス**
   - テスト用サービスを API で作成。`SERVICE_COMMAND_ALLOWLIST` に含まれるコマンド（例: `node`）と一時スクリプトを使う。
   - `services start --wait` → `running`。
   - `services stop --yes --wait` → `stopped`。
   - `services restart --yes --wait`。
   - `services actions` に履歴。
   - `services delete --yes`。
3. **ログ**
   - テスト用サービスが stdout に 3 行出す。
   - `logs query` で取得。
   - `logs tail` を起動し、1 行追加して受信。Ctrl+C 相当の abort で終了。
4. **デプロイ承認**
   - `requireApproval=true` のサービス。
   - operator が `services deploy --request`。
   - 別 admin が `deploy-requests approve --yes`。
   - action が `succeeded`。
   - 自己承認が 403。
5. **秘密値**
   - `services get` に env 実値がない。
   - `--show-env` が admin で成功し、operator で 403。
   - 監査に `service.secrets.reveal`。

### 安定性

- ポート競合を避けるため `port: 0`。
- プロセスの終了待ちにタイムアウトを設ける。
- Windows のプロセス停止は `stopProcess` を使う。
- 失敗時に一時 DB とログを artifact に残す（secrets は含めない）。
- WSL に依存しない（Windows ホストのみ）。

### CI

- `e2e` ジョブは Linux で実行（Windows は任意）。
- `pnpm --filter @sys4sys/cli test:e2e`。
- 失敗時に `apps/cli/test/e2e/.artifacts/` を upload（トークンはマスク）。

### テスト

- E2E 自体が 3 回連続で安定する。
- 失敗時に原因が分かるログが出る。
- 実 secrets が CI ログに出ない。

### 検証

```bash
pnpm --filter @sys4sys/cli test:e2e
```

### 完了条件

- [ ] 実 API を起動する E2E が通る。
- [ ] 認証・サービス・ログ・承認・秘密値の主要経路が検証される。
- [ ] CI で安定して実行できる。
- [ ] 実 secrets / 個人パスがログに残らない。

---

## P2-06 `doctor` / `version` / シェル補完

### 目的

導入時のトラブルシュートと日常利用の快適さを提供する。

### 変更

- 追加: `apps/cli/src/commands/doctor.ts`
- 追加: `apps/cli/src/commands/completions.ts`
- 変更: `apps/cli/src/index.ts`
- 変更: `apps/cli/src/commands/registry.ts`
- 変更: `apps/cli/package.json`（`version` の注入）
- テスト: `apps/cli/src/commands/doctor.test.ts`, `completions.test.ts`

### `--version`

```bash
sys4sys --version
sys4sys version [--json]
```

- `package.json` の `version` をビルド時に注入する。
- `tsx` 実行時は `package.json` を読む。
- `--json` は `{ name, version, node, platform }`。

### `doctor`

```bash
sys4sys doctor [--json]
```

チェック項目:

- Node のバージョン（>=22）。
- API URL の形式。
- API への到達性（`GET /` または `/api/health`）。
- 認証方式（token / session / password）。
- トークンの期限（残り 7 日以内なら警告）。
- スコープ一覧。
- 資格情報ファイルの場所とパーミッション（Unix）。
- 資格情報の重複（token と session が両方ある）。
- サーバー時刻とのずれ（`Date` ヘッダー）。
- WSL の利用可否（Windows のみ、任意）。
- 設定ディレクトリの書き込み可否。

出力例:

```text
OK   node            v22.14.0
OK   api             http://127.0.0.1:8787 (200)
OK   auth            token s4s_ab12 (operator)
WARN token expires   2026-11-01 (8 days)
WARN config          <config-dir>\sys4sys\credentials.json (Windows ACL best-effort)
```

- `--json` は `{ checks: [{ name, status, detail, hint }] }`。
- 失敗があっても exit 0（診断）。`--strict` で警告を exit 1 にする。
- トークン全文・パスワードは出さない。

### シェル補完

```bash
sys4sys completions bash
sys4sys completions zsh
sys4sys completions fish
sys4sys completions powershell
```

- P0-01 のレジストリから生成する。
- 出力は stdout。インストール手順を README に書く。
- 動的補完（サービス ID など）は P3。P2 ではコマンド/オプションの静的補完のみ。

### テスト

- `--version` が package.json と一致。
- `doctor` の各チェックがモックで期待どおり。
- API 不到達でもクラッシュしない。
- トークン期限切れの警告。
- 補完スクリプトに全コマンドが含まれる。
- 補完スクリプトが構文エラーにならない（bash -n など）。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- doctor --json
pnpm sys4sys -- completions bash | bash -n
```

### 完了条件

- [ ] `doctor` で導入時の問題を切り分けられる。
- [ ] `--version` が配布物と一致する。
- [ ] 主要シェルの補完が生成できる。
- [ ] 秘密値が表示されない。

---

## P2-07 性能・制限・運用ドキュメント

### 目的

大量ログ・長時間 tail・トークン運用での挙動を明確にし、運用者が安全に使えるようにする。

### 変更

- 追加: `docs/cli/PERFORMANCE.md`
- 追加: `docs/cli/OPERATIONS.md`
- 追加: `docs/cli/TOKEN_ROTATION.md`
- 追加: `docs/cli/MCP_SECURITY.md`
- 追加: `scripts/bench-cli.mjs`
- 変更: `apps/cli/README.md`
- 変更: `apps/cli/SKILL.md`

### 性能目標

| 項目                               | 目標                     |
| ---------------------------------- | ------------------------ |
| `services list`（100 サービス）    | 1 秒以内（ローカル API） |
| `logs query`（10 万行、limit 100） | 2 秒以内                 |
| `logs tail` の遅延                 | 1 秒以内                 |
| `tokens create`                    | 500ms 以内               |
| `--help` / `schema`                | 500ms 以内（API 不要）   |
| MCP `tools/list`                   | 200ms 以内               |

- 数値は開発機の目安。CI では測らない。
- 遅い場合は `--limit` / `--since` / サービス絞り込みを推奨。

### 制限

- `logs query` の `limit` は最大 500。
- `logs tail` の再接続は最大 10 回、バックオフ最大 30 秒。
- MCP のログ結果は最大 200 行。
- トークンの最大期限は 365 日。
- deploy 要求の期限は 24 時間（設定可）。
- 同時 deploy はサービスごとに 1 つ。

### 運用ドキュメント

- トークンの発行・配布・失効・ローテーション。
- CI での `SYS4SYS_TOKEN` の扱い（Secret Manager、ログマスク）。
- 漏洩時の対応（失効 → 監査確認 → 再発行）。
- デプロイ承認の運用手順（要求者/承認者、緊急時）。
- MCP の安全な設定（読み取りのみ、`--allow-write` の限定）。
- 障害時の切り分け（`doctor`、API ログ、監査ログ）。

### ベンチマーク

`scripts/bench-cli.mjs`:

- 一時 DB にログを 10 万行投入。
- `logs query --limit 100` を 10 回実行し、中央値を出す。
- 結果を Markdown で出力。
- CI では実行しない（手動）。

### テスト

- ドキュメントのコマンド例が実装と一致する（Schema と照合）。
- `bench-cli.mjs` がローカルで動く。
- 制限値がコードと docs で一致する（定数を共有）。

### 検証

```bash
pnpm --filter @sys4sys/cli test
node scripts/bench-cli.mjs --help
```

### 完了条件

- [ ] 性能目標と制限が文書化されている。
- [ ] トークンローテーションと漏洩対応の手順がある。
- [ ] MCP の安全な設定が文書化されている。
- [ ] ベンチマークを再実行できる。

---

## 2. P2 の実装順

1. `P2-01` MCP 読み取り
2. `P2-02` MCP 書き込み
3. `P2-03` npm 配布
4. `P2-04` クロスプラットフォーム CI
5. `P2-05` ライブ E2E
6. `P2-06` doctor/version/補完
7. `P2-07` 性能・運用ドキュメント

P2-03 と P2-04 は P0/P1 完了後なら P2-01 と並列可。P2-05 は P2-03 の後が望ましい（配布物を E2E で使うため）。P2-06 は P0-01 の後ならいつでも可。

---

## 3. P2 のテストマトリクス

| ケース                                 | 期待                                   |
| -------------------------------------- | -------------------------------------- |
| MCP 読み取りトークン                   | 読み取りツールのみ                     |
| MCP 書き込みトークン + `--allow-write` | 書き込みツールが出る                   |
| MCP `confirm` なし                     | 実行されない                           |
| MCP deploy（承認必要）                 | 要求のみ、自動実行されない             |
| npm pack                               | 禁止ファイルなし                       |
| 3 OS インストール                      | `--version` / `--help` / `schema` 成功 |
| E2E auth                               | login → token → whoami                 |
| E2E services                           | start/stop/restart/delete              |
| E2E logs                               | query/tail                             |
| E2E deploy approval                    | 別ユーザー承認で成功、自己承認 403     |
| doctor                                 | API 不到達でもクラッシュしない         |
| completions                            | 構文エラーなし                         |

---

## 4. P2 のリスクと戻し方

| リスク                   | 戻し方                                                     |
| ------------------------ | ---------------------------------------------------------- |
| MCP の過剰公開           | 読み取り先行、`--allow-write`、スコープ、`confirm`         |
| MCP 経由の自動承認       | deploy と approve を別ツールにし、自己承認を API で拒否    |
| npm 配布に secrets 混入  | `files` allowlist、`npm pack --dry-run`、CI チェック       |
| クロスプラットフォーム差 | 3 OS CI、パス/改行/権限のテスト                            |
| E2E の不安定さ           | 一時 DB、`port: 0`、タイムアウト、リトライなしで原因を見る |
| 性能劣化                 | limit / since / サービス絞り込み、ベンチマーク             |
| トークン運用の形骸化     | 期限、ローテーション、監査、`doctor` の期限警告            |

---

## 5. P2 完了チェックリスト

- [ ] P2-01 MCP 読み取り
- [ ] P2-02 MCP 書き込み
- [ ] P2-03 npm 配布
- [ ] P2-04 クロスプラットフォーム CI
- [ ] P2-05 ライブ E2E
- [ ] P2-06 doctor/version/補完
- [ ] P2-07 性能・運用ドキュメント
- [ ] MCP が読み取り専用で安全に動く
- [ ] npm からインストールした `sys4sys` が 3 OS で動く
- [ ] E2E が CI で安定して通る
- [ ] 配布物に secrets / DB / 個人パスがない
