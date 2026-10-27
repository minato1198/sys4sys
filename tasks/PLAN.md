# sys4sys — バックエンド運用管理システム 計画書

> ポート管理・ログ管理・AI監視による自動復旧／自動レポートを行う、Windows + WSL 向けの運用管理ツール。

- 版: v0.3（ステータス更新）
- 作成日: 2026-10-21 / 更新日: 2026-10-25
- ステータス: M6 完了（M0: 設計確定、M1: 基盤 + 認証 + ポート、M2: サービス + ログ + WSL、M3: 監視・自動復旧・メール、M4: AI 分析・レポート、M5: 運用強化、M6: デプロイ連携）
- 残課題: M3+ のメールダイジェスト集約とレポート再送、M5 の 1 週間連続稼働確認、M0 の SMTP / LLM / WSL 設定値項目（設定画面で登録する方針は決定済み）

---

## 0. 確定した要件

| 項目             | 決定                                            | 設計への影響                                                               |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| 対象環境         | **Windows ローカル + WSL 内プロセス**           | ホスト抽象化レイヤが必要。WSL は `wsl.exe` 経由で操作                      |
| 監視対象         | **自作の API / ワーカー**                       | 起動コマンド・作業ディレクトリ管理が中心。ミドルウェア監視は将来対応       |
| 実装             | **TypeScript で統一**                           | pnpm モノレポ。API / UI / Agent で型・バリデーションを共有                 |
| AI               | **ローカル LLM（OpenAI 互換 API）を基本、BYOK** | `baseURL` + API キー + モデル名を設定。既定でログは外部送信しない          |
| 自動再起動       | **段階的自動**（監視 → 承認 → 自動）            | 昇格条件を明文化。初期は通知のみ                                           |
| 通知             | **メール（SMTP）**                              | nodemailer + TLS。即時通知とダイジェスト                                   |
| 承認導線         | **UI のみ**                                     | メールは通知のみ。承認はログイン後の画面で実施（メール内リンクは将来拡張） |
| 利用者           | **チームで共有**                                | ログイン、3 ロール（admin / operator / viewer）、監査の帰属                |
| 常駐             | **開発機で手動起動**                            | ワンコマンド起動。サービス化は将来の拡張                                   |
| SMTP / LLM / WSL | **未定 → 設定画面で登録**                       | 特定プロバイダに依存しない。接続テストとディストロ自動検出を用意           |

> BYOK = Bring Your Own Key。利用者が自分のローカル LLM（LM Studio / Ollama / vLLM など）のエンドポイントとキーを設定する。

---

## 1. 背景と目的

複数のバックエンド（API、ワーカーなど）を Windows と WSL にまたがって動かしていると、次の問題が繰り返し発生する。

1. **ポートの取り合い** — Windows 側と WSL 側のどちらがポートを使っているか分からず、起動失敗する。
2. **ログの散在** — Windows のコンソール、ファイル、WSL 内のログに散らばり、横断検索できない。
3. **停止に気づくのが遅い** — 落ちても手動で気づくまでダウンし続ける。
4. **原因調査が属人化** — エラーログを毎回人が読み、同じ調査を繰り返す。

本システムは、これらを **1つのダッシュボード** に統合し、**定型的な復旧は自動化**、**判断が必要な部分だけ AI が要約・レポート** することで、運用コストとダウンタイムを下げることを目的とする。

### 成功指標（KPI）

| 指標                                 | 目標                                     |
| ------------------------------------ | ---------------------------------------- |
| 異常発生から検知までの時間           | 30 秒以内                                |
| 自動復旧成功率（自動化対象サービス） | 80% 以上                                 |
| インシデント調査の初動時間           | 5 分以内（レポート自動生成・メール到達） |
| ポート競合による起動失敗             | 月 0 件（起動前チェックで防止）          |
| 誤検知による不要な再起動             | 自動化対象で月 1 件以下                  |

### スコープ外（初期リリースではやらない）

- 大規模クラスタ・Kubernetes のオーケストレーション
- ログの長期保管（数 TB 規模）や課金分析基盤
- AI によるコードの自動修正・自動デプロイ
- マルチテナント SaaS 化、社外公開
- クラウド AI へのログ送信（設定で追加は可能だが既定はオフ）

---

## 2. 全体像

```
┌───────────────────────────────────────────────────────────────┐
│  Web UI (Next.js)                                             │
│  Login / Dashboard / Ports / Services / Logs / Incidents       │
│  Reports / Approvals / Settings / Users                       │
└───────────────▲───────────────────────────────▲───────────────┘
                │ REST + SSE (session cookie)   │
┌───────────────┴───────────────────────────────┴───────────────┐
│  API Server (Fastify + TypeScript)                            │
│  認証/ロール | Service/Port | ログ検索 | インシデント          │
│  ポリシー評価 | 承認キュー | レポート | 監査ログ | メール通知   │
└──────▲──────────────────▲──────────────────▲──────────▲───────┘
       │                  │                  │          │
┌──────┴──────┐   ┌───────┴───────┐  ┌───────┴──────┐  ┌┴─────────────┐
│ Host Agent  │   │ WSL Adapter   │  │ Log Pipeline │  │ AI Worker    │
│ (Windows)   │   │ (wsl.exe)     │  │ 正規化・保存 │  │ OpenAI 互換  │
│ プロセス/   │   │ プロセス/     │  │ マスク       │  │ ローカル LLM │
│ ポート/ログ │   │ ポート/ログ   │  │              │  │ 分析・要約   │
└─────────────┘   └───────────────┘  └──────────────┘  └──────────────┘
       │                  │                  │                  │
       └──── 自作 API / ワーカー（Windows / WSL） ─────┘          │
                                                                  │
                              ┌───────────────────────────────────┘
                              ▼
                    メール通知 (SMTP)
```

### 設計原則

