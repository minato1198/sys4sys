# sys4sys コードレビュー

- 実施日: 2026-11-08
- 対象ブランチ: `main`
- 対象コミット: `2500b85 docs: add sys4sys logo to README`
- 主なレビュー対象: AI 提案アクション承認 (`893fe65 feat: add AI action approval proposals`), Windows / NSSM 外部サービス制御 (`85bcc9c`), Web UI, API, CLI / MCP, docs, tests, CI
- 追記: このレビュー後、優先度 A と B1-B5 / C1、Web の行選択 accessibility を実装済み。React Doctor 由来の fetch layer 共通化、巨大ページ分割、CLI 提案承認拡張は未実施。

## 総合判定

**条件付き合格**。

AI 提案を人間承認後にのみ `restart` / `start` へ限定し、AI に任意コマンドやシェルを実行させる設計にはなっていません。Phase 1 の安全方向性は概ね妥当です。

ただし、本番で `AI_ACTION_EXECUTION_ENABLED=true` を有効化する前に、以下の運用・並行性・復旧系の課題を優先的に解消すべきです。既定フラグが off の間は自動実行は起きませんが、有効化後の信頼性と承認漏れのリスクが残ります。

---

## 1. 実施した検証

| 検証                | 結果                                                    |
| ------------------- | ------------------------------------------------------- |
| `pnpm format:check` | 合格                                                    |
| `pnpm typecheck`    | 全ワークスペース合格                                    |
| `pnpm test`         | 合格                                                    |
| `pnpm build`        | 合格。Next.js の workspace root 推定警告あり            |
| `pnpm test:e2e`     | 合格。live E2E 4 件成功                                 |
| `pnpm audit --prod` | 既知の脆弱性なし                                        |
| React Doctor        | `apps/web` でスコア `43 / 100`、警告 58 件、エラー 0 件 |

代表的なテスト件数:

| 領域              | 結果           |
| ----------------- | -------------- |
| `packages/shared` | 19 tests pass  |
| `packages/policy` | 10 tests pass  |
| `apps/agent`      | 26 tests pass  |
| `apps/cli`        | 160 tests pass |
| `apps/api`        | 162 tests pass |
| CLI live E2E      | 4 tests pass   |

---

## 2. 良好な点

### 2.1 AI 実行の安全境界

- AI 出力は `analysisResultSchema` で正規化されている。
- `recommended_actions[].type` は文字列のまま受け取っても、サーバー側で `restart` / `start` / `stop` / `deploy` にマップし、許可外は無視する。
- Phase 1 の実行許可は `restart` / `start` に限定されている。
- `stop` は `AI_ACTION_STOP_ENABLED=false` が既定で、さらに admin 限定。
- `deploy` は Phase 2 として実行拒否。
- AI が提案するのは型付きアクションであり、コマンド文字列、シェル、ファイルパス、設定値ではない。

該当:

- `packages/ai/src/prompt.ts`
- `apps/api/src/monitoring/action-proposals.ts`
- `apps/api/src/monitoring/incidents.ts`
- `apps/api/src/config.ts`

### 2.2 人間承認が必須

- 分析完了後に自動作成されるのは pending 承認依頼まで。
- 実行は人間の承認 API を経由した場合だけ。
- 自動実行 action は生成されない。
- 高リスク提案は admin だけが承認可能。
- 手動分析の依頼者自身は、その分析から生成された提案を承認できない。
- AI 提案の承認には `approvals:request` と `approvals:decide` が分離されている。

該当:

- `apps/api/src/monitoring/action-proposals.ts`
- `apps/api/src/monitoring/incidents.ts`
- `apps/api/src/routes/action-proposals.ts`
- `apps/api/src/routes/approvals.ts`
- `apps/api/src/monitoring/action-proposals.test.ts`
- `apps/api/src/routes/action-proposals.test.ts`

### 2.3 実行経路は決定論的

AI 承認後の action は `restartService()` / `startService()` / `stopService()` といった既存サービス制御経路を使う。AI 提案から直接シェルや arbitrary command へ渡る経路は見つからなかった。

Windows SCM 系は `execFile` と引数配列を使い、サービス名を env 変数経由で渡している。PowerShell 内でも service 名を文字列補間しない。

該当:

- `apps/agent/src/exec.ts`
- `apps/api/src/services/service-control.ts`
- `apps/api/src/services/command-check.ts`
- `apps/api/src/services/allowlist.ts`

