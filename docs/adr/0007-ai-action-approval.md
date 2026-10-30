# ADR 0007: AI 提案アクションは型付き・人間承認・決定的実行に限定する

- 日付: 2026-10-30
- 状態: 採用

## 背景

AI 分析はインシデントの原因仮説と推奨アクションを返すが、LLM の出力をそのまま実行すると、対象サービスの取り違え、任意コマンドの実行、自己承認、二重実行、古い状態に基づく操作といったリスクがある。

Phase 1 では、AI に実行させるのではなく「提案させる」ことに限定し、別の人間が承認した場合だけ、sys4sys が既存の決定的なサービス操作を実行する必要がある。

## 決定

**AI の提案を `incident_action_proposals` に保存し、人間の承認後に `restart` / `start` だけを既存のサービス管理経路で実行する。**

提案:

- AI の `recommended_actions` から `restart` / `start` / `stop` / `deploy` だけを候補にする
- Phase 1 で実行承認できるのは `restart` / `start`。`stop` は `AI_ACTION_STOP_ENABLED=true` かつ admin 限定、`deploy` は Phase 2
- 対象サービスは AI の `target` ではなくインシデントの `serviceId` を正とする。target がサービス名 / ID と一致しない提案は捨てる
- 任意コマンド、shell、ファイルパス、設定値、秘密値は提案・保存・実行しない
- フォールバック分析、信頼度不足、期限切れ、重複提案は保存しない
- 提案時にサービス状態とインシデント状態のスナップショットを保存する

承認:

- 分析完了時に実行可能な提案が 1 つ以上あれば、主提案を選んで pending 承認を 1 件だけ自動作成する
- 自動承認は行わない。承認は operator / admin の別ユーザーが行う
- 選択はサービス状態が `stopped` / `failed` なら `start`、それ以外は `restart` を優先し、次にリスク、信頼度、AI の出力順で決める
- 同一インシデントの pending 承認は 1 件まで。他の提案は `proposed` のまま残し、却下・期限切れ後に明示的に再依頼できる
- 手動分析の実行者は `analysis_requested_by` に保存し、自己承認を禁止する。自動分析は `NULL`
- AI / MCP は承認 API を呼べない。MCP は読み取り専用のまま
- 承認期限は既定 30 分。期限切れは承認と提案を `expired` にし、インシデントを `open` に戻す
- `risk=high` は admin のみ承認できる
- 承認要求は `source=ai`、`proposal_id`、`expires_at` を持つ

実行:

- 承認後は `actions(source=ai_approved, proposal_id, approval_id)` を作成する
- `restart` は `restartService()`、`start` は `startService()`、`stop` は `stopService()` だけを使う
- 実行前と実行開始時に、インシデント未解決、提案状態、承認状態、サービス存在、デプロイロック、提案時スナップショットを再検証する
- 不一致は `409 proposal_stale` 相当として提案・承認を `expired` にし、再分析を促す
- 成功時は復旧確認を行い、成功ならインシデントを解決し、他の提案を `superseded` にする。`stop` は意図的停止として成功するがインシデントを自動解決しない
- 失敗時の自動再試行は行わない。再試行には新しい分析と承認を必要とする
- 実行は非同期で、API は `202` を返す

機能フラグ:

- `AI_ACTION_EXECUTION_ENABLED=false`
- `AI_ACTION_ALLOWED_TYPES=restart,start`
- `AI_ACTION_AUTO_REQUEST_APPROVAL=true`
- `AI_ACTION_MIN_CONFIDENCE=0.6`
- `AI_ACTION_TTL_MIN=30`
- `AI_ACTION_MAX_PROPOSALS=3`
- `AI_ACTION_HIGH_RISK_REQUIRE_ADMIN=true`
- `AI_ACTION_STOP_ENABLED=false`

既定はすべて安全側（実行無効、stop 無効）とし、既存の監視再起動承認には影響を与えない。

## 理由

- AI の誤出力が直接サービスを操作しない
- 人間の four-eyes を強制できる
- 対象サービスと操作種別をサーバー側で固定できる
- 既存の start / restart / stop と復旧確認を再利用でき、実行経路が増えない
- 提案・承認・アクション・監査を追跡できる
- フラグ OFF で schema / API / UI を先に配備できる

## 代替案

- **AI に直接コマンドを実行させる案**: 任意コード実行と対象取り違えのリスクが大きいため却下
- **AI が自分の提案を承認する案**: four-eyes が成立しないため却下
- **分析と同時に自動実行する案**: 人間の確認を挟めず、古い状態での操作も防げないため却下
- **既存 `approvals` に提案を直接埋め込む案**: 複数提案、却下後の再依頼、実行状態の追跡が難しいため、提案テーブルを分離
- **`deploy` を Phase 1 に含める案**: 任意コマンドと秘密値の扱いが大きく、既存 deploy 承認との統合設計が必要なため Phase 2 に分離

## 運用上の注意

- `AI_ACTION_EXECUTION_ENABLED=true` は開発環境で十分に検証してから本番へ展開する
- `AI_ACTION_STOP_ENABLED=true` は admin 限定の緊急運用に限る
- 提案理由や監査ログに秘密値、トークン、パスワードを書かない
- 承認画面で risk、期限、対象サービス、action type を確認する
- スナップショット不一致や期限切れは自動再試行せず、再分析と新しい承認を求める
- AI / MCP 用トークンに `approvals:decide` や `approvals:request` を付与しない