1. **AI は「判断の補助」、実行は「決定論的ルール」**
   再起動などの破壊的操作はポリシーエンジンが判断する。LLM にシェルを渡さない。
2. **すべての操作を監査可能に**
   誰が・いつ・何を・なぜ実行したかを `audit_logs` に残す（チーム利用のため必須）。
3. **ローカルファースト**
   単一マシンで完結。SQLite で開始し、必要になったら PostgreSQL へ移行。
4. **段階的に賢くする**
   まずルールベースで動く監視を作り、その上に AI を載せる（AI が落ちても監視は動く）。

---

## 3. 機能要件

### 3.1 ポート管理

| ID   | 機能             | 内容                                                                                                  |
| ---- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| P-01 | 使用中ポート一覧 | ホスト（Windows / WSL） / プロトコル / アドレス / ポート / PID / プロセス名 / コマンド / 使用サービス |
| P-02 | 定期スキャン     | 既定 10 秒間隔。差分をイベント化（`port.opened` / `port.closed`）                                     |
| P-03 | プロセス特定     | PID → 実行パス・コマンドライン・親プロセス・起動時刻                                                  |
| P-04 | ポート予約       | サービスごとに「使用予定ポート」を登録し、起動前に競合を検出                                          |
| P-05 | 競合検出         | 予約済みポートが他プロセスに使われた／起動しようとしたら警告＋ブロック                                |
| P-06 | 解放支援         | 対象 PID の停止（確認ダイアログ＋監査ログ）。強制 kill は明示操作のみ                                 |
| P-07 | 履歴             | ポートの利用履歴（いつ誰が使い、いつ解放されたか）                                                    |

**実装メモ（ホスト抽象化）**

`HostAdapter` インターフェースを定義し、Windows と WSL で実装を差し替える。

```ts
interface HostAdapter {
  id: string; // "windows" | "wsl:Ubuntu-22.04"
  listPorts(): Promise<PortInfo[]>;
  listProcesses(): Promise<ProcessInfo[]>;
  spawnService(svc: ServiceSpec): Promise<ProcessHandle>;
  stopProcess(pid: number, signal: "TERM" | "KILL"): Promise<void>;
  tailLog(source: LogSource): AsyncIterable<LogLine>;
  healthCheck(check: HealthCheck): Promise<HealthResult>;
}
```

- Windows: `Get-NetTCPConnection` / `netstat -ano` + `Get-CimInstance Win32_Process`
- WSL: `wsl.exe -d <distro> -u <user> -- ss -tulpnH` / `ps -eo pid,ppid,lstart,args`
- **WSL 3.x では distro 間でネットワーク名前空間が共有される**（実測: `net:[4026531833]` が一致）。ポートの `scope` は `windows` / `wsl` の 2 種類とし、PID を観測した distro を `pidScope` に持つ
- 停止中の distro を `wsl.exe -d` で叩くと起動してしまうため、**`Running` の distro のみスキャン**する（明示時のみ起動）
- 取得失敗（WSL 停止中など）は `unknown` として UI に明示し、誤って「空きポート」と判定しない

### 3.2 サービス管理

| ID   | 機能                 | 内容                                                                                                                              |
| ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| S-01 | サービス登録         | 名前、ホスト、起動コマンド、cwd、環境変数、期待ポート、ヘルスチェック                                                             |
| S-02 | 起動 / 停止 / 再起動 | API 経由。Agent が実行（許可リストのコマンドのみ、`spawn` に配列で渡す）                                                          |
| S-03 | ヘルスチェック       | HTTP / TCP / プロセス生存 / カスタムコマンド。間隔・タイムアウト・失敗閾値                                                        |
| S-04 | 依存関係             | `depends_on`（例: worker → api）。起動順を制御                                                                                    |
| S-05 | 状態管理             | `stopped` / `starting` / `running` / `degraded` / `restarting` / `failed`                                                         |
| S-06 | 自動起動             | システム起動時、または依存サービス復帰時に起動                                                                                    |
| S-07 | 実行ユーザー         | Windows / WSL それぞれの実行ユーザーを指定（WSL は `-u`）                                                                         |
| S-08 | デプロイ             | 登録済み `deploy` 設定（コマンド / cwd / env / timeout / restartAfter / healthTimeout）を非同期実行。ログは `[deploy]` として保存 |

### 3.3 ログ管理

| ID   | 機能           | 内容                                                                                |
| ---- | -------------- | ----------------------------------------------------------------------------------- |
| L-01 | 収集           | ファイル tail、stdout/stderr キャプチャ、WSL 内ファイル、Windows イベントログ       |
| L-02 | 正規化         | `timestamp, host_id, service_id, level, stream, message, fields(JSON), fingerprint` |
| L-03 | 保存           | SQLite（初期）→ PostgreSQL 移行可能。日次でテーブル分割                             |
| L-04 | 検索           | ホスト・サービス・レベル・期間・全文・正規表現・フィールドで絞り込み                |
| L-05 | ライブ表示     | SSE で tail。レベルフィルタ、一時停止、ハイライト                                   |
| L-06 | ローテーション | 日次 or サイズ上限。保持期間（既定 14 日）・圧縮・削除ポリシー                      |
| L-07 | 秘匿情報マスク | トークン・パスワード・API キーらしき文字列を保存前にマスク（AI 送信前にも再マスク） |
| L-08 | マルチホスト   | Windows と WSL のログを 1 画面で横断表示（ホスト列で区別）                          |

**レベル推定**（構造化ログでない場合）: `ERROR|FATAL|Exception|Traceback` → error、`WARN` → warn、それ以外 → info。誤検知しやすいので後から手動補正できるようにする。

### 3.4 監視・自動復旧

