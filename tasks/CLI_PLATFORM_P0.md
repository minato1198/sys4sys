# P0 実装計画 — AI が使える最小運用ループ

- 親計画: `tasks/CLI_PLATFORM_PLAN.md`
- 対象: API トークン/スコープ、ログイン/プロフィール、サービスライフサイクル、ログ、Schema、SKILL
- 前提: 基準コミット `e7bdede`。既存 CLI / Web UI を壊さない。
- 完了条件: 親計画の **P0 Gate** を満たす。
- ステータス: 実装完了（2026-10-25 時点）。local OpenAI API 到達環境で full API smoke 86/86 確認済み。

---

## 0. P0 の範囲

### やること

1. トークンで認証できる API と CLI を作る。
2. サービスを CLI から開始・停止・再起動・削除できるようにする。
3. ログを検索し、tail できるようにする。
4. コマンド契約を JSON Schema として出力する。
5. AI 向けの `SKILL.md` を用意する。
6. 既存の `services create/update/deploy` と Web UI の互換性を維持する。

### やらないこと

- インシデント、承認、ホスト、ポート、レポート、監査、設定の CLI。
- シークレットの保存時暗号化（P1）。
- デプロイ承認（P1）。
- MCP（P2）。
- npm 配布（P2）。

### P0 の安全原則

- トークンは **ロールの部分集合** のスコープだけを持つ。
- トークンで許可されていないルートは **既定で拒否** する（deny by default）。
- 破壊的操作は非対話で `--yes` 必須。
- `env` / `deploy.env` の値は P0 では CLI 側マスクを維持する。サーバー側マスクは P1-09。
- トークン全文をログ・監査・JSON 出力に含めない。

---

## 1. PR 一覧

| ID    | タイトル                                | 依存  | 目安                              |
| ----- | --------------------------------------- | ----- | --------------------------------- |
| P0-01 | CLI コマンドレジストリとエラーモデル    | -     | 1 PR                              |
| P0-02 | API トークン契約とスコープ定義          | P0-01 | 1 PR                              |
| P0-03 | `api_tokens` テーブルとトークンサービス | P0-02 | 1 PR                              |
| P0-04 | Bearer 認証・スコープ強制・トークン API | P0-03 | 1 PR（大きければ 04A/04B に分割） |
| P0-05 | CLI 資格情報ストアと auth コマンド      | P0-04 | 1 PR                              |
| P0-06 | CLI トークン管理                        | P0-05 | 1 PR                              |
| P0-07 | サービスアクション履歴 API              | P0-04 | 1 PR                              |
| P0-08 | サービスライフサイクル CLI              | P0-07 | 1 PR                              |
| P0-09 | ログ検索 CLI                            | P0-04 | 1 PR                              |
| P0-10 | ログ tail CLI（SSE）                    | P0-09 | 1 PR                              |
| P0-11 | `schema` コマンドと JSON Schema 生成    | P0-01 | 1 PR                              |
| P0-12 | `SKILL.md`、CLI ドキュメント、CI 更新   | P0-11 | 1 PR                              |

---

## P0-01 CLI コマンドレジストリとエラーモデル

### 目的

コマンド定義・ヘルプ・Schema・MCP ツール定義の単一情報源を作る。挙動は変えない。

### 変更

- 追加: `apps/cli/src/commands/registry.ts`
- 追加: `apps/cli/src/commands/metadata.ts`（各コマンドのメタデータ）
- 変更: `apps/cli/src/help.ts`（レジストリから生成）
- 変更: `apps/cli/src/index.ts`（ディスパッチをレジストリ経由に）
- 変更: `apps/cli/src/errors.ts`（`UsageError` に `details?` を追加）
- テスト: `apps/cli/src/commands/registry.test.ts`, `help.test.ts`

### 型のたたき台

```ts
export interface CommandOption {
  name: string;
  type: "string" | "boolean" | "number";
  short?: string;
  description: string;
  required?: boolean;
  default?: string;
}

export interface CommandDefinition {
  name: string; // "services list"
  summary: string;
  description?: string;
  phase: "P0" | "P1" | "P2";
  positionals: Array<{ name: string; required: boolean; description: string }>;
  options: CommandOption[];
  examples: string[];
  mutating: boolean;
  requiresConfirmation: boolean;
  requiredScopes: string[];
  run: (context: CommandContext) => Promise<number>;
}
```

### 制約

- 既存コマンドの名前・引数・出力を変えない。
- `--help` の文言は既存利用者に配慮し、コマンド名と主要オプションを維持する。
- `registry` は副作用を持たない。`run` の解決は `index.ts` で行う。
- 不明コマンドは従来どおり exit 2。

### テスト

- コマンド名の重複がない。
- すべてのコマンドに summary / examples / phase がある。
- `help` に既存コマンドがすべて含まれる。
- 不明コマンド・余分な positional が exit 2。

### 検証

```bash
pnpm --filter @sys4sys/cli typecheck
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- --help
```

### 完了条件

- [x] `help` の内容がレジストリから生成される。
- [x] 既存コマンドのテストが全て通る。
- [x] 追加されたレジストリに P0 以降のコマンドを足せる。

---

## P0-02 API トークン契約とスコープ定義

### 目的

API / CLI / Web が共有するトークンとスコープの契約を `@sys4sys/shared` に固定する。

### 変更

- 追加: `packages/shared/src/tokens.ts`
- 変更: `packages/shared/src/index.ts`（export 追加）
- 追加: `packages/shared/src/tokens.test.ts`
- 必要なら `packages/shared/src/api.ts` に認証コンテキストの型を追加

### 契約

```ts
export const tokenScopeSchema = z.enum([
  "services:read",
  "services:write",
  "services:operate",
  "services:secrets",
  "deploy:execute",
  "logs:read",
  "logs:manage",
  "incidents:read",
  "incidents:write",
  "approvals:read",
  "approvals:decide",
  "hosts:read",
  "hosts:write",
  "ports:read",
  "ports:operate",
  "reports:read",
  "audit:read",
  "settings:read",
  "settings:write",
  "tokens:manage",
]);

export const tokenCreateSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(tokenScopeSchema).min(1),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  userId: z.string().min(1).optional(), // admin のみ
});

export const tokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(tokenScopeSchema),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});

export const tokenCreatedSchema = tokenViewSchema.extend({
  token: z.string(), // 作成時のみ返す
});
```