### 2.4 監査とイベント

- `ai.action.proposed`
- `approval.request`
- `approval.approved`
- `approval.rejected`
- `ai.action.started`
- `ai.action.succeeded`
- `ai.action.failed`
- `ai.action.stale`
- `ai.action.expired`
- `ai.action.superseded`

が監査またはインシデントイベントとして追跡される。失敗・期限切れ・supersede の追跡は良い。

### 2.5 秘密情報の扱い

- Service env は AES-256-GCM で保存。
- API token / session token はハッシュ保存。
- AI へ送るログは mask して truncation。
- AI 失敗理由は mask してから保存。
- Web API 応答で service env 値を露出しないテストがある。
- `pnpm audit --prod` は既知脆弱性なし。

---

## 3. 優先度別の指摘

優先度:

- `A`: 本番で `AI_ACTION_EXECUTION_ENABLED=true` を有効化する前に対処推奨
- `B`: 次のイテレーションで解消すべき
- `C`: 品質・一貫性・長期保守性

### A1. 中断された action / proposal の startup 復旧がない

現在、API 起動時は `reconcileDeployments()` と `reconcileServices()` のみ実行している。`deploy` 以外の restart / start / stop action、特に AI 提案 action に対して startup reconciliation がない。

想定シナリオ:

1. 承認後に `startProposalAction()` が action を `pending` で作成する。
2. `executeProposalAction()` が proposal を `approved` から `executing` に遷移する。
3. その途中で API が停止 / クラッシュする。
4. 再起動後も action は `running`、proposal は `approved` または `executing` のまま残る。

既存の `executeProposalAction()` は起動時に再取得される保証がない。結果として、UI 上は実行中または承認済みに見えるが、実際には何も実行されていない状態になり得る。

また、監視の自動再起動で `startRestartAction()` が作成した pending / running action も startup で失敗確定されない。`evaluateIncidentAutomation()` は直近 60 秒の pending / running action だけ抑止するため、古すぎる pending action は放置され、後続で別の再起動提案や action が積み上がる可能性がある。

推奨:

- `apps/api/src/app.ts` で `reconcileIncidentActions()` のような startup sweep を追加する。
- stale 閾値は既存の `SERVICE_CONTROL_TIMEOUT_MS`, `AUTO_RESTART_VERIFY_TIMEOUT_SEC`, `DEPLOY_STALE_MS` と整合させる。
- `approved` だが action がない proposal は stale / failed にして incident を `open` に戻す。
- `executing` proposal と `pending` / `running` action は失敗として確定し、audit と event を残す。
- 「成功扱いしない」ことを明示する。
- 起動時 sweep のテストを追加する。

該当:

- `apps/api/src/app.ts:30-31,140-141`
- `apps/api/src/monitoring/incidents.ts:758-795,971-1121`
- `apps/api/src/monitoring/incidents.ts:1490-1510`

---

### A2. 承認依頼作成に DB レベルの重複防止がない

`claimProposalApproval()` は次を行っている:

1. incident に pending approval があるか select する。
2. pending がなければ approval を insert する。
3. proposal を `pending_approval` へ conditional update する。
4. 失敗したら approval を delete する。

この read-then-insert は非同期で挟み込まれると重複する可能性がある。同一 incident に pending approval を 1 件だけにする制約が DB に存在しない。

影響:

- 同一 incident に pending approval が 2 件できる。
- UI や CLI で承認対象が曖昧になる。
- 別の承認者が意図しない提案を承認する可能性が出る。
- `approvals` 一覧の pending 数が実態より多くなる。

推奨:

- SQLite partial unique index を追加する。
  - 例: `approvals.incident_id` where `approvals.status = 'pending'` を unique。
- または、approval insert と proposal update を transaction 化する。
- `claimProposalApproval()` のテストに並行 request を追加する。
- UI 側は「既に pending 承認があります」を 409 として分かりやすく表示する。

該当:

- `apps/api/src/db/schema.ts:356-385`
- `apps/api/src/monitoring/action-proposals.ts:395-448`
- `apps/api/src/routes/action-proposals.ts:135-158`

---

### A3. 期限切れ sweep が incident 詳細開示時だけに依存している

`expireProposalsForIncident()` は `GET /incidents/:id` などの詳細取得時に呼ばれる。承認一覧 `GET /approvals` や dashboard の pending 件数取得では期限切れ更新が走らない。

影響:

- 期限切れ pending approval が UI に残る。
- dashboard の `pendingApprovals` 件数が過大になる。
- 承認者が古い承認を見て誤操作する可能性がある。
- 「期限 30 分」の運用意味が弱くなる。

推奨:

- 定期 sweep job を追加する。
  - 例: 30 秒ごとに `expirePendingApprovals()` を incident 単位または approval 単位で実行。
- あるいは dashboard / approvals list 取得時に stale pending だけ sweep する。
- `expireProposalsForIncident()` を呼ぶ箇所を API 一覧系にも追加し、監査イベントが重複しすぎないよう idempotent にする。
- 期限切れ sweep の integration test を追加する。

該当:

- `apps/api/src/routes/incidents.ts:191-201,203-271`
- `apps/api/src/routes/approvals.ts:172-248`
- `apps/api/src/monitoring/action-proposals.ts:607-682`
- `apps/api/src/monitoring/incidents.ts:300-315`

---

### A4. 状態遷移がトランザクションではない

`decideApproval()`、`claimProposalApproval()`、`startProposalAction()` は複数ステップの DB 更新を行うが、`db.transaction()` を使っていない。

特に承認時は:

1. approval を `approved` に更新する。
2. proposal を `approved` に更新する。
3. action を insert する。

approval 更新後に action insert が失敗すると、approval と proposal は承認済みのまま、実行 action が存在しない状態になり得る。`claimProposalApproval()` でも approval insert 後の proposal update 失敗時に approval delete は行うが、イベントや監査まで含む全体保証はない。

影響:

- 承認済みだが実行 action がないレコードが残る。
- 監査ログと DB 状態がズレる。
- 障害時の原因追跡が難しくなる。

推奨:

- 状態変化そのものは transaction で守る。
- 監査・通知は transaction 外で best effort にする。
- 失敗時に元状態へ戻す compensation を入れる。
- 「approval approved but action missing」を startup reconcile で掃除する。

該当:

- `apps/api/src/monitoring/incidents.ts:551-644,758-795`
- `apps/api/src/monitoring/action-proposals.ts:395-448`

---

### B1. 計画ファイルと実装のズレ

`tasks/AI_ACTION_APPROVAL_PLAN.md` はステータスが「計画（主要決定済み / 未実装）」のままだが、主要部は実装済み。一方、計画に挙げた一部は未実装。

明確なズレ:

- 計画の `apps/api/src/monitoring/action-executor.ts` は作成されていない。実行ロジックは `apps/api/src/monitoring/incidents.ts` に埋め込まれている。
- 計画の Web レポート画面「推奨対応と提案状態が表示できる」が未実装。`apps/web/app/reports/page.tsx` に proposal 表示がない。
- 計画では却下後の再依頼を想定しているが、実装は `status = proposed` の提案しか承認依頼できない。却下提案そのものは再依頼できない。
- OpenAPI / ER / ADR は更新されている。

推奨:

- `tasks/AI_ACTION_APPROVAL_PLAN.md` のステータスを実装状況へ更新する。
- 意図的に `action-executor.ts` を分離しないなら、ADR または計画で方針を変える。
- 却下後の扱いを明確にする。
  - 案 A: 却下提案は再依頼不可とし、再分析で新提案を作ることを UI / docs に書く。
  - 案 B: 却下後の再依頼を許可し、新しい TTL で pending 承認を作る。
- レポート画面に proposal 状態を出すか、Phase 2 相当として計画から外す。

該当:

- `tasks/AI_ACTION_APPROVAL_PLAN.md:1-8,451-458,756-769`
- `apps/api/src/monitoring/action-proposals.ts:500-560`
- `apps/web/app/reports/page.tsx`

---

### B2. `action-executor.ts` 分離が未実施

計画では実行エンジンを別モジュールにする想定。実際は `apps/api/src/monitoring/incidents.ts` が 1579 行あり、承認判断、legacy restart、AI action 実行、supersede、通知が同居している。

影響:

- AI 実行系のレビュー面積が大きい。
- 次回 deploy 統合時に `incidents.ts` がさらに肥大化する。
- 実行条件のテストが monitoring 全体に依存しやすくなる。

推奨:

- 低リスクリファクタリングとして `apps/api/src/monitoring/action-executor.ts` を作成し、以下を移す。
  - `startProposalAction()`
  - `executeProposalAction()`
  - `succeedProposalExecution()`
  - `failProposalExecution()`
  - `verifyRecovery()`