| ID   | 機能           | 内容                                                                               |
| ---- | -------------- | ---------------------------------------------------------------------------------- |
| M-01 | 死活監視       | ヘルスチェック + ハートビート（最終ログ時刻）                                      |
| M-02 | ルール監視     | エラー率、連続失敗回数、特定パターン、クラッシュループ検出                         |
| M-03 | インシデント化 | 同一原因は `fingerprint` で重複排除（既定 10 分ウィンドウ）                        |
| M-04 | 自動再起動     | ポリシーに合致したら指数バックオフで再起動（段階的自動）                           |
| M-05 | 安全装置       | クールダウン、最大試行回数、サーキットブレーカー、承認モード                       |
| M-06 | 復旧検証       | 再起動後 30 秒以内にヘルスチェック成功しなければ「復旧失敗」としてエスカレーション |
| M-07 | 通知           | メール（即時 / ダイジェスト）。検知・復旧・失敗・レポート完成                      |
| M-08 | 承認キュー     | 承認待ちの再起動を UI から承認・却下（メールは通知のみ）                           |

#### 段階的自動の昇格フロー

```
Phase 1: 監視のみ（既定）
  異常検知 → インシデント化 → メール通知 → 人間が判断

Phase 2: 承認付き復旧
  異常検知 → 承認リクエスト（UI の承認画面 + メール通知）
           → 承認され次第 Agent が再起動 → 結果を通知

Phase 3: 自動復旧
  異常検知 → ポリシー評価 → 自動再起動 → 検証 → 結果通知
```

**Phase 3 への昇格条件**（サービス単位で設定）

- 直近 7 日間で誤検知 0 件
- Phase 2 での手動承認・復旧成功が 3 回以上
- 監視対象が自作 API / ワーカーである
- 管理者が明示的に有効化（`auto_restart.enabled = true`）

#### 自動再起動ポリシー（既定値）

```yaml
auto_restart:
  phase: observe # observe | approve | auto
  allowed_services: [] # phase=auto にするサービスを明示
  trigger:
    health_check_failures: 3 # 連続 3 回失敗
    heartbeat_timeout_sec: 120
    process_exit: true # 異常終了コードのみ
  cooldown_sec: 60
  max_attempts: 3 # 10 分あたり
  backoff: [10, 30, 90] # 秒
  verify_timeout_sec: 30
  on_exhausted: escalate # escalate | stop_all
  require_approval: true # phase=approve のとき true
```

**再起動しない条件（重要）**

- 起動直後に同じエラーで落ちる（クラッシュループ）→ 設定不備の可能性が高く、再起動では解決しない
- ポート競合が検出された → 先に競合を解消する
- メモリ不足 / ディスク不足が疑われる → 通知のみ
- WSL ディストロ自体が停止している → 再起動ではなく WSL 起動を別操作として提示
- `phase != auto` のサービス

### 3.5 AI 監視・分析

| ID   | 機能           | 内容                                                                                  |
| ---- | -------------- | ------------------------------------------------------------------------------------- |
| A-01 | トリアージ     | インシデントを重大度・カテゴリに分類                                                  |
| A-02 | 原因仮説       | 周辺ログ・直近のデプロイ・設定差分・類似インシデントから仮説を生成                    |
| A-03 | レポート生成   | Markdown レポート（概要 / 影響 / 根拠ログ / 推定原因 / 推奨対応 / 再発防止）          |
| A-04 | 類似検索       | 過去インシデントとの照合（fingerprint + 埋め込みベクトル）                            |
| A-05 | フィードバック | 人間の「正しかった / 違う」を保存し、プロンプトと閾値を調整                           |
| A-06 | コスト制御     | インシデント時のみ実行、fingerprint 単位でキャッシュ、トークン上限、日次上限          |
| A-07 | プロバイダ設定 | OpenAI 互換 API（LM Studio / Ollama / vLLM など）を `baseURL` + キー + モデル名で登録 |

#### 接続設定（BYOK）

```yaml
ai:
  provider: openai-compatible
  base_url: http://127.0.0.1:1234/v1 # LM Studio の例
  model: local-model
  api_key: "" # ローカルなら空でも可。保存時は暗号化
  max_input_tokens: 8000
  temperature: 0.2
  timeout_sec: 60
  daily_request_limit: 200
  send_logs_externally: false # 既定 false。true にした場合のみクラウドへ
```

- API キーは **AES-256-GCM で暗号化して保存**（鍵は OS の資格情報ストア or ローカル鍵ファイル）
- 接続テスト機能（`POST /api/ai/test`）でモデル一覧と疎通を確認
- ランタイムは未定のため、**LM Studio / Ollama / vLLM のいずれでも動く OpenAI 互換クライアント**として実装。モデル名・コンテキスト長は設定画面で入力する
- ローカル LLM が落ちている場合は分析をスキップし、ルールベースのレポート（テンプレート）を生成

#### パイプライン

```
ログ/ヘルスイベント
   ↓
[1] 正規化・fingerprint 付与
   ↓
[2] ルールエンジン（決定論的）── 異常なし → 終了
   ↓ 異常あり
[3] インシデント作成（重複排除）
   ↓
[4] 自動復旧ポリシー評価（observe / approve / auto）
   ↓
[5] AI 分析ジョブ（非同期キュー）
    入力: インシデント前後のログ（最大 200 行）/ マスク済み概要 / 類似インシデント
    出力: JSON (severity, category, root_cause, evidence[], actions[], confidence)
   ↓
[6] レポート生成（Markdown）→ 保存 → UI 表示 / MD・JSON ダウンロード
    （メール送信は後回し）
   ↓
[7] 監査ログ + フィードバック収集
```

#### AI 出力スキーマ（JSON 強制）