### スコープ判定

- `ROLE_SCOPES: Record<Role, TokenScope[]>` を定義する。
- `scopesForRole(role)` はコピーを返す。
- `isScopeSubset(requested, role)` を定義する。
- `isScopeSubsetOf(requested, allowed)` を定義する（発行元トークンからの昇格防止に使う）。
- `intersectScopes(a, b)` を定義する。
- `hasScope(granted, required)` / `hasAnyScope` / `hasAllScopes` を定義する。
- `scopeSatisfies(granted, required)` は将来のワイルドカード用に 1 箇所へ集約する（P0 では完全一致）。

### テスト

- 各ロールのスコープ集合が期待どおり。
- ロール上限を超える要求が拒否される。
- 空スコープが拒否される。
- 期限の境界（1 日 / 365 日 / 0 日 / 366 日）。
- 未知のスコープが Zod で拒否される。

### 検証

```bash
pnpm --filter @sys4sys/shared typecheck
pnpm --filter @sys4sys/shared test
```

### 完了条件

- [x] API / CLI の両方から同じスコープ定数を import できる。
- [x] スコープの追加・変更が 1 ファイルで完結する。
- [x] ロール上限の判定がユニットテストで固定されている。

---

## P0-03 `api_tokens` テーブルとトークンサービス

### 目的

トークンの発行・照合・一覧・失効・期限切れ処理を API の内部サービスとして実装する。

### 変更

- 変更: `apps/api/src/db/schema.ts`
- 追加: `apps/api/src/auth/tokens.ts`
- 追加: `apps/api/src/auth/tokens.test.ts`
- 追加: `apps/api/drizzle/*`（`pnpm db:generate` の生成物）
- 必要なら `apps/api/src/config.ts` に `TOKEN_DEFAULT_TTL_DAYS` / `TOKEN_MAX_TTL_DAYS` を追加

### テーブル

```ts
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    index("api_tokens_user_id_idx").on(table.userId),
    index("api_tokens_expires_at_idx").on(table.expiresAt),
  ],
);
```

### サービス API

```ts
export interface CreateTokenInput {
  userId: string;
  name: string;
  scopes: TokenScope[];
  expiresInDays: number;
}

export interface CreatedToken {
  view: TokenView;
  token: string; // 1 回だけ返す
}

export async function createApiToken(
  input: CreateTokenInput,
): Promise<CreatedToken>;
export async function verifyApiToken(
  raw: string,
): Promise<VerifiedToken | null>;
export async function listApiTokens(userId: string): Promise<TokenView[]>;
export async function revokeApiToken(id: string, userId: string): Promise<void>;
export async function cleanupExpiredTokens(): Promise<number>;
```

`VerifiedToken` は `{ tokenId, userId, user: AuthUser, scopes, expiresAt }`。

### 実装ルール

- トークン生成: `randomBytes(32).toString("base64url")` に `s4s_` を付ける。
- 保存: SHA-256 の hex。全文は返却時以外保持しない。
- prefix: 先頭 8 文字（`s4s_` を含む）。一覧表示用。
- `verifyApiToken`:
  1. 形式チェック（`s4s_` + 長さ）。
  2. ハッシュで 1 件検索。
  3. `revokedAt IS NULL`、`expiresAt > now`、ユーザーが `isActive` を確認。
  4. `lastUsedAt` を更新（1 分に 1 回まで）。
  5. ロールを DB から取得し、`scopes` がロール上限の部分集合であることを再確認。超えていたら無効。
- 失効は物理削除ではなく `revokedAt`。
- 期限切れの物理削除は日次クリーンアップでよい。監査上は失効レコードを残す。
- `listApiTokens` は `token` / `tokenHash` を返さない。
- 監査はルート層で行う。サービス層は DB 操作に集中する。

### テスト

- 発行したトークンで `verifyApiToken` が成功する。
- 返却されたトークン全文が DB に存在しない。
- 失効後は `null`。
- 期限切れは `null`。
- ユーザー無効化後は `null`。
- ロール変更でスコープ超過になったトークンは `null`。
- `listApiTokens` にハッシュ・全文が含まれない。
- 同じトークン文字列が衝突しない（生成 100 件）。

### 検証

```bash
pnpm --filter @sys4sys/api db:generate
pnpm --filter @sys4sys/api typecheck
pnpm --filter @sys4sys/api test
```

### 完了条件

- [x] マイグレーションが生成され、既存 DB に適用できる。
- [x] トークン全文が DB に保存されない。
- [x] 失効・期限・ユーザー無効化・ロール変更が即時反映される。

---

## P0-04 Bearer 認証・スコープ強制・トークン API

### 目的

`Authorization: Bearer` を既存のセッション認証と共存させ、トークン管理 API を追加する。**トークンで許可されていないルートは既定で拒否**する。

### 変更

- 変更: `apps/api/src/auth/types.ts`
- 変更: `apps/api/src/auth/guard.ts`
- 変更: `apps/api/src/auth/session.ts`（セッションに全ロールスコープを付与）
- 追加: `apps/api/src/routes/tokens.ts`
- 変更: `apps/api/src/app.ts`（ルート登録）
- 変更: `apps/api/src/routes/auth.ts`（`/auth/me` に認証方式とスコープを追加）
- 変更: 既存ルートのスコープメタデータ（下記マトリクス）
- テスト: `apps/api/src/auth/guard.test.ts`, `apps/api/src/routes/tokens.test.ts`

### 認証フロー

1. `Authorization: Bearer <token>` があればトークン認証を試す。
2. トークンが無効なら **Cookie にフォールバックしない**。401 を返す。
3. Bearer がなければ従来のセッション Cookie 認証。
4. どちらもなければ 401。
5. 401 には `WWW-Authenticate: Bearer realm="sys4sys"` を付ける。

### リクエスト拡張

```ts
interface FastifyRequest {
  authUser?: AuthUser;
  authSessionId?: string;
  authToken?: {
    id: string;
    name: string;
    prefix: string;
    scopes: TokenScope[];
    expiresAt: string;
  };
  authMethod?: "session" | "token";
  authScopes?: TokenScope[];
}
```