- `incidents.ts` は承認ディスパッチと legacy restart に絞る。
- 移行前後で既存テストを通す。

---

### B3. ローカル AI エンドポイント判定が広い

`isLocalEndpoint()` は次を local とみなす:

- `localhost`
- `127.0.0.1`
- `::1`
- `0.0.0.0`
- `host.docker.internal`
- `.localhost`
- `.local`
- RFC1918 private IP
- ULA / link-local IPv6
- ドットを含まない短いホスト名すべて

「ドットを含まないホスト名」を local とみなすのは注意が必要。OS の DNS search domain 経由で外部名前解決される可能性がある。`0.0.0.0` や `169.254.0.0/16` を local として扱う点も、クラウド環境や特殊ネットワークでは安全とは限らない。

影響:

- `AI_SEND_LOGS_EXTERNALLY=false` の意味が弱まる。
- 管理者設定ではあるが、意図しない外部 AI エンドポイントへログを送る可能性がある。

推奨:

- 判定を明示的な allowlist に寄せる。
  - 例: `AI_LOCAL_ENDPOINTS=localhost,127.0.0.1,::1,host.docker.internal,ollama.local,lmstudio.local`
- hostname を resolve して private range だけ許可するなら、DNS rebind / cloud metadata 対策も書く。
- `0.0.0.0` は listen 用途と send 用途を分ける。
- 設定保存時に「外部送信」と判定される baseUrl へ warning を出す。

該当:

- `apps/api/src/settings/ai.ts:83-138`

---

### B4. Web 管理画面に security headers がない

Web 側には CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS などに類する明示的な設定が見当たらなかった。Fastify API は JSON 中心だが、Next.js 管理画面はセッション Cookie と認証 API を扱う。

推奨:

- `next.config.ts` の `headers()` またはリバースプロキシで最低限を追加する。

  - `Content-Security-Policy`
  - `X-Frame-Options: DENY` または CSP `frame-ancestors 'none'`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy`
  - 本番では `Strict-Transport-Security`

- Next.js 独自 theme script 自体は静的だが、CSP を導入するなら inline script 許可方法を検討する。

該当:

- `apps/web/next.config.ts`
- `apps/web/app/layout.tsx`
- `apps/api/src/app.ts`

---

### B5. daily limit 系が SQL aggregate ではない

`countRequestsToday()` と `usedToday()` は当日分の行を選択して length を数えている。件数が増えると無駄。

推奨:

- SQL aggregate に変更する。
- 例: `select count(*)`。
- index が効くように `ai_analyses.created_at` index を追加するか、既存 index と併用できるか確認する。

該当:

- `apps/api/src/ai/analysis.ts:178-189`
- `apps/api/src/settings/ai.ts:66-77`

---

### B6. `incident_action_proposals` の重複キーが DB 制約ではない

`dedupeKey` はあるが、index であって unique ではない。通常フローでは materializer 側で seen set を使うため防げるが、並行実行や再試行では重複挿入があり得る。

推奨:

- active status に対してだけ partial unique index を考える。
- 例: `(incident_id, dedupe_key)` where status が active。
- ただし履歴保持の都合があるので、migration 前に既存データと業務要件を確認する。

該当:

- `apps/api/src/db/schema.ts:291-354`
- `apps/api/src/monitoring/action-proposals.ts:214-277`

---

### B7. FK 制約がアプリケーション検証に依存している

`foreign_keys = ON` にはしているが、schema 側に FK 定義が見当たらなかった。incident / proposal / approval / action の関連はアプリケーションコードで整合性を保っている。

影響:

- 将来 migration や手動 DB 編集時に孤立レコードを作りやすい。
- レポート・監査・CLI の join 系で防御が減る。

推奨:

- 段階的に FK を追加するか、少なくとも ER 図とテストで孤立レコード防止を明示する。
- startup integrity sweep を追加してもよい。

該当:

- `apps/api/src/db/index.ts`
- `apps/api/src/db/schema.ts`
- `docs/ER.md`

---

### C1. Next.js build 警告

`pnpm build` 中に Next.js が workspace root をユーザーディレクトリの `package-lock.json` から推定している。

現在のところ build は成功しているが、tracing root が誤ると将来 bundling や monorepo 解析で混乱する可能性がある。

推奨:

- `apps/web/next.config.ts` に明示的な `outputFileTracingRoot` を設定する。
- または、ユーザーホーム直下の不要な `package-lock.json` を片付ける。

該当:

- `apps/web/next.config.ts`

---

### C2. React Doctor 診断

React Doctor は `apps/web` でスコア `43 / 100`、警告 58 件を出した。エラーはない。React Doctor の指示通り、これらは自動確定診断ではなく検証用の出発点として扱うべきだが、一部は明確な改善対象。

診断件数:

| カテゴリ        | 件数 |
| --------------- | ---: |
| Bugs            |   24 |
| Maintainability |   20 |
| Accessibility   |   11 |
| Performance     |    3 |

主なルール:

| ルール                                        | 件数 | 評価                                                                 |
| --------------------------------------------- | ---: | -------------------------------------------------------------------- |
| `no-giant-component`                          |   10 | 妥当。ページが大きい                                                 |
| `no-high-complexity-react-function`           |    8 | 妥当。状態分岐と副作用が多い                                         |
| `no-fetch-in-effect`                          |    6 | 方針として妥当。既存クライアントページ全体の問題                     |
| `no-array-index-as-key`                       |    4 | 部分的に妥当。静的リストは影響が小さい可能性あり                     |
| `control-has-associated-label`                |    3 | 妥当。フィルター select などに aria-label が必要                     |
| `click-events-have-key-events`                |    2 | 妥当。クリック可能な行に keyboard operation がない                   |
| `no-fetch-response-used-without-status-check` |    3 | 一部 false positive 寄り。実際は status check があるが順序が改善余地 |
| `no-effect-chain`                             |    2 | 妥当。selectedId を起点に再描画連鎖                                  |

主な対象ファイル:

- `apps/web/app/incidents/page.tsx`: 1208 行、提案 UI と承認依頼を含む最重要画面。
- `apps/web/app/approvals/page.tsx`: 638 行、承認操作の中心。
- `apps/web/app/settings/page.tsx`: 1110 行。
- `apps/web/app/services/page.tsx`: 1905 行。
- `apps/web/app/page.tsx`: 1024 行。

高優先の改善候補:

1. 承認一覧・インシデント一覧の行選択をボタンまたはリンクに置き、键盘操作可能にする。
2. select などに `aria-label` を付ける。
3. 共通 API client に fetch とエラー整形を集約する。
4. incidents / approvals の巨大ページを list / detail / approval card / proposal card に分割する。
5. React Doctor のスコアを CI で監視する場合、まず `apps/web` だけ gate 化し、スコア低下だけを失敗にする。

---

### C3. 実行許可コマンド allowlist は basename 基準

`isCommandAllowed()` は basename と拡張子除去で判定する。allowed name であれば absolute path でも許可される。

例として `node.exe` が allowlist にある場合、絶対パス指定でも許可される。シェル起動ではないため直接 command injection ではないが、パス制約を厳格化したい場合は弱い。

推奨:

- 必要なら absolute path の先頭許可ルートを追加する。
- 現状の threat model なら低優先。ただし docs に「basename 基準」と明記するのが良い。

該当:

- `apps/api/src/services/allowlist.ts`

---

### C4. 静的 lint / React quality gate がない

CI は format, typecheck, unit tests, CLI build, web build, audit, E2E を実行している。ESLint や React Doctor は CI に含まれない。

推奨:

- ESLint を導入して、少なくとも unused vars, exhaustive-deps, accessibility rules を見る。
- React Doctor は導入直後は警告が多いため、まずスコア低下ガードとして追加するのが現実的。
- 新規差分に対する `react-doctor --diff` を推奨。

---

## 4. AI / MCP 承認に関する評価

### 良い点

- AI 提案の承認 API は MCP へ公開されていない。
- MCP read tool は承認一覧を読むだけ。
- MCP write tool は deploy request 承認を含むが、AI action proposal を承認する tool はない。
- AI / MCP 用トークンに `approvals:decide` や `approvals:request` を付与しない方針が ADR に書かれている。

### 注意点

MCP write tool には deploy request 承認が存在する。したがって、AI / MCP 用トークンに `approvals:decide` を誤付与すると、AI action proposal ではなく deploy request を承認できてしまう。これは別系統だが、権限設計としては境界が分かりにくい。

推奨:

- AI / MCP 用トークンには `approvals:decide` を渡さない運用を docs にさらに明確に書く。
- MCP write tool を使う人間専用運用なら、token purpose を UI / docs で明示する。
- 将来的に AI action approval tool を追加するなら、四眼原則を token 単位ではなく principal 単位で強制する。

該当:

- `apps/cli/src/mcp/tools/read.ts`
- `apps/cli/src/mcp/tools/write.ts`
- `docs/adr/0007-ai-action-approval.md`

---

## 5. 推奨する修正順序

### 本番有効化前

1. `reconcileIncidentActions()` を追加する。
2. pending approval 重複を DB 制約または transaction で防ぐ。
3. 期限切れ pending を定期 sweep する。
4. `decideApproval()` の部分失敗状態を掃除する。
5. 以下のテストを追加する。
   - 並行 `request-approval` で pending が 1 件だけになる。
   - API 再起動時に stale `approved` / `executing` / `running` が失敗確定される。
   - 期限切れ pending が dashboard / approvals list からも消える。
   - action insert 失敗時に approval / proposal が古いまま残らない。

### 次の改善イテレーション

1. `action-executor.ts` を分離する。
2. reports page に proposal 状態を出すか、計画の未実装点として明示する。
3. `tasks/AI_ACTION_APPROVAL_PLAN.md` のステータスを実装状況に合わせる。
4. 却下提案の再依頼可否を確定し、docs / API / UI を一致させる。
5. `isLocalEndpoint()` を stricter にする。
6. Web security headers を追加する。

### 低優先

1. daily count を SQL aggregate にする。
2. Next.js `outputFileTracingRoot` を設定する。
3. React Doctor 高スコア項目から accessibility と fetch layer を改善する。
4. ESLint / React Doctor quality gate を考える。
5. FK または integrity sweep を考える。

---

## 6. リスク評価

| リスク                                                  | 現状                                  | 評価   |
| ------------------------------------------------------- | ------------------------------------- | ------ |
| AI が arbitrary command を実行する                      | 該当なし                              | 低     |
| AI が人間の承認なしに restart / start する              | 該当なし                              | 低     |
| 同一 incident に pending 承認が重複する                 | DB 制約なし                           | 中     |
| 期限切れ承認が UI に残る                                | sweep が詳細取得中心                  | 中     |
| API 再起動後に action / proposal が実行中扱いのまま残る | 非 deploy 用 startup reconcile 未実装 | 中〜高 |
| 外部 AI へのログ送信抑制が bypass する可能性            | local endpoint 判定が広い             | 中     |
| Web 画面の基本 security headers 不足                    | 明示的な設定なし                      | 中     |
| React UI の巨大化・a11y・fetch race 警告                | React Doctor 58 件                    | 中     |
| 依存パッケージの既知脆弱性                              | `pnpm audit --prod` clean             | 低     |

---

## 7. 推奨する運用フラグ方針

現行 default は安全側:

```text
AI_ACTION_EXECUTION_ENABLED=false
AI_ACTION_ALLOWED_TYPES=restart,start
AI_ACTION_AUTO_REQUEST_APPROVAL=true
AI_ACTION_MIN_CONFIDENCE=0.6
AI_ACTION_TTL_MIN=30
AI_ACTION_MAX_PROPOSALS=3
AI_ACTION_HIGH_RISK_REQUIRE_ADMIN=true
AI_ACTION_STOP_ENABLED=false
```

本番有効化の推奨手順:

1. 開発環境で `AI_ACTION_EXECUTION_ENABLED=true`。
2. `restart` / `start` のみ許可。
3. demo service で承認から実行・失敗・期限切れを再現。
4. stale reconciliation と pending sweep を実装。
5. 監査ログと通知を確認。
6. 問題時は `AI_ACTION_EXECUTION_ENABLED=false` に戻す。
7. 本番へ展開。

---

## 8. 最終所見

Phase 1 の設計は「AI に提案させ、人間が承認し、sys4sys の deterministic action runner だけを実行する」という目的に合致している。自己承認禁止、高リスク admin 限定、stop 抑制、deploy 分離、typed action、audit trail はいずれも重要で、テストも主要な安全条件をカバーしている。

一方で、実際の運用に移す前に最も重要なのは実行系の復旧性と重複防止である。特に:

- 中断された action / proposal の startup reconcile
- pending approval 重複防止
- 期限切れ sweep
- 部分失敗後の状態掃除

この 4 点を解消すれば、`AI_ACTION_EXECUTION_ENABLED=true` を開発環境だけでなく本番へ広げる際の信頼性が大きく上がる。