```json
{
  "severity": "critical",
  "category": "dependency_failure",
  "summary": "DB 接続プール枯渇により API が 500 を返している",
  "root_cause_hypothesis": "コネクションが解放されていない可能性が高い",
  "evidence": [
    { "log_id": "lg_123", "quote": "TimeoutError: connection pool exhausted" }
  ],
  "recommended_actions": [
    { "type": "restart", "target": "api", "risk": "low" },
    { "type": "investigate", "detail": "pool 解放処理の確認", "risk": "none" }
  ],
  "confidence": 0.72,
  "needs_human": true
}
```

**AI に渡さないもの**: シェル実行権限、本番 DB への直接アクセス、シークレット（送信前にマスク）。`recommended_actions` はあくまで提案で、実行はポリシーエンジン経由。

### 3.6 WSL 連携

| ID   | 機能           | 内容                                                                                                                       |
| ---- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| W-01 | ディストロ検出 | `wsl.exe -l -v` で名前・状態（Running / Stopped）を取得。UI の「ホスト検出」から選択して登録（名前は決め打ちしない）       |
| W-02 | コマンド実行   | `wsl.exe -d <distro> [-u <user>] [--cd <cwd>] -- [env K=V...] <cmd> <args...>`（シェル文字列を組み立てない）               |
| W-03 | ポート取得     | `ss -H -tulpn` をパース。**ネットワーク名前空間は distro 間で共有**されるため、WSL 全体で 1 つのポート一覧にマージする     |
| W-04 | PID の帰属     | ポートスキャンでは `pidScope`（PID を観測できた distro）を記録。他 distro からは `pid=null` に見える                       |
| W-05 | ログ収集       | `wsl_file` は 1 秒ポーリングで `stat -c %s` と `tail -c +N` を使い、追記分だけ取り込む（`tail -F` は使わない）             |
| W-06 | 停止           | サービスは `wsl.exe` の Windows PID を保存し、`taskkill /PID <pid> /T /F` でプロセスツリーごと停止（Linux PID は使わない） |
| W-07 | パス変換       | Windows パス ⇔ `/mnt/c/...` の変換ユーティリティ                                                                           |

**実測で判明した注意点**

- WSL 3.0.3.0 では全 distro が同じネットワーク名前空間を共有する（`/proc/self/ns/net` の inode が一致）。ポートを distro ごとに分けて表示すると重複する
- PID 名前空間は distro ごとに独立。`ss -p` で PID が見えるのは、そのプロセスを所有する distro 内だけ
- Windows 側には WSL のポートが `wslrelay.exe`（または `System`）として現れる。**同じポートが WSL 側にもある場合はフォワーディングと注記**する（実測: 34567 が `wslrelay.exe` として見え、`http://127.0.0.1:34567` に到達）
- 停止中の distro に `wsl.exe -d` を実行すると起動してしまう。監視スキャンは `Running` のみ対象にし、起動は明示操作にする
- WSL はアイドルで自動停止する。「サービス停止」ではなく「WSL 停止」という別状態として扱い、自動再起動の対象外にする
- `wsl.exe` の出力はパイプ経由で UTF-16LE + BOM。BOM / NUL 密度で判定してデコードする
- WSL サービス起動に `sh -c` ラッパーを使うと、`wsl.exe` の引用処理で `code=126` になる。コマンドは配列のまま直接渡す
- サービス停止は `wsl.exe` の Windows PID を `taskkill /T /F` する。実機で Linux 側プロセスも終了することを確認済み
- WSL 内に常駐エージェントを置く方式は将来の拡張。初期は `wsl.exe` 呼び出しで十分（プロセス数が少ない前提）

---

## 4. 非機能要件

| 項目         | 要件                                                                           |
| ------------ | ------------------------------------------------------------------------------ |
| 性能         | 10 サービス / 毎秒 1,000 行のログを処理。ダッシュボード初期表示 2 秒以内       |
| 同時利用     | チーム 5 ユーザー程度（社内 LAN / localhost）。SSE 同時接続 10 程度            |
| 可用性       | 監視は AI 障害時も継続。API 再起動で監視が止まらない構成（Agent は別プロセス） |
| 保存期間     | ログ既定 14 日（設定可）、インシデント・レポートは無期限                       |
| セキュリティ | 既定 `127.0.0.1` バインド、セッション認証、実行コマンド許可リスト、監査ログ    |
| 通知         | メール到達失敗時は 3 回リトライし、失敗を監査ログに記録                        |
| 拡張性       | ホスト・ログソース・通知先・AI プロバイダをプラグイン化                        |
| 移植性       | Windows + WSL を第一対応。Linux ネイティブは同一 `HostAdapter` で追加可能      |

---

## 5. 技術選定

| 層             | 選定                                                | 理由                                                             |
| -------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| 言語           | TypeScript（Node.js 22+）                           | フロントと型を共有、エコシステムが広い                           |
| パッケージ管理 | pnpm workspace                                      | モノレポの依存管理が軽い                                         |
| API            | Fastify                                             | 軽量・高速・JSON Schema バリデーション                           |
| DB             | SQLite（better-sqlite3）→ PostgreSQL                | 単一マシンで zero-config 開始                                    |
| ORM            | Drizzle ORM                                         | 型安全、マイグレーションが軽い                                   |
| 認証           | Argon2id（hash-wasm）+ DB セッション                | 既存 ER に直結。ロール・監査・レート制限を自前で制御（ADR 0001） |
| UI             | Next.js (App Router) + Tailwind + shadcn/ui         | ダッシュボード構築が速い                                         |
| リアルタイム   | SSE                                                 | ログ tail に十分、実装が単純                                     |
| スケジューラ   | node-cron + DB ジョブテーブル                       | Redis 不要で開始                                                 |
| ログ収集       | `fs.watch` + `readline`、`wsl.exe` 経由の `tail -F` | 追加依存を最小化                                                 |
| AI             | `openai` SDK（`baseURL` 差し替え）                  | OpenAI 互換なら LM Studio / Ollama / vLLM すべて対応             |
| メール         | nodemailer（任意の SMTP + STARTTLS/TLS）            | プロバイダ未定のため汎用実装。設定画面 + 接続テスト              |
| テスト         | Vitest + Playwright                                 | 単体・E2E                                                        |
| 起動           | `pnpm dev`（concurrently）+ セットアップスクリプト  | 手動起動方針に合わせる                                           |