### ガード

```ts
export async function requireAuth(request, reply): Promise<void>;
export function requireRole(...roles: Role[]): preHandler;
export function requireScope(...scopes: TokenScope[]): preHandler;
export function requireAccess(input: {
  roles?: Role[];
  scopes: TokenScope[];
}): preHandler;
```

- `requireAuth` は認証だけを行う。
- `requireScope` は `authScopes` に required がすべて含まれるか確認する。不足時は 403。
- `requireAccess` はロールとスコープの両方を確認する。既存の `requireRole` は互換のため残すが、P0 の変更ルートでは `requireAccess` を使う。
- 403 の Problem Details に `requiredScope` を含める。

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "この操作には services:operate スコープが必要です",
  "requiredScope": "services:operate"
}
```

### 既定拒否

Bearer 認証の場合、ルートにスコープ設定がないと **403** にする。

- Fastify の `routeOptions.config` に `scopes` を置く。
- 認証だけで許可するルートは `config: { authOnly: true }` を明示する（例: `/api/auth/me`、自分のトークン一覧）。
- もしくは `requireAccess` を必ず preHandler に置く。
- P0-04 では P0 対象ルートと既存の読み取りルートに設定する。P1 で残りを埋める。
- 設定漏れを検出するテストを追加する（登録済みルートを走査し、`authOnly` でも `scopes` でもないルートは Bearer で 403 になることを確認）。

### スコープマトリクス（P0 で必ず設定）

| ルート                        | メソッド          | 必要スコープ                                                            |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `/api/auth/me`                | GET               | なし（認証のみ）                                                        |
| `/api/tokens`                 | GET               | セッション: 自分 / トークン: 自分 / 他ユーザー: `tokens:manage`         |
| `/api/tokens`                 | POST              | セッション: 自分 / トークン: `tokens:manage` かつ発行元スコープ以下     |
| `/api/tokens/:id`             | DELETE            | セッション: 自分 / トークン: 自分自身のみ / 他ユーザー: `tokens:manage` |
| `/api/services`               | GET               | `services:read`                                                         |
| `/api/services/:id`           | GET               | `services:read`                                                         |
| `/api/services`               | POST              | `services:write`                                                        |
| `/api/services/:id`           | PATCH/DELETE      | `services:write`                                                        |
| `/api/services/:id/start`     | POST              | `services:operate`                                                      |
| `/api/services/:id/stop`      | POST              | `services:operate`                                                      |
| `/api/services/:id/restart`   | POST              | `services:operate`                                                      |
| `/api/services/:id/deploy`    | POST              | `deploy:execute`                                                        |
| `/api/services/:id/health`    | GET               | `services:read`                                                         |
| `/api/services/:id/secrets`   | GET               | `services:secrets`（P1-09）                                             |
| `/api/services/:id/actions`   | GET               | `services:read`（P0-07）                                                |
| `/api/logs`                   | GET               | `logs:read`                                                             |
| `/api/logs/stream`            | GET               | `logs:read`                                                             |
| `/api/logs/sources`           | GET               | `logs:read`                                                             |
| `/api/logs/sources`           | POST/PATCH/DELETE | `logs:manage`                                                           |
| `/api/hosts`                  | GET               | `hosts:read`                                                            |
| `/api/incidents`              | GET               | `incidents:read`                                                        |
| `/api/incidents/:id`          | GET               | `incidents:read`                                                        |
| `/api/approvals`              | GET               | `approvals:read`                                                        |
| `/api/reports`                | GET               | `reports:read`                                                          |
| `/api/audit-logs`             | GET               | `audit:read`                                                            |
| `/api/settings/*`             | GET               | `settings:read`                                                         |
| `/api/settings/*`             | PUT/POST          | `settings:write`                                                        |
| `/api/ports`                  | GET               | `ports:read`                                                            |
| `/api/ports/history`          | GET               | `ports:read`                                                            |
| `/api/ports/reserve`          | POST              | `ports:operate`                                                         |
| `/api/ports/reserve/:id`      | DELETE            | `ports:operate`                                                         |
| `/api/ports/:port/kill-token` | GET               | `ports:operate`                                                         |
| `/api/ports/:port/kill`       | POST              | `ports:operate`                                                         |

P1 で追加する書き込みルート（incidents ack/resolve/analyze、approvals approve/reject、hosts write、deploy-requests）も同じ方式で設定する。

### トークン API

| メソッド | パス                      | 説明               | 権限                                                                        |
| -------- | ------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `GET`    | `/api/tokens`             | 自分のトークン一覧 | 認証済み（セッション/トークン）                                             |
| `GET`    | `/api/tokens?userId=<id>` | 指定ユーザーの一覧 | `tokens:manage`                                                             |
| `POST`   | `/api/tokens`             | トークン作成       | セッション: 自分のみ / トークン: `tokens:manage`                            |
| `DELETE` | `/api/tokens/:id`         | 失効               | セッション: 自分のみ / トークン: 自分自身のみ / 他ユーザー: `tokens:manage` |

**昇格防止:**

- トークン認証で `POST /api/tokens` を呼ぶには `tokens:manage` が必要。読み取り専用トークンは新規トークンを作れない。
- `tokens:manage` を持つトークンでも、新しいトークンの `scopes` は **発行元トークンのスコープとの積集合** でなければならない（422）。
- セッション認証の場合は、新しいトークンの `scopes` は対象ユーザーのロール上限以下（422）。
- `DELETE /api/tokens/:id` は、トークン認証では `id` が自分自身のトークン ID と一致する場合だけ許可する。他者のトークンは `tokens:manage` が必要。

作成時のレスポンスだけ `token` を含める。二度目以降は返さない。

```json
{
  "id": "tok_...",
  "name": "ci-deploy",
  "prefix": "s4s_ab12",
  "scopes": ["services:read", "services:operate"],
  "createdAt": "2026-10-24T00:00:00.000Z",
  "expiresAt": "2027-01-22T00:00:00.000Z",
  "lastUsedAt": null,
  "revokedAt": null,
  "token": "s4s_<redacted>"
}
```

### `/auth/me` の拡張

既存の `AuthUser` 形状は維持し、追加フィールドを足す。

```json
{
  "id": "usr_...",
  "email": "operator@example.local",
  "name": "Operator",
  "role": "operator",
  "authMethod": "token",
  "scopes": ["services:read", "services:operate", "logs:read"],
  "token": { "id": "tok_...", "name": "ci-deploy", "prefix": "s4s_ab12" }
}
```

### 監査

- `token.create`: `target: token:<id>`, `after: { userId, name, scopes, expiresAt, prefix }`
- `token.revoke`: `target: token:<id>`, `after: { prefix }`
- `auth.token.failed`: `actorLabel` は `anonymous`、`reason` は「invalid / expired / revoked」のいずれか。トークン全文は残さない。監査ログの flood を避けるため、同一 IP / prefix で 1 分に 1 回までに制限する（または失敗監査は P1 のレート制限導入まで保留する）。
- 既存の変更操作で `authMethod=token` の場合、`after.authMethod` と `after.tokenId` を付ける。共通ヘルパーを作る。

### テスト

- Bearer で `/auth/me` が成功する。
- Bearer が無効なら Cookie があっても 401（フォールバックしない）。
- スコープ不足は 403 + `requiredScope`。
- 失効・期限切れは 401。
- 他ユーザーのトークン一覧は `tokens:manage` なしで 403。
- 読み取り専用トークン（`tokens:manage` なし）が `POST /api/tokens` を呼ぶと 403。
- `tokens:manage` 付きトークンでも、発行元スコープを超えるトークン作成は 422。
- ロール上限を超えるスコープの作成は 422。
- スコープ設定のないルートに Bearer でアクセスすると 403。
- Cookie 認証は従来どおり全ルートで動く。
- CSRF: Bearer は Origin 検証の影響を受けない。Cookie の状態変更は従来どおり拒否される。

### 検証

```bash
pnpm --filter @sys4sys/api typecheck
pnpm --filter @sys4sys/api test
pnpm --filter @sys4sys/api smoke
```

手動（P0-04 時点では CLI の `tokens` コマンドはまだないため、API を直接使う）:

```bash
# 1. セッションでログインして Cookie を保存
curl -c cookies.txt -H "Content-Type: application/json" \
  -d '{"email":"admin@example.local","password":"<password>"}' \
  http://127.0.0.1:8787/api/auth/login

# 2. トークンを作成（返却された token を控える）
curl -b cookies.txt -H "Content-Type: application/json" \
  -d '{"name":"smoke","scopes":["services:read"]}' \
  http://127.0.0.1:8787/api/tokens

# 3. Bearer で確認
curl -H "Authorization: Bearer <token>" \
  http://127.0.0.1:8787/api/auth/me
```

> 実トークンをシェル履歴に残さない運用は P0-06 で `--token-file` / `--save` を用意する。上の例はローカル検証用。検証後は `cookies.txt` とトークンを削除する。

### 完了条件

- [x] Bearer と Cookie が共存し、Bearer 優先で動く。
- [x] すべての P0 対象ルートにスコープが設定されている。
- [x] スコープ不足・失効・期限切れのネガティブテストが通る。
- [x] トークン API が自分のトークンだけを返す。
- [x] 監査にトークン全文が残らない。

---

## P0-05 CLI 資格情報ストアと auth コマンド

### 目的

対話利用のログインを永続化し、`whoami` で認証方式とスコープを確認できるようにする。

### 変更

- 追加: `apps/cli/src/auth/store.ts`
- 追加: `apps/cli/src/commands/auth.ts` の拡張（`login`, `logout`, `status`）
- 変更: `apps/cli/src/client.ts`（資格情報プロバイダ、Bearer、401 の扱い）
- 変更: `apps/cli/src/index.ts`（`auth` グループ）
- 変更: `apps/cli/src/help.ts` / registry
- 追加: `apps/cli/src/auth/store.test.ts`
- 変更: `apps/cli/src/client.test.ts`

### 資格情報ストア

```ts
export interface StoredCredentials {
  apiUrl: string;
  token?: string;
  tokenId?: string;
  tokenPrefix?: string;
  tokenExpiresAt?: string;
  sessionCookie?: string;
  sessionExpiresAt?: string;
}

export interface CredentialStore {
  load(): Promise<StoredCredentials | null>;
  save(credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
  path(): string;
}
```

- 保存先の決定:
  - `SYS4SYS_CONFIG_DIR` があればそれ。
  - Windows: `%APPDATA%\sys4sys\credentials.json`
  - macOS/Linux: `$XDG_CONFIG_HOME/sys4sys/credentials.json` または `~/.config/sys4sys/credentials.json`
- ディレクトリは `0700`、ファイルは `0600` を best-effort で設定。
- 書き込みは一時ファイル + rename で原子的にする。
- 既存ファイルが壊れている場合は、削除せずエラーにする（利用者の資格情報を失わない）。
- `credentials.json` を `.gitignore` に追加する。

### 認証解決の優先順位

1. `SYS4SYS_TOKEN`
2. `SYS4SYS_TOKEN_FILE`
3. 保存済み `token`
4. `SYS4SYS_SESSION_COOKIE`
5. 保存済み `sessionCookie`
6. `SYS4SYS_EMAIL` + `SYS4SYS_PASSWORD`

`--api` / `SYS4SYS_API_URL` は別軸で最優先。

### コマンド

```bash
sys4sys auth login [--email <email>] [--password-stdin] [--api <url>]
sys4sys auth logout [--revoke-token] [--api <url>]
sys4sys auth status [--json]
sys4sys whoami [--json]
```

- `auth login`:
  - メール/パスワードは引数で受け取らない（履歴対策）。`--email` は可、パスワードは `--password-stdin` または TTY の hidden prompt。
  - **既存のトークン / `SYS4SYS_TOKEN` は使わず**、メール/パスワードで `POST /api/auth/login` を呼ぶ。
  - Cookie を取得し、保存する。
  - 既存の保存トークンがあれば削除する（混在防止）。`SYS4SYS_TOKEN` は環境変数なので変更しない。
  - 成功時に `email (role)` と保存先を stderr に出す。`--json` では保存先を出さない。
- `auth logout`:
  - 保存済みトークンがあれば `DELETE /api/tokens/:id`（可能なら）。`tokenId` がない場合は `GET /api/auth/me` で取得する。トークン認証では自分自身のトークンだけ失効できる。
  - セッション Cookie があれば `POST /api/auth/logout`。`auth logout` は環境変数のトークンを使わず、保存済みの資格情報を直接使う。
  - `--revoke-token` は保存済みトークンの API 失効を必須にする（失敗時はローカルを消さず exit 1）。
  - `SYS4SYS_TOKEN` / `SYS4SYS_TOKEN_FILE` はローカルの保存物ではないため失効しない。設定されている場合は stderr に「環境変数のトークンは別途失効してください」と警告する。
  - ローカル資格情報を削除する。API 失敗でもローカル削除は行い、警告する（`--revoke-token` を除く）。
- `auth status` / `whoami`:
  - API URL、認証方式、ユーザー、ロール、スコープ、トークン prefix、期限、資格情報の取得元（env token / stored token / env cookie / stored cookie / password）を表示する。
  - トークン全文は表示しない。

### クライアントの変更

- `ApiClientOptions` に `token`, `tokenFile`, `credentials` を追加。
- `Authorization: Bearer` を付与する。
- 401 時の再ログインは **セッションログイン経路のみ**。トークン経路では再試行しない。
- 403 の Problem Details を保持し、`requiredScope` をエラー表示に含める。
- `whoami` の型を拡張する。

### テスト

- 保存 → 読み込み → 削除。
- `tokenId` / `tokenPrefix` / `tokenExpiresAt` が保存され、`auth status` で表示される。
- 優先順位（env token > stored token > env cookie > stored cookie > email/password）。
- `SYS4SYS_TOKEN_FILE` の読み込み。
- `auth login` が `SYS4SYS_TOKEN` を無視してメール/パスワードでログインする。
- `auth logout` が `SYS4SYS_TOKEN` を失効しようとせず、警告する。
- 401 でトークン経路が再ログインしない。
- 401 でセッション経路が 1 回だけ再ログインする。
- 403 の `requiredScope` が表示される。
- 資格情報ファイルにトークン全文が平文で入ることを許容するが、ログには出さない（ローカルファイルは 0600）。

### 検証

```bash
pnpm --filter @sys4sys/cli typecheck
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- auth login --api http://127.0.0.1:8787
pnpm sys4sys -- auth status --json
pnpm sys4sys -- auth logout
```

### 完了条件

- [x] `auth login` / `logout` / `status` が動く。
- [x] `SYS4SYS_TOKEN` だけで `whoami` が動く。
- [x] 資格情報ファイルの場所とパーミッションが docs に書かれている。
- [x] トークンが標準出力・ログに出ない。

---

## P0-06 CLI トークン管理

### 目的

AI / CI 用のトークンを CLI から発行・一覧・失効できるようにする。

### 変更

- 追加: `apps/cli/src/commands/tokens.ts`
- 変更: `apps/cli/src/index.ts`
- 追加: `apps/cli/src/commands/tokens.test.ts`

### コマンド

```bash
sys4sys tokens list [--user <id>] [--json]
sys4sys tokens create --name <name> --scope <scope> [--scope <scope>...] \
  [--expires-in <days>] [--user <id>] [--save] [--json]
sys4sys tokens revoke <id> [--yes] [--json]
```

- `--scope` は複数回指定可能。カンマ区切りも受け付ける。
- `--expires-in` の既定は 90 日。1〜365 の範囲。
- `--save` は作成したトークンと `id` / `prefix` / `expiresAt` を資格情報ストアに保存する。既存のセッション Cookie は削除する。`SYS4SYS_TOKEN` / `SYS4SYS_TOKEN_FILE` が設定されている場合は、それが優先されるため stderr に警告する。
- `--json` の作成出力は `token` を含む。`list` は含めない。
- 作成時は stderr に「このトークンは一度しか表示されません」と警告する。
- `--user` は `tokens:manage` が必要。API が 403 を返したらそのまま表示する。
- `tokens` コマンド自体がトークン認証で動いている場合、`create` には `tokens:manage` が必要（API が 403）。セッション認証なら自分のトークンを作成できる。
- `revoke` は非対話で `--yes` 必須。`--json` では確認しない。トークン認証では自分自身のトークンのみ失効できる。

### 出力例

```text
ID        NAME        PREFIX     SCOPES                          EXPIRES
tok_ab12  ci-deploy   s4s_ab12   services:read,services:operate  2027-01-22
```

### テスト

- スコープの複数指定・カンマ区切り。
- 期限のバリデーション。
- `--save` でストアに保存され、セッションが消える。
- `--json` の作成出力にだけ `token` がある。
- `revoke` の `--yes` 必須。
- 403 の表示。

### 検証

```bash
pnpm sys4sys -- tokens create --name ci --scope services:read --scope logs:read --json
pnpm sys4sys -- tokens list --json
pnpm sys4sys -- tokens revoke <token-id> --yes
```

### 完了条件

- [x] トークンの発行・一覧・失効が CLI で完結する。
- [x] 発行時以外はトークン全文が表示されない。
- [x] `--save` で AI エージェント用の認証をセットアップできる。

---

## P0-07 サービスアクション履歴 API

### 目的

`services get` の `recentActions`（最大 20 件）に依存せず、アクションをページングして追跡できるようにする。`--wait` の信頼性を上げる。

### 変更

- 変更: `apps/api/src/routes/services.ts`
- 変更: `packages/shared/src/api.ts`
- テスト: `apps/api/src/routes/services.test.ts`（新設）

### API

```http
GET /api/services/:id/actions?limit=50&cursor=<ISO8601>
```

レスポンス:

```json
{
  "items": [
    {
      "id": "act_...",
      "incidentId": null,
      "serviceId": "svc_...",
      "type": "restart",
      "status": "succeeded",
      "requestedBy": "usr_...",
      "approvedBy": null,
      "policyId": null,
      "startedAt": "2026-10-24T00:00:00.000Z",
      "finishedAt": "2026-10-24T00:00:05.000Z",
      "error": null
    }
  ],
  "nextCursor": "2026-10-24T00:00:00.000Z"
}
```

- `limit` は 1〜200、既定 50。
- `cursor` は `startedAt`。`startedAt < cursor` で次ページ。同一 `startedAt` の取りこぼしを避けるため、`id` を tie-breaker にした複合カーソル（例: `<startedAt>|<id>`）にする。
- サービスが存在しない / 非アクティブなら 404。
- スコープは `services:read`。
- 既存 `GET /services/:id` の `recentActions` は互換のため残す。

### テスト

- 新しい順に返る。
- `limit` と `nextCursor` が正しい。
- カーソルで重複しない。
- 404。
- スコープ不足 403。

### 検証

```bash
pnpm --filter @sys4sys/api test
curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8787/api/services/<id>/actions?limit=10"
```

### 完了条件

- [x] アクション履歴をページングできる。
- [x] 既存の `recentActions` が壊れていない。

---

## P0-08 サービスライフサイクル CLI

### 目的

サービスの開始・停止・再起動・削除を CLI で安全に実行できるようにする。

### 変更

- 変更: `apps/cli/src/commands/services.ts`
- 変更: `apps/cli/src/index.ts`
- 変更: `apps/cli/src/commands/registry.ts`
- テスト: `apps/cli/src/commands/services.test.ts`

### コマンド

```bash
sys4sys services start <id> [--wait] [--timeout <sec>] [--json]
sys4sys services stop <id> [--yes] [--wait] [--timeout <sec>] [--json]
sys4sys services restart <id> [--yes] [--wait] [--timeout <sec>] [--json]
sys4sys services delete <id> [--yes] [--dry-run] [--json]
sys4sys services actions <id> [--limit <n>] [--cursor <iso>] [--json]
```

### 挙動

- `start`:
  - 破壊的でないため `--yes` 不要。
  - API は `POST /api/services/:id/start`。202 の action を返す。
  - `--wait` で `GET /api/services/:id/actions` をポーリングし、`succeeded` / `failed` を待つ。
- `stop` / `restart`:
  - 非対話では `--yes` 必須。TTY では対象と影響を表示して確認。
  - `--dry-run` は現在の status と実行予定を表示するだけ。
- `delete`:
  - 非対話では `--yes` 必須。
  - `--dry-run` はサービス存在と status を確認し、削除可能か表示する。
  - 実行中は API が 409 を返す。CLI はそのまま表示する。
- `actions`:
  - P0-07 の API を使う。
  - 表: `ID`, `TYPE`, `STATUS`, `STARTED`, `FINISHED`, `ERROR`。
- `--wait` のタイムアウト既定は 60 秒。`--timeout` で変更。
- 失敗時は exit 5。競合は 4。認証/認可は 3。

### 確認プロンプト

- stderr に出す。
- `--json` 時はプロンプトを出さず、`--yes` がなければ exit 2。
- 確認文言の例:

```text
service api-prod (svc_...) を停止します。よろしいですか? [y/N]
```

### テスト

- start が action を出す。
- stop/restart が非対話で `--yes` なしに exit 2。
- `--dry-run` が API を変更しない。
- `--wait` が succeeded / failed / timeout を正しく処理する。
- 409 / 403 / 401 の終了コード。
- `actions` のページング表示。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- services start <id> --wait --json
pnpm sys4sys -- services stop <id> --yes --wait --json
pnpm sys4sys -- services restart <id> --yes --wait
pnpm sys4sys -- services actions <id> --limit 10
pnpm sys4sys -- services delete <id> --dry-run
```

### 完了条件

- [x] start/stop/restart/delete が CLI で動く。
- [x] 非対話の破壊的操作が `--yes` なしで拒否される。
- [x] `--wait` がアクション ID で追跡し、別操作と混同しない。
- [x] 既存の deploy の `--wait` が壊れていない。

---

## P0-09 ログ検索 CLI

### 目的

サービス横断でログを検索し、JSON / 人間向けに出力できるようにする。

### 変更

- 追加: `apps/cli/src/commands/logs.ts`
- 追加: `apps/cli/src/time.ts`（相対時刻パーサ）
- 変更: `apps/cli/src/index.ts`
- テスト: `apps/cli/src/commands/logs.test.ts`, `apps/cli/src/time.test.ts`

### コマンド

```bash
sys4sys logs query [--host <host-id>] [--service <service-id>] \
  [--level <debug|info|warn|error|fatal>] [--grep <text>] \
  [--since <iso|15m|2h|1d>] [--until <iso|15m|2h|1d>] \
  [--limit <n>] [--cursor <iso>] [--json]
```

### マッピング

| CLI         | API                         |
| ----------- | --------------------------- |
| `--host`    | `hostId`                    |
| `--service` | `serviceId`                 |
| `--level`   | `level`                     |
| `--grep`    | `q`                         |
| `--since`   | `from`（ISO）               |
| `--until`   | `to`（ISO）                 |
| `--limit`   | `limit`（1〜500、既定 100） |
| `--cursor`  | `cursor`                    |

### 出力

人間向け:

```text
2026-10-24T00:00:00.000Z  error  api-prod  request failed: ECONNRESET
```

- タイムスタンプは UTC ISO。`--local` は P2 以降。
- メッセージは既定 200 文字で切り詰める。`--no-truncate` で無効。
- `--json` は API の `{ items, nextCursor }` をそのまま返す。
- `nextCursor` がある場合、人間向けでは stderr に `next: --cursor <iso>` を出す。

### 相対時刻

- `15m`, `2h`, `1d`, `30s` を受け付ける。
- 形式は `^(\d+)(s|m|h|d)$`。
- 負数・0・未知の単位は exit 2。
- `--until` に相対を指定した場合は「現在からその時間前」ではなく「現在」を基準に解釈するか、`--since` との差分で解釈する。P0 では **`--since` のみ相対を許可**し、`--until` は ISO のみとする（曖昧さを避ける）。

### セキュリティ

- ログ本文には秘密情報が含まれ得る。P0 ではサーバー側マスクがないため、README と `--help` に注意書きを出す。
- `--json` の出力をそのまま AI に渡さないよう SKILL に書く（P0-12）。
- P1-09 以降でサーバー側の redaction を検討する。

### テスト

- クエリパラメータのマッピング。
- 相対時刻のパース。
- 空結果。
- `nextCursor` の表示。
- 401/403 の終了コード。
- `--json` が API の形状を保つ。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- logs query --service <id> --level error --since 2h --json
pnpm sys4sys -- logs query --grep "ECONNRESET" --limit 20
```

### 完了条件

- [x] 主要フィルタで検索できる。
- [x] `--json` が API の `{ items, nextCursor }` を返す。
- [x] 相対時刻が使いやすく、曖昧な指定は拒否される。

---

## P0-10 ログ tail CLI（SSE）

### 目的

実行中サービスのログをリアルタイムに追えるようにする。

### 変更

- 変更: `apps/cli/src/commands/logs.ts`
- 変更: `apps/cli/src/client.ts`（SSE / ストリーム用の低レベルリクエスト）
- テスト: `apps/cli/src/commands/logs-tail.test.ts`

### コマンド

```bash
sys4sys logs tail [--host <host-id>] [--service <service-id>] \
  [--level <level>] [--grep <text>] [--json] [--no-reconnect]
```

- API: `GET /api/logs/stream?hostId=&serviceId=&level=&q=&from=&to=`
- `Content-Type: text/event-stream`。
- `event: log` の `data:` を JSON として読む。
- `: keep-alive` は無視する。
- Ctrl+C で AbortController を abort し、exit 0。
- 接続が切れたら指数バックオフ（1s, 2s, 4s, ... 最大 30s）で再接続する。`--no-reconnect` で無効。
- 401/403 は再接続しない。
- `--json` は NDJSON（1 行 1 オブジェクト）。
- 人間向けは `logs query` と同じ形式。
- stdout のバックプレッシャーを尊重する（`write()` が false なら `drain` を待つ）。

### テスト

- ローカルのモック SSE サーバーで 2 イベントを受信する。
- keep-alive を無視する。
- 切断後に再接続する。
- `--no-reconnect` で終了する。
- 401 で再接続しない。
- Ctrl+C（AbortController）で exit 0。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm sys4sys -- logs tail --service <id>
pnpm sys4sys -- logs tail --service <id> --json
```

### 完了条件

- [x] tail がリアルタイムに表示される。
- [x] Ctrl+C で安全に終了する。
- [x] 切断時に過剰な再接続をしない。
- [x] 認証エラーで無限ループしない。

---

## P0-11 `schema` コマンドと JSON Schema 生成

### 目的

AI / MCP / ドキュメントが参照する機械可読なコマンド契約を生成する。

### 変更

- 追加: `apps/cli/src/commands/schema.ts`（Schema 生成関数 + コマンド）
- 追加: `apps/cli/src/scripts/generate-schema.ts`（`--write` 用の薄いエントリ）
- 追加: `apps/cli/src/commands/schema.test.ts`
- 追加: `docs/cli-schema.json`（生成物）
- 変更: `apps/cli/src/commands/registry.ts`（Zod スキーマ参照）
- 変更: `package.json`（`schema:generate` スクリプト）

### コマンド

```bash
sys4sys schema [command] [--json] [--md]
```

- 引数なし: 全コマンドの Schema。
- `command`: `services list` などの完全名。存在しなければ exit 2。
- `--json`: JSON Schema。
- `--md`: Markdown のコマンドリファレンス。
- 既定は `--md`（人間向け）。AI は `--json` を使う。

### 出力（JSON）

```json
{
  "schemaVersion": "1",
  "cliVersion": "0.1.0",
  "auth": {
    "methods": ["token", "session"],
    "tokenHeader": "Authorization: Bearer <token>"
  },
  "exitCodes": {
    "0": "success",
    "1": "general error",
    "2": "usage error",
    "3": "auth error",
    "4": "conflict",
    "5": "async failure"
  },
  "commands": [
    {
      "name": "services list",
      "summary": "List services",
      "phase": "P0",
      "mutating": false,
      "requiresConfirmation": false,
      "requiredScopes": ["services:read"],
      "positionals": [],
      "options": {
        "type": "object",
        "properties": {
          "host": { "type": "string" },
          "status": { "type": "string" },
          "json": { "type": "boolean" }
        }
      },
      "examples": ["sys4sys services list --json"]
    }
  ]
}
```

- 生成時刻は含めない（CI の差分を安定させる）。必要な場合は `--with-timestamp` のような別フラグにする。
- 秘密値・環境依存値を含めない。

### 生成と CI

```json
{
  "scripts": {
    "schema:generate": "tsx apps/cli/src/scripts/generate-schema.ts --write docs/cli-schema.json"
  }
}
```

CI:

```yaml
- name: CLI schema is up to date
  run: |
    pnpm schema:generate
    git diff --exit-code docs/cli-schema.json
```

### テスト

- 全コマンドが Schema に含まれる。
- `schema services list --json` が単一コマンドを返す。
- 不正なコマンド名は exit 2。
- 生成物と実行時出力が一致する。
- `env` などの秘密値が含まれない。

### 検証

```bash
pnpm --filter @sys4sys/cli test
pnpm schema:generate
pnpm sys4sys -- schema --json | head
```

### 完了条件

- [x] `schema --json` が安定した契約を返す。
- [x] CI で生成物の差分を検出する。
- [x] P0-12 の SKILL が Schema を参照できる。

---

## P0-12 `SKILL.md`、CLI ドキュメント、CI 更新

### 目的

AI エージェントが sys4sys CLI を正しく・安全に使うための指示書を用意する。

### 変更

- 追加: `apps/cli/SKILL.md`
- 変更: `apps/cli/README.md`
- 変更: ルート `README.md`（CLI へのリンク）
- 変更: `.gitignore`（`credentials.json`）
- 変更: `.github/workflows/ci.yml`（Schema 差分、CLI テスト）
- 追加: `apps/cli/docs/EXAMPLES.md`（必要なら）

### `SKILL.md` の構成

```markdown
---
name: sys4sys
description: Operate sys4sys services, logs, incidents, and deployments through the sys4sys CLI. Use when the user asks to inspect service health, read logs, restart services, or manage deployments in sys4sys.
---

# sys4sys CLI

## When to use

## Authentication

## Safety rules

## Command reference

## JSON output

## Exit codes

## Common workflows

## Troubleshooting

## Do not
```

必須内容:

- 認証:
  - `SYS4SYS_TOKEN` を推奨。トークンを引数・ログ・コミットに書かない。
  - 対話では `sys4sys auth login`。
- 安全:
  - 破壊的操作の前に `--dry-run` と対象確認。
  - 非対話では `--yes`。
  - `--show-env` は原則使わない。使う場合は管理者権限と監査を意識する。
  - ログに秘密情報が含まれ得るため、外部 AI に貼る前に確認する。
  - P1 以降、deploy は承認が必要な場合がある。その場合は `--request` を使う。
- ワークフロー:
  - サービス異常の調査: `services list` → `services get` → `logs query` → `incidents list`。
  - 再起動: `services restart <id> --dry-run` → `--yes --wait`。
  - ログ追跡: `logs tail --service <id>`。
  - デプロイ: `services deploy <id> --dry-run` → `--yes --wait`（P1 以降は承認が必要なら `--request`）。
- 出力:
  - `--json` を基本にする。
  - 終了コード 3/4/5 の意味。
- 禁止:
  - `env` の値を会話・Issue・PR に貼らない。
  - トークンをコミットしない。
  - API を直接叩いて CLI の確認・監査を迂回しない。

### README 更新

- 新しいコマンド一覧。
- 認証の優先順位。
- トークン発行例（プレースホルダ）。
- `--dry-run` / `--yes` の規約。
- 終了コード。
- `schema` と `SKILL.md` へのリンク。
- 既知の制限（P0 時点ではサーバー側 env マスクなし）。

### CI 更新

- `pnpm --filter @sys4sys/cli test` を明示（`pnpm test` に含まれるが、ログを分かりやすく）。
- Schema 差分チェック。
- Markdown のリンク切れチェックは任意（P2）。

### テスト

- `SKILL.md` に存在しないコマンドが書かれていない（Schema と照合する簡易テスト）。
- README のコードブロックがシェルとして妥当（実行はしない）。
- CI が Schema 差分で落ちることを確認。

### 検証

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm schema:generate
git diff --exit-code docs/cli-schema.json
```

### 完了条件

- [x] AI が `SKILL.md` だけで認証・安全規則・主要ワークフローを理解できる。
- [x] README と実際のコマンドが一致する。
- [x] CI が Schema のドリフトを検出する。
- [x] `credentials.json` が Git 管理対象外になっている。

---

## 2. P0 の実装順（コミット単位の目安）

1. `P0-01` レジストリ（挙動変更なし）
2. `P0-02` 共有契約
3. `P0-03` DB + トークンサービス
4. `P0-04` Bearer + スコープ + トークン API
5. `P0-05` CLI 資格情報 + auth
6. `P0-06` CLI tokens
7. `P0-07` アクション API
8. `P0-08` サービスライフサイクル
9. `P0-09` ログ検索
10. `P0-10` ログ tail
11. `P0-11` Schema
12. `P0-12` SKILL + docs + CI

P0-07 と P0-09 は P0-04 の後なら並列可。P0-08 は P0-07 の後。P0-10 は P0-09 の後。P0-11 は P0-01 の後ならいつでも可。P0-12 は P0-11 の後。

---

## 3. P0 のテストマトリクス

| ケース                               | 期待                                 |
| ------------------------------------ | ------------------------------------ |
| 有効なトークン + 必要スコープ        | 200/202                              |
| 有効なトークン + スコープ不足        | 403 + `requiredScope`                |
| 失効トークン                         | 401                                  |
| 期限切れトークン                     | 401                                  |
| 無効なトークン + 有効 Cookie         | 401（Cookie にフォールバックしない） |
| ロール上限を超えるスコープ作成       | 422                                  |
| 他ユーザーのトークン一覧（権限なし） | 403                                  |
| 非対話 stop（`--yes` なし）          | exit 2                               |
| 非対話 delete（`--yes` なし）        | exit 2                               |
| deploy 失敗                          | exit 5                               |
| サービス競合                         | exit 4                               |
| ログ tail の切断                     | 再接続                               |
| ログ tail の 401                     | 再接続しない                         |
| Schema 生成物の差分                  | CI fail                              |

---

## 4. P0 のリスクと戻し方

| リスク                             | 戻し方                                                       |
| ---------------------------------- | ------------------------------------------------------------ |
| トークン認証で既存 Cookie が壊れる | Bearer がない場合のみ Cookie を使う。P0-04 のテストで固定    |
| スコープ設定漏れで操作できない     | 既定拒否。P0 対象ルートのマトリクスをテストで走査            |
| 資格情報ファイルの破損             | 自動削除しない。エラー表示して `auth login` を促す           |
| tail が無限再接続                  | バックオフ + 最大回数（例: 10 回）を設ける。`--no-reconnect` |
| Schema が実装と乖離                | CI で生成物差分を検出                                        |
| 既存 CLI の JSON 形状変更          | 追加のみ。既存キーを削らない                                 |

---

## 5. P0 完了チェックリスト

> 2026-10-25 時点で local 検証済み。local OpenAI API 到達環境での full API smoke は temp DB + admin password で 86/86 合格。

- [x] `P0-01` レジストリ
- [x] `P0-02` トークン契約
- [x] `P0-03` DB/トークンサービス
- [x] `P0-04` Bearer/スコープ/トークン API
- [x] `P0-05` CLI auth
- [x] `P0-06` CLI tokens
- [x] `P0-07` アクション API
- [x] `P0-08` サービスライフサイクル
- [x] `P0-09` ログ検索
- [x] `P0-10` ログ tail
- [x] `P0-11` Schema
- [x] `P0-12` SKILL/docs/CI
- [x] 既存の `services create/update/deploy` が無回帰
- [x] Web UI のログイン・サービス操作が無回帰
- [x] `pnpm format:check && pnpm typecheck && pnpm test` が通る
- [x] `pnpm --filter @sys4sys/api smoke` が通る（local OpenAI API 到達環境で temp DB + admin password で 86/86）
- [x] 公開リポジトリに secrets / DB / 個人パスがない