---

## 6. データモデル（主要テーブル）

```
users
  id, email, name, password_hash(argon2id), role(admin|operator|viewer),
  is_active, last_login_at, created_at

sessions
  id, user_id, token_hash, expires_at, user_agent, ip, created_at

hosts
  id, kind(windows|wsl), name, distro(NULL), default_user, enabled

hosts
  id, kind(windows|wsl), name, distro(NULL), default_user, enabled
  -- windows は 1 件。wsl は distro ごとの実行ターゲット

services
  id, host_id, name, command(JSON array), cwd, env(JSON), expected_ports(JSON),
  health_check(JSON), deploy(JSON: command/cwd/env/timeoutSec/restartAfter/healthTimeoutSec),
  depends_on(JSON), auto_start, auto_restart_phase, status,
  last_deploy_at, last_deploy_status(running|succeeded|failed), last_deploy_error,
  created_at, updated_at

ports
  id, scope(windows|wsl), pid_host_id(NULL, PID を観測した WSL distro),
  protocol, address, port, pid, process_name, process_path,
  command_line, service_id(NULL), first_seen, last_seen

port_reservations
  id, scope(windows|wsl), port, protocol, service_id, note, created_at

log_sources
  id, host_id, service_id, type(file|stdout|wsl_file|eventlog), config(JSON), enabled

log_events
  id, host_id, service_id, ts, level, stream, message, fields(JSON), fingerprint

incidents
  id, service_id, fingerprint, title, severity, status(open|acked|approval|resolved),
  started_at, resolved_at, detected_by, restart_attempts, summary

incident_events
  id, incident_id, ts, type, payload(JSON)

approvals
  id, incident_id, requested_action(JSON), status(pending|approved|rejected|expired),
  requested_at, decided_by, decided_at, note

ai_analyses
  id, incident_id, provider, model, prompt_version, input_tokens,
  output_tokens, result(JSON), confidence, latency_ms, created_at

reports
  id, incident_id, format(markdown|json), body, created_at

report_deliveries
  id, report_id, channel(email), to_addr, status(sent|failed), error, sent_at

actions
  id, incident_id, service_id, type(start|stop|restart|kill|deploy), status,
  requested_by, approved_by, policy_id, started_at, finished_at, error

policies
  id, name, scope(JSON), rules(JSON), enabled, priority

audit_logs
  id, actor_user_id(NULL), actor_label, action, target, before(JSON),
  after(JSON), reason, ip, ts

settings
  key, value(JSON), updated_at      -- SMTP, AI, 保持期間など（秘密値は暗号化）
```

インデックス方針: `log_events(host_id, service_id, ts)`、`log_events(fingerprint, ts)`、`incidents(fingerprint, started_at)`、`ports(scope, port, protocol)`、`sessions(token_hash)`。

---

## 7. API 設計（抜粋）

```
# 認証 / ユーザー
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/users                      admin のみ
POST   /api/users                      admin のみ
PATCH  /api/users/:id                  admin のみ

# ホスト
GET    /api/hosts                      Windows / WSL 一覧と状態
POST   /api/hosts                      WSL ホスト登録（admin）
PATCH  /api/hosts/:id                  WSL ホスト更新・有効化（admin）
POST   /api/hosts/wsl/detect           WSL ディストロ検出（admin）

# ポート
GET    /api/ports?host=
GET    /api/ports/history?host=&port=3000
POST   /api/ports/reserve
DELETE /api/ports/reserve/:id
POST   /api/ports/:port/kill           要確認トークン + operator 以上

# サービス
GET    /api/services
POST   /api/services                   admin
GET    /api/services/:id
PATCH  /api/services/:id               admin
DELETE /api/services/:id               admin（論理削除）
POST   /api/services/:id/start         operator 以上
POST   /api/services/:id/stop          operator 以上
POST   /api/services/:id/restart       operator 以上
POST   /api/services/:id/deploy        operator 以上（登録済み deploy 設定を非同期実行、202）
GET    /api/services/:id/health

# ログ
GET    /api/logs?host=&service=&level=&q=&from=&to=&limit=
GET    /api/logs/stream                SSE
GET    /api/logs/sources
POST   /api/logs/sources               admin
PATCH  /api/logs/sources/:id           admin
DELETE /api/logs/sources/:id           admin

# インシデント / 承認 / レポート
GET    /api/incidents?status=&severity=
GET    /api/incidents/:id               詳細（最新 analysis / report を含む）
POST   /api/incidents/:id/ack
POST   /api/incidents/:id/resolve
POST   /api/incidents/:id/analyze       手動で AI 分析をキュー投入（202）
GET    /api/incidents/:id/analysis      最新の AI 分析とレポート
GET    /api/approvals?status=pending
POST   /api/approvals/:id/approve
POST   /api/approvals/:id/reject
GET    /api/reports?incidentId=&limit=&offset=
GET    /api/reports/:id
GET    /api/reports/:id/export?format=md|json
POST   /api/reports/:id/send            メール再送（後回し・未実装）

# 設定 / 監査
GET    /api/policies
PUT    /api/policies/:id
GET    /api/settings/mail              admin のみ（秘密値はマスク）
PUT    /api/settings/mail
POST   /api/settings/mail/test
GET    /api/settings/ai                admin のみ（API キーは真偽のみ）
PUT    /api/settings/ai
POST   /api/ai/test                    接続テスト
GET    /api/settings/retention         admin のみ
PUT    /api/settings/retention         admin のみ
GET    /api/audit-logs                 admin のみ（actor/action/target/from/to）
POST   /api/admin/backup               admin のみ（SQLite オンラインバックアップ）
```

エラーは RFC 7807（Problem Details）形式。破壊的操作は `Idempotency-Key` と確認トークンを要求する。

承認は **UI のみ**。メールには承認待ちの通知とアプリへのリンクを載せる（署名付きワンクリック承認は将来対応）。

### ロール権限

| 操作                         | viewer | operator | admin |
| ---------------------------- | ------ | -------- | ----- |
| ダッシュボード・ログ閲覧     | ○      | ○        | ○     |
| インシデント ack / resolve   | -      | ○        | ○     |
| サービス起動 / 停止 / 再起動 | -      | ○        | ○     |
| ポート kill                  | -      | ○        | ○     |
| 承認の実行                   | -      | ○        | ○     |
| サービス・ポリシー・設定変更 | -      | -        | ○     |
| ユーザー管理・監査ログ       | -      | -        | ○     |

---

## 8. 画面構成

0. **ログイン** — メール + パスワード。セッション Cookie
1. **ダッシュボード** — サービス状態カード（ホスト別）、直近インシデント、ポート使用状況、自動復旧の成否、承認待ち件数
2. **ポート** — ホストタブ（Windows / WSL）、テーブル（ポート / プロセス / サービス / 状態）、予約管理、競合一覧、kill 操作
3. **サービス** — 一覧 + 詳細（設定、ヘルス履歴、ログ、再起動履歴、ポリシー、自動化フェーズ）
4. **ログ** — ホスト・サービス選択、ライブ tail、検索、レベルフィルタ、前後コンテキスト、AI 分析ボタン
5. **インシデント** — タイムライン、AI レポート、関連ログ、実行されたアクション、ack / resolve
6. **レポート** — 一覧、Markdown プレビュー、ダウンロード、メール再送
7. **承認** — 承認待ち一覧、対象サービス・理由・根拠ログを確認して承認 / 却下
8. **設定** — ポリシー、メール（SMTP）、AI プロバイダ、保持期間、許可コマンド、ユーザー管理

> チーム利用のため、一覧画面には「最終操作者」と「更新時刻」を表示し、操作の帰属を可視化する。

---

## 9. セキュリティ・安全設計

- **認証**: メール + パスワード（Argon2id）。セッションは HttpOnly / SameSite=Lax / Secure（HTTPS 時）。ログイン試行のレート制限。
- **認可**: 3 ロール。API 側で必ず検証（UI の非表示だけに頼らない）。
- **CSRF**: 状態変更 API は CSRF トークンまたは `SameSite` + Origin 検証。
- **コマンド実行の許可リスト**: サービス登録時に「実行可能なコマンド」を明示。任意文字列のシェル実行は禁止（`spawn` に配列で渡す）。WSL も同様。
- **AI に実行権限を与えない**: LLM の出力は提案のみ。実行判断はポリシーエンジン。
- **プロンプトインジェクション対策**: ログ本文は「データ」として明示的に区切り、指示として解釈させない。出力は JSON Schema で検証。
- **シークレット保護**: 保存前・AI 送信前の二段マスク。`.env` の内容は AI に送らない。SMTP パスワードと AI API キーは AES-256-GCM で暗号化。
- **メール**: STARTTLS 必須（許可したローカル SMTP を除く）。SMTP は設定画面で登録し、保存前に接続テストを必須化。証明書検証は無効化しない。送信内容にシークレットを含めない。
- **監査**: 破壊的操作（kill / restart / 設定変更 / 承認）は必ず記録。取り消し不能操作は確認 UI を挟む。
- **暴走防止**: 再起動のクールダウン・上限・サーキットブレーカー。AI 呼び出しの日次上限。
- **公開範囲**: 既定は `127.0.0.1`。チーム共有で LAN に出す場合は TLS リバースプロキシを必須とし、README に明記する。

---

## 10. マイルストーン

| フェーズ                         | 期間目安 | 内容                                                                                                                | 完了条件（DoD）                                                                                                    |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **M0: 設計確定**                 | 完了     | 要件確定（v0.3 で完了）、ER 図、OpenAPI、画面ワイヤー                                                               | 要件は確定済み。ER 図と API 定義がレビュー済みになること                                                           |
| **M1: 基盤 + 認証 + ポート**     | 2 週     | モノレポ、API、DB、認証/ロール、HostAdapter、ポートスキャン、予約・競合検出                                         | ログインして 2 ホストのポートが 10 秒以内に反映され、競合を起動前に検出できる                                      |
| **M2: サービス + ログ + WSL**    | 完了     | サービス CRUD、起動/停止、ヘルスチェック、ログ収集・検索・tail、WSL 連携                                            | UI から Windows / WSL のサービスを起動し、ログを 1 秒以内に tail 表示できる（達成）                                |
| **M3: 監視 + 自動復旧 + メール** | 完了     | ルールエンジン、インシデント、承認キュー、再起動 + 検証、メール通知                                                 | プロセスを kill すると 30 秒以内に検知し、Phase 2 で承認 → 再起動 → 復旧通知まで通る（達成）                       |
| **M4: AI 分析 + レポート**       | 完了     | AI ジョブ、接続設定、トリアージ、原因仮説、Markdown レポート、類似検索                                              | インシデントから非同期で分析・レポート生成し、失敗時もルールベースで保存できる（達成。メール送信は後回し）         |
| **M5: 運用強化**                 | 完了     | 監査ログ UI、保持期間、コスト制御、バックアップ、ドキュメント、Phase 3 昇格                                         | 監査・保持期間・バックアップ・昇格手順が揃い、統合スモーク 86 checks が通る（達成。1 週間連続稼働は運用で確認）    |
| **M6: デプロイ連携**             | 完了     | サービス単位の `deploy` 設定、非同期デプロイ action、`[deploy]` ログ、再起動 + ヘルス確認、UI / API / demo-api 統合 | UI から `deploy.ps1` を実行し、成功後にサービスが再起動・healthy になり、deploy ログと最終状態を確認できる（達成） |

**合計: 約 9〜10 週間**（1 人・兼業想定）。M1〜M3 だけで「監視 + 承認付き復旧」は成立するため、AI は後から載せられる。

### 実装順チェックリスト

> 2026-10-25 時点で M0〜M2 を再確認済み。M0 の SMTP / LLM / WSL 設定値項目以外に未完了項目はない。

- [x] M0: 要件ヒアリング（環境・対象・スタック・AI・通知・利用者・常駐）
- [x] M0: 追加ヒアリング（承認導線・保持期間）
- [ ] M0: セットアップ値の決定（SMTP / LLM / WSL）※ M1 と並行可
- [x] M0: ER 図と OpenAPI 定義を作る → `docs/ER.md`, `docs/openapi.yaml`
- [x] M1: モノレポ初期化（`apps/api`, `apps/web`, `apps/agent`, `packages/*`）
- [x] M1: DB マイグレーション基盤（Drizzle + SQLite、19 テーブル）
- [x] M1: 認証・ロール・セッション（Argon2id / DB セッション / レート制限 / 監査）→ `docs/adr/0001-auth.md`
- [x] M1: スパイク（Windows + WSL ポートスキャン）→ `docs/spike/portscan-findings.md`
- [x] M1: HostAdapter（Windows）+ ポートスキャナ
- [x] M1: HostAdapter（WSL）+ ディストロ検出
- [x] M1: ポート一覧 UI（Next.js ダッシュボード）
- [x] M1: ポート予約 + 競合検出（protocol + port / Windows-WSL 横断）
- [x] M1: ポート履歴（opened/closed、停止実行者）
- [x] M1: プロセス詳細（PPID / 開始時刻 / 実行パス / コマンドライン）+ kill（確認トークン / operator 以上 / 監査）
- [x] M1: ホスト管理（Windows 自動 seed / WSL 検出・登録・有効化）
- [x] M1: ユーザー管理（admin 限定 / 最後の管理者保護 / パスワード再設定でセッション無効化）
- [x] M1: CSRF 対策（Origin / Sec-Fetch-Site / `ALLOWED_ORIGINS`）
- [x] M1: スモークテスト（予約・競合・kill・ロール・ホスト・CSRF・パスワードローテーション）
- [x] M2: サービス CRUD とプロセス起動/停止/再起動（Windows / WSL）
- [x] M2: ヘルスチェック（HTTP / TCP / process / command）
- [x] M2: ログ取り込み（stdout / stderr / file / WSL file）
- [x] M2: ログ検索 + SSE tail + 保持期間削除
- [x] M2: サービス管理 UI / ログ検索・tail UI
- [x] M2: スモークテスト（Windows / WSL サービス、ログ、ヘルス、CSRF）
- [x] M3: ルールエンジンと fingerprint（process exit / health / heartbeat / error log / pattern）
- [x] M3: インシデント管理（一覧・詳細タイムライン・ack / resolve）
- [x] M3: 承認キュー + 自動再起動ポリシー + 検証 + サーキットブレーカー
- [x] M3: SMTP 通知（即時 / 接続テスト / 設定画面、パスワード暗号化）
- [x] M3: Incidents / Approvals / Settings UI と統合スモーク（69 checks）
- [ ] M3+: メールダイジェスト集約とレポート再送（後回し: `POST /reports/:id/send` は未実装）
- [x] M4: AI プロバイダ抽象化（OpenAI 互換 / BYOK、DB 設定 + env フォールバック）
- [x] M4: 分析ジョブ + JSON スキーマ検証（非同期キュー、fingerprint 30 分キャッシュ）
- [x] M4: レポート生成 + Markdown / JSON エクスポート（メール送信は後回し）
- [x] M4: マスク処理とコスト制御（日次上限、入力トークン予算、ローカル/外部送信制御）
- [x] M4: インシデント詳細の AI 分析パネルとレポート UI
- [x] M5: 監査ログ UI（admin、actor/action/target/期間フィルタ）
- [x] M5: ログ保持期間の DB 設定 + 定期削除
- [x] M5: SQLite バックアップ（`pnpm db:backup` / `POST /admin/backup`）
- [x] M5: Phase 3（自動復旧）の昇格チェックリスト
- [x] M5: 運用手順書（README 更新）
- [ ] M5: 1 週間の連続稼働確認（運用フェーズで実施）
- [x] M6: `deployConfigSchema` / `services.deploy` / `actions.type=deploy` とマイグレーション
- [x] M6: 非同期デプロイランナー（タイムアウト、ログ取り込み、再起動、ヘルス待機、多重実行防止、起動時 reconciliation）
- [x] M6: `POST /api/services/:id/deploy` / `/services` の deploy 設定・実行・状態表示
- [x] M6: `pwsh` / `powershell` の allowlist 追加とテスト更新
- [x] M6: demo-api の `deploy.ps1` を API 経由で実行し、再起動・healthy・ログ保存を確認

---

## 11. リスクと対策

| リスク                            | 影響                   | 対策                                                                               |
| --------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| AI の誤診断                       | 誤った対応を誘発       | 根拠ログを必ず引用させる。confidence 低は「要確認」表示。自動実行はさせない        |
| 再起動ループ                      | リソース枯渇・障害拡大 | クールダウン、最大試行、クラッシュループ検出で停止                                 |
| ログ量の増大                      | ディスク圧迫・検索劣化 | 保持期間、圧縮、サンプリング、fingerprint 集約                                     |
| AI の応答遅延 / 停止              | レポートが出ない       | タイムアウト、スキップ、テンプレートレポートへのフォールバック                     |
| シークレット漏洩                  | 重大                   | 二段マスク、送信内容のプレビュー、既定で外部送信オフ                               |
| WSL の共有ネットワーク / 重複表示 | 誤った競合判定         | `scope=wsl` でマージし、`pidScope` で帰属。`wslrelay` をフォワーディングとして注記 |
| 停止中 distro の暗黙起動          | 意図しないリソース消費 | `Running` のみスキャン。起動は明示操作（`--start-stopped` 相当）に限定             |
| WSL の自動停止 / UTF-16 出力      | 取得失敗・文字化け     | 「WSL 停止」を別状態として扱い再起動対象外に。BOM/NUL 判定でデコード               |
| メールがスパム判定                | 通知が届かない         | SPF/DKIM 済みの送信元を使う。失敗時は UI にも表示                                  |
| チーム認証の形骸化                | なりすまし             | パスワードポリシー、退職者の無効化、監査ログの定期確認                             |
| 監視自体の停止                    | 無人化の破綻           | 外部ハートビート（Uptime 監視）で sys4sys 自身を監視                               |

---

## 12. ディレクトリ構成（想定）

```
sys4sys/
├─ apps/
│  ├─ api/            # Fastify, routes, auth, services, jobs, mail
│  ├─ web/            # Next.js
│  └─ agent/          # プロセス/ポート/ログ。Windows 実装 + WSL アダプタ
├─ packages/
│  ├─ shared/         # 型, Zod スキーマ, 定数
│  ├─ policy/         # ポリシー評価エンジン
│  ├─ ai/             # OpenAI 互換クライアント, プロンプト, JSON 検証
│  └─ mail/           # テンプレートと送信
├─ docs/
│  ├─ PLAN.md
│  ├─ adr/            # 設計判断の記録
│  └─ runbook.md      # 運用手順
├─ scripts/
│  └─ dev.mjs         # API / Web / Agent の同時起動
└─ package.json
```

---

## 13. 確定事項とセットアップ時設定

### 確定済み

| 項目           | 決定                                                    |
| -------------- | ------------------------------------------------------- |
| 対象環境       | Windows ローカル + WSL                                  |
| 監視対象       | 自作 API / ワーカー                                     |
| スタック       | TypeScript（pnpm モノレポ）                             |
| AI             | ローカル LLM / OpenAI 互換 API / BYOK                   |
| 自動再起動     | 段階的自動（observe → approve → auto）                  |
| 通知           | メール（SMTP）                                          |
| 承認導線       | UI のみ（メールは通知のみ）                             |
| 利用者         | チーム共有（admin / operator / viewer）                 |
| 常駐           | 開発機で手動起動（`pnpm dev`）                          |
| ログ保持       | 既定 14 日（設定で変更可）                              |
| SMTP           | プロバイダ未定 → 汎用 SMTP + 設定画面 + 接続テスト      |
| LLM ランタイム | 未定 → OpenAI 互換で抽象化（LM Studio / Ollama / vLLM） |
| WSL ディストロ | 未定 → `wsl.exe -l -q` で自動検出して登録               |

### セットアップ時に決める値（実装ブロッカーではない）

以下は設定画面または `.env` で入力する。実装はプロバイダ非依存で進められる。

1. **SMTP**: ホスト / ポート / 認証方式 / 送信元アドレス / 通知先。即時 or 5 分ダイジェスト。
2. **ローカル LLM**: `baseURL` / モデル名 / コンテキスト長 / API キー（不要なら空）。
3. **WSL**: ディストロ名と実行ユーザー（検出結果から選択）。
4. **初期監視対象**: サービス名・起動コマンド・cwd・期待ポート（3〜5 個から開始）。
5. **チーム**: 利用人数とロール割当。初回管理者アカウントのメールアドレス。
6. **保持期間**: 既定 14 日を変更するか（ディスク容量と相談）。

---

## 14. 次のアクション

1. ~~M0 の残り成果物~~: 完了。ER 図（`docs/ER.md`）と OpenAPI（`docs/openapi.yaml`）。
2. ~~M1 スパイク~~: 完了。結果は `docs/spike/portscan-findings.md`（WSL の共有ネットワーク・停止中 distro の暗黙起動を確認）。
3. ~~モノレポ初期化・DB・ポートスキャン・一覧 UI~~: 完了。
4. ~~認証・ロール・セッション~~: 完了（`docs/adr/0001-auth.md`）。
5. ~~M1 ポート予約・競合検出・履歴・プロセス停止・ホスト/ユーザー管理・CSRF・UI・テスト~~: 完了。
6. ~~M2 サービス管理（CRUD / 起動停止 / ヘルスチェック / ログ / WSL）~~: 完了。次は **M3 監視 + 自動復旧 + メール**。
7. SMTP / LLM の実値は M3 / M4 の設定画面で入力する。

---

## 15. Web UI/UX overhaul 進捗

詳細計画とフェーズ別ステータスは [`tasks/UI_UX_PLAN.md`](./UI_UX_PLAN.md) を参照してください。

現在の状態:

- `feat/web-uiux` ブランチにフェーズ単位でローカルコミット済み。push は未実施。
- P0 / P1-01 / P1-02 / P1-03 / P2-01 / P2-03 / P2-04 は実装済み。
- P3-02 は Playwright + axe-core による公開画面検証を追加済み。`/login` と未認証 `/` の redirect 画面で axe violations 0、390 / 1440 の Dark / Light 截图、キーボードフォーカス確認、reduced-motion emulation を実施。
- 認証済み dashboard の axe / screenshot matrix は `ADMIN_PASSWORD` が未設定のため自動検証に含まれていない。ログイン済み検証は環境変数または運用アカウントが必要。
- P1-04 / P3-01 のフォーム共通化（Field / Button / Input / Select）は次フェーズとして残っている。
