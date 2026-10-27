# sys4sys Web UI/UX 改善計画

- 版: v0.2（実装状況追記）
- 作成日: 2026-10-27 / 更新日: 2026-10-27
- 対象: `apps/web`
- 基準コミット: `1a9f7d4`（IBM Plex フォント変更と UI/UX P0 の一部は未コミット）
- ステータス: P0 主要完了 / P1・P2 着手 / 未コミット
- 実装状況: 14. 実装状況を参照
- 参照:
  - `tasks/PLAN.md`（プロダクト計画）
  - `tasks/CLI_PLATFORM_PLAN.md`（CLI / AI 連携計画）
  - `C:\Users\STEALTH_ICE\.agents\skills\frontend-design\SKILL.md`
  - `C:\Users\STEALTH_ICE\.agents\skills\ui-ux-pro-max\SKILL.md`

---

## 0. この計画の位置づけ

`tasks/PLAN.md` は sys4sys 本体の機能計画である。本計画は、その Web UI に対して、

1. 読みやすさ・操作安全性・アクセシビリティを最低ラインまで引き上げる
2. 「監視ダッシュボードのテンプレート」から、sys4sys 固有の情報設計へ移行する
3. Light / Dark の両方を、単なる色反転ではなく設計されたテーマにする

ための実行計画を、PR 単位まで分解したものである。

### 0.1 前提

- API・DB・認証・監視ロジックは変更しない。UI とフロントエンドの構造だけを対象にする。
- 既存の機能・権限・操作フローを壊さない。
- 実装は段階的に行い、各 Phase で `typecheck` / `build` / 手動確認を通す。
- シークレット、環境変数の値、一時パスワード、セッション Cookie を UI・ログ・計画書に出さない。
- ダッシュボードの確認にはログイン済みセッションが必要。認証情報は表示しない。
- 本計画では実装しない。実装順・変更点・完了条件を固定する。

### 0.2 現状ベースライン

| 領域                     | 現状                                    | 目標                           |
| ------------------------ | --------------------------------------- | ------------------------------ |
| フォント                 | IBM Plex Sans / Mono + 日本語 Yu Gothic | 維持。日本語混植は P2 で再評価 |
| テーマ                   | `data-theme` + `localStorage` + OS 追従 | 維持。Light を再設計           |
| 12px 未満の文字          | 311 箇所（9px 24 / 10px 202 / 11px 85） | 主要 UI で 0                   |
| ALL CAPS + tracking      | 98 箇所                                 | 0（略語・実データを除く）      |
| `font-mono`              | 115 箇所                                | 識別子・数値・コマンドだけ     |
| `rounded-xl` カード      | 41 箇所                                 | 階層に応じて 2〜3 種類へ       |
| トップナビ               | 10 リンクのフラット表示                 | 3 グループ + モバイルドロワー  |
| big number KPI           | 6 個                                    | 0〜2 個 + ステータスレール     |
| エラーバナー             | 成功と同じ緑バナー                      | success / error / info を分離  |
| `window.confirm`         | 2 箇所                                  | 0。アプリ内確認ダイアログ      |
| placeholder コントラスト | light 2.03:1 / dark 2.44:1              | 4.5:1 以上                     |
| ライブリージョン         | ログインの `role="alert"` のみ          | 非同期フィードバック全体       |
| モバイル                 | 10px 操作ボタン、1050px テーブル        | 44px ターゲット、カード/固定列 |

> 数値は `apps/web/app/**/*.tsx` の静的検索による。コントラストは現在のトークン値から算出。

---

## 1. ゴール / 非ゴール

### 1.1 ゴール

1. **読める**: 主要 UI の文字が 12px 以上。本文 14〜16px。低コントラストの placeholder / muted text を排除する。
2. **迷わない**: 現在地、ページ名、主操作、危険操作が一目で分かる。
3. **安全に操作できる**: 停止・削除・予約解除は、対象と影響範囲を示すアプリ内確認を経る。
4. **状態が伝わる**: loading / success / error / empty / conflict が、色だけでなく文言・role・live region で伝わる。
5. **モバイルでも使える**: 390px 幅でページ全体の横スクロールがなく、タッチターゲットが十分な大きさ。
6. **sys4sys 固有の見た目**: Windows / WSL のポート所有と競合を主役にした「Port Switchboard」の情報設計。
7. **テンプレート感の排除**: ALL CAPS ラベル、middle-dot meta、M1 コピー、装飾的な glow、KPI カードの連打を削除。
8. **Light / Dark が同等**: 両テーマでコントラスト・影・面・状態色が破綻しない。

### 1.2 非ゴール

- API・DB・認証・監視・復旧ロジックの変更。
- 新機能の追加（ポートの新規操作、AI 機能、通知など）。
- CLI / MCP の UI 統合。
- 日本語 Web フォントの全面的な導入（Yu Gothic を維持。必要なら P2 で比較）。
- ネイティブアプリ化、PWA 化。
- 全ページの全面的なリニューアル。P0/P1 は共通シェルとダッシュボード / ログインを優先し、他ページは共通化とトークン適用を中心にする。
- 本計画でのコミット・プッシュ。

---

## 2. デザイン方向

### 2.1 コンセプト: **Port Switchboard**

sys4sys の最も固有な題材は「Windows と WSL が同じネットワークを共有し、ポートの所有者と予約が競合する」こと。この関係を画面の主役にする。

- **Windows / WSL = 2 本のレーン**
- **ポート番号 = 背骨**
- **プロセス / PID = 差し込まれたプラグ**
- **予約 = 予約札**
- **競合 = 赤い接続不良**
- 画面全体は「スイッチボード / 配線盤」のように、情報の位置関係で意味を伝える。

ログイン画面や空状態では、補助モチーフとして薄いブループリント調のグリッドを使う。ただし、常時表示の装飾 glow や gradient wash は使わない。

**記憶に残す要素は 1 つだけ**にする。Port Switchboard のレーン / ポート台帳を主役にし、ナビ・カード・フォームは静かにする。

### 2.2 Color tokens

near-black + acid green（`#07090c` + `#4ade80`）は使わない。Cobalt を操作色、緑 / 琥珀 / 赤を状態色として分離する。

| Role              | Light     | Dark      | 用途                             |
| ----------------- | --------- | --------- | -------------------------------- |
| `bg`              | `#F3F5F7` | `#0B1117` | ページ背景                       |
| `surface`         | `#FFFFFF` | `#121A22` | カード / パネル                  |
| `surface-muted`   | `#E9EEF2` | `#18232D` | テーブルヘッダ / 二次面          |
| `text`            | `#111827` | `#E6EDF3` | 本文・見出し                     |
| `text-muted`      | `#526173` | `#9AA8B6` | 補助テキスト                     |
| `border`          | `#CDD7E1` | `#26333F` | 罫線                             |
| `accent`          | `#2457D6` | `#6E9BFF` | リンク / 選択 / 主ボタン / focus |
| `accent-contrast` | `#FFFFFF` | `#071018` | accent 上の文字                  |
| `success`         | `#0F7B5A` | `#3DDC97` | healthy / 予約済み               |
| `warning`         | `#A45A00` | `#F3B24A` | 注意 / approval                  |
| `danger`          | `#B42318` | `#FF7B72` | 競合 / エラー / 破壊的操作       |
| `info`            | `#2457D6` | `#6E9BFF` | 補足情報                         |

ルール:

- `accent` は「操作できるもの」にだけ使う。
- `success` は「正常・予約済み」にだけ使う。主ボタンには使わない。
- `warning` は「注意・承認待ち」にだけ使う。
- `danger` は「競合・失敗・停止」にだけ使う。
- テキストに alpha を掛けない。`text-muted/50` のような指定を廃止する。
- 影は Light / Dark で別トークンにする。Light で `shadow-black/30` を使わない。

### 2.3 Type scale

| Token     | Size / line-height | 用途                      |
| --------- | ------------------ | ------------------------- |
| `caption` | 12 / 18            | 補助情報、テーブルヘッダ  |
| `body-s`  | 13 / 20            | 密度の高いテーブルセル    |
| `body`    | 14 / 22            | 基本本文                  |
| `body-l`  | 16 / 24            | フォーム、説明文          |
| `title-s` | 18 / 26            | カード / セクション見出し |
| `title`   | 24 / 32            | ページタイトル            |
| `display` | 32 / 40            | ログイン / 空状態         |

ルール:

- 12px 未満を使わない。
- ラベルは sentence case。ALL CAPS + letter-spacing をやめる。
- 英字は IBM Plex Sans、データは IBM Plex Mono、日本語は Yu Gothic。
- 数字は `tabular-nums`。コマンド / PID / ポート / 時刻だけ mono。
- 本文の行長は 80ch 未満。日本語は 1 行 35〜45 文字を目安にする。

### 2.4 Layout

- **AppShell**: 左サイドバー 232px + 上部バー 56px。本文は最大 1440px。
- **ナビゲーション**: Observe / Operate / Admin の 3 グループ。
  - Observe: Ports, Services, Logs, Incidents
  - Operate: Approvals, Reports, Hosts
  - Admin: Users, Audit, Settings
- **モバイル**: サイドバーはドロワー。上部バーにメニュー、ページ名、テーマ、ユーザー。
- **Dashboard**:
  1. 上部にステータスレール（競合、API 健康、最終スキャン、主操作）
  2. ポート台帳（主役）
  3. 予約パネル（右サイド / 折りたたみ）
  4. インシデント / 承認は二次情報
- **Login**: 認証だけに集中。ブランドは小さく、マーケティングコピー・M1・環境変数注記を置かない。デスクトップはフォーム + 抽象的なスイッチボード図、モバイルはフォームのみ。

### 2.5 Principles

1. ポート台帳をヒーローにする。
2. 色は意味に使う。装飾に使わない。
3. 強い表現は 1 箇所。他は静かに。
4. 密度は上げるが、12px の床と 44px のタッチターゲットは守る。
5. ALL CAPS、middle-dot meta、M1、`→` 付き CTA を使わない。
6. エラーはエラー、成功は成功。危険操作は危険に見せる。
7. キーボード、スクリーンリーダー、reduced motion を最初から含める。

### 2.6 Generic default との差分

| Generic default              | 本計画                                                |
| ---------------------------- | ----------------------------------------------------- |
| near-black + acid green      | ink / paper + cobalt。緑は成功専用                    |
| KPI カード 4 枚 + 大きい数字 | ステータスレール + ポート台帳                         |
| 同じ角丸カードの連打         | 台帳 / パネル / インラインセクションの 3 階層         |
| ALL CAPS + tracking ラベル   | sentence case + サイズ / ウェイト                     |
| middle-dot meta / M1         | ユーザー向けの日本語コピー                            |
| 装飾 glow / gradient         | ブループリントの薄いグリッド（ログイン / 空状態のみ） |

---

## 3. 優先度と Gate

| Phase  | テーマ           | 目的                                                               | Gate    |
| ------ | ---------------- | ------------------------------------------------------------------ | ------- |
| **P0** | 読みやすさと安全 | 文字・コントラスト・focus・エラー・危険操作・モバイル最低ライン    | P0 Gate |
| **P1** | 構造と作業面     | AppShell、ナビ、ダッシュボード階層、ポート台帳、フォーム、ログイン | P1 Gate |
| **P2** | 固有の identity  | Port Switchboard、コピー、テンプレ chrome 削除、Light mode、motion | P2 Gate |
| **P3** | 一貫性と回帰防止 | 共通コンポーネント、スクリーンショット / axe、ドキュメント         | P3 Gate |

### 3.1 推奨実行順

1. P0-01 → P0-02 → P0-03 → P0-04 → P0-05
2. P1-01 → P1-02 → P1-03 → P1-04 → P1-05
3. P2-01 → P2-02 → P2-03 → P2-04
4. P3-01 → P3-02 → P3-03

P0 を飛ばして P2 の見た目だけを変えない。読みやすさ・focus・エラー表示が直っていない状態で色やカードを変えると、後で作り直しになる。

---

## 4. PR / タスク一覧

| ID    | タイトル                                | 依存         | 目安                     |
| ----- | --------------------------------------- | ------------ | ------------------------ |
| P0-01 | セマンティックトークンとタイプスケール  | -            | 1 PR                     |
| P0-02 | アクセシビリティ基盤                    | P0-01        | 1 PR                     |
| P0-03 | フィードバックと非同期状態              | P0-01        | 1 PR                     |
| P0-04 | 破壊的操作の確認ダイアログ              | P0-02        | 1 PR                     |
| P0-05 | タッチ / モバイル最低ライン             | P0-01        | 1 PR                     |
| P1-01 | AppShell + グループ化ナビ               | P0-01〜05    | 1〜2 PR                  |
| P1-02 | ダッシュボードの情報階層                | P1-01        | 1 PR                     |
| P1-03 | ポート台帳の再設計                      | P1-01        | 2 PR（desktop / mobile） |
| P1-04 | フォーム / 入力コンポーネント           | P0-02, P1-01 | 1〜2 PR                  |
| P1-05 | ログイン画面の簡素化                    | P1-01        | 1 PR                     |
| P2-01 | Port Switchboard のビジュアル実装       | P1-02, P1-03 | 1〜2 PR                  |
| P2-02 | コピーとテンプレ chrome の削除          | P1-01, P1-05 | 1 PR                     |
| P2-03 | Light mode の設計                       | P0-01, P2-01 | 1 PR                     |
| P2-04 | モーションと最終ポリッシュ              | P2-01        | 1 PR                     |
| P3-01 | 共通コンポーネント化と重複排除          | P1 / P2      | 1 PR                     |
| P3-02 | 回帰防止（screenshot / axe / keyboard） | P3-01        | 1 PR                     |
| P3-03 | ドキュメントとロールアウト              | P3-02        | 1 PR                     |

---

## 5. P0: 読みやすさと安全

### P0-01 セマンティックトークンとタイプスケール

**目的**: 色・文字・面・影の意味を固定し、Light / Dark と全ページの変更を安全にする。

**変更**

- `apps/web/app/globals.css`
  - `bg`, `surface`, `surface-muted`, `text`, `text-muted`, `border`, `accent`, `success`, `warning`, `danger`, `info`, `focus` を追加。
  - 既存の `ink` / `mist` / `signal` は移行期間中エイリアスとして残す。
  - `--color-white` の再定義をやめ、`text-primary` などのセマンティック名へ移行。
  - 12 / 13 / 14 / 16 / 18 / 24 / 32 のタイプスケールを定義。
  - Light / Dark で影・border・surface を別トークンにする。
- `apps/web/app/layout.tsx`
  - IBM Plex の読み込みは維持。
  - 日本語 fallback を明示。
- `README.md`
  - テーマ / フォント / トークンの最小説明を追加。

**完了条件**

- [ ] 主要コンポーネントがセマンティックトークンだけを参照している。
- [ ] `text-white` をテーマ依存の本文色に使っていない。
- [ ] Light / Dark の本文・muted text が 4.5:1 以上。
- [ ] 12px 未満のタイプトークンがない。
- [ ] `pnpm --filter @sys4sys/web typecheck` / `build` が通る。

**検証**

```bash
pnpm --filter @sys4sys/web typecheck
pnpm --filter @sys4sys/web build
rg -n "text-white|--color-white" apps/web/app
rg -n "text-\[(9|10|11)px\]" apps/web/app
```

---

### P0-02 アクセシビリティ基盤

**目的**: キーボード・スクリーンリーダー・低視力でも操作できる最低ラインを作る。

**変更**

- focus:
  - `focus:outline-none` を廃止、または `focus-visible` の 2px ring に置き換える。
  - 入力欄は `outline: 2px solid var(--color-focus); outline-offset: 2px`。
  - 現在の `ring-signal-400/10` のような 10% opacity の ring をやめる。
- 見出し:
  - 各ページの `h1` をページ名にする（例: `Ports`, `Services`）。
  - ブランド名は `h1` ではなく、ホームリンク / 小さい wordmark にする。
- ラベル:
  - ポート絞り込み input に visible label または `aria-label` を付ける。
  - placeholder だけのラベルをやめる。
- テーブル:
  - `<th scope="col">` を付ける。
  - 「詳細」に `aria-expanded` / `aria-controls`。
  - 「停止」「履歴」「解除」にポート / PID を含む `aria-label`。
- 装飾:
  - status dot、アイコン、ロゴ装飾に `aria-hidden="true"`。
- ThemeToggle:
  - 安定した accessible name にする。
  - 状態表示（Light/Dark）と action（切り替え）のどちらかに統一。
  - `<nav>` の外へ移動。
- スキップリンク:
  - `<a href="#main">本文へ</a>` を追加。

**完了条件**

- [ ] Tab だけで全操作に到達でき、すべての control に visible focus がある。
- [ ] スクリーンリーダーでページ名・テーブル・操作ボタンの文脈が分かる。
- [ ] placeholder-only の入力がない。
- [ ] 色だけで状態を伝えていない。
- [ ] axe の critical / serious が 0（P3 で自動化）。

**検証**

- キーボードで login → dashboard → table action → dialog → escape を一周。
- `rg -n "focus:outline-none" apps/web/app` を確認。
- `rg -n "aria-expanded|aria-controls|scope=\"col\"" apps/web/app`.

---

### P0-03 フィードバックと非同期状態

**目的**: 成功・失敗・読み込み・空状態を、見た目と支援技術の両方で正しく伝える。

**変更**

- `components/ui/StatusBanner.tsx` を追加。
  - tone: `success` / `error` / `info`
  - `role="status"` / `role="alert"` / `aria-live`
- `apps/web/app/page.tsx`
  - `message` を success 専用にし、error は `errorMessage` に分離。
  - `deleteReservation` / `openHistory` / `killOwner` の catch を error バナーへ。
  - `load()` の開始時に `loading=true`、終了時に false。
  - 再スキャンボタンを `disabled` + spinner / `aria-busy`。
  - テーブル / パネルに `aria-busy`。
- `components/ui/EmptyState.tsx` を追加。
  - 予約なし: 「予約を追加」
  - ポートなし: 「フィルタを解除」「再スキャン」
  - インシデントなし: 「監視設定を確認」
- 10 秒ポーリング:
  - 更新中は静かな progress 表示。
  - ユーザーが行を展開 / dialog を開いている間は、更新で操作を中断しない。

**完了条件**

- [ ] 削除・履歴・停止の失敗が赤い error バナーで出る。
- [ ] 成功 / 失敗が `role` と文言で区別される。
- [ ] 再スキャン中はボタンが押せず、進行中が分かる。
- [ ] 空状態に次の行動がある。
- [ ] 非同期更新がスクリーンリーダーに伝わる。

**検証**

- 予約削除を失敗させ、赤い error が出ることを確認。
- 再スキャンを連打できないことを確認。
- 空状態の CTA をキーボードで実行。

---

### P0-04 破壊的操作の確認ダイアログ

**目的**: 停止・予約解除を、対象と影響範囲が分かるアプリ内確認に置き換える。

**変更**

- `components/ui/ConfirmDialog.tsx` を追加。
  - `<dialog>` または同等の focus trap。
  - title / description / target / impact / confirmLabel / cancelLabel。
  - `danger` tone。
  - Escape / cancel / confirm、focus return。
- `apps/web/app/page.tsx`
  - `window.confirm` を削除。
  - 停止: PID、プロセス名、scope、protocol、port、`KILL` の意味を表示。
  - 予約解除: endpoint、service ID、note を表示。
- 失敗時は dialog を閉じず、error を dialog 内に表示。

**完了条件**

- [ ] `window.confirm` が 0。
- [ ] 危険操作のボタンが danger styling。
- [ ] dialog に対象と影響範囲がある。
- [ ] キーボードで完結し、focus が元のボタンに戻る。
- [ ] 誤操作で即実行されない。

**検証**

```bash
rg -n "window.confirm" apps/web/app
```

- キーボードで dialog を開閉。
- 停止失敗時に dialog 内 error を確認。

---

### P0-05 タッチ / モバイル最低ライン

**目的**: デスクトップ密度をモバイルに持ち込まない。

**変更**

- 操作ボタン:
  - モバイルで最小 44×44px。
  - デスクトップでも 24×24px を下回らない。
- 入力:
  - モバイルで 16px。iOS の自動ズームを防ぐ。
- ナビ / テーマ切替:
  - 10px テキストをやめ、12px 以上 + 十分な padding。
- テーブル:
  - P1-03 でカード / 固定列に置き換える前提で、P0 では横スクロールの affordance を付ける。
- タップ間隔:
  - 8px 以上。

**完了条件**

- [ ] 390×844 でページ全体の横スクロールがない。
- [ ] 主要ボタンが 44px 以上。
- [ ] 入力が 16px。
- [ ] 隣接する操作が 8px 以上離れている。

**検証**

- 390 / 768 / 1024 / 1440 で確認。
- DevTools のモバイルエミュレーションで login / dashboard を操作。

---

## 6. P1: 構造と作業面

### P1-01 AppShell + グループ化ナビ

**目的**: 全ページの共通シェルを作り、ナビゲーションの過密と重複を解消する。

**変更**

- 追加:
  - `components/AppShell.tsx`
  - `components/Sidebar.tsx`
  - `components/PageHeader.tsx`
  - `components/MobileNav.tsx`
- `NavLinks.tsx`
  - 3 グループに分割。
  - アクティブ状態を明確に。
  - ThemeToggle を nav から topbar utility へ。
- 各 `apps/web/app/**/page.tsx`
  - 重複した `<header>` / `NavLinks` / `max-w-7xl` を AppShell に置き換える。
  - ページ名を `h1` に。
- 認証解決前のレイアウトシフト:
  - nav / user block の skeleton を用意。
  - admin リンクの pop-in を抑える。

**完了条件**

- [ ] 全ページが同じ AppShell を使う。
- [ ] ナビが 3 グループ + モバイルドロワー。
- [ ] 現在地が `aria-current` と見た目の両方で分かる。
- [ ] ThemeToggle が nav の外にある。
- [ ] 1024px 未満でドロワーがキーボード / Escape で操作できる。
- [ ] ページごとの `h1` がページ名。

**検証**

- 全ページを 390 / 768 / 1024 / 1440 で確認。
- Tab で nav → main → utility の順を確認。

---

### P1-02 ダッシュボードの情報階層

**目的**: KPI カードの壁をやめ、ポート台帳をファーストビューに出す。

**変更**

- 上部に `StatusRail` を追加。
  - 競合件数
  - API 健康
  - 最終スキャン
  - 主操作「予約を追加」
- 4 つの KPI カードを圧縮。
  - Listening / Reservations / Conflicts / WSL relay を 1 行のメトリクスに。
  - 「大きい数字 + 小さいラベル」のカードを 6 個並べない。
- ポート台帳を予約フォーム / インシデント / 承認より上へ。
- 予約フォームは右サイドパネル / 折りたたみに。
- インシデント / 承認は二次情報として下段へ。

**完了条件**

- [ ] 1440×900 の初期表示で、ステータスレール + ポート台帳のヘッダ + 数行が見える。
- [ ] 競合が 1 つでもあれば、最初の画面で目立つ。
- [ ] KPI カードが 0〜2 個。
- [ ] 予約フォームが台帳の主役を邪魔しない。

**検証**

- 1440×900 / 1024×768 でスクリーンショット。
- 競合あり / なしの両方で確認。

---

### P1-03 ポート台帳の再設計

**目的**: 主作業面を、読みやすく操作しやすい台帳にする。

**変更**

- `apps/web/app/page.tsx` から抽出:
  - `components/ports/PortLedger.tsx`
  - `components/ports/PortTable.tsx`
  - `components/ports/PortCard.tsx`
  - `components/ports/PortFilters.tsx`
  - `components/ports/PortActions.tsx`
- デスクトップ:
  - Scope / Port を固定列。
  - 列: Scope/Port, Process/Owner, Reservation/Conflict, Bind, PID/PPID, Actions。
  - 競合行を danger の左ボーダー / 背景で示す。
  - ソート: port, scope, status。
- フィルタ:
  - All / Conflicts / Reserved / Windows / WSL。
  - 検索は visible label + placeholder。
- モバイル:
  - テーブルではなくカード。
  - Scope, Port, Process, Reservation, 状態, 操作を 1 枚に。
  - 詳細 / 履歴 / 停止は overflow menu か 44px ボタン。
- 操作:
  - 停止は danger。
  - 履歴は secondary。
  - すべてのボタンにポート / PID を含む accessible name。

**完了条件**

- [ ] 390px でカード表示。ページ全体の横スクロールなし。
- [ ] デスクトップで Scope / Port がスクロールしても見える。
- [ ] 競合 / 予約 / 通常が色 + テキストで区別される。
- [ ] フィルタ / ソートがキーボードで操作できる。
- [ ] 行の展開状態が `aria-expanded` で分かる。

**検証**

- 390 / 768 / 1024 / 1440。
- 長いコマンドライン、多数オーナー、予約なし、競合ありのケース。

---

### P1-04 フォーム / 入力コンポーネント

**目的**: ラベル、必須、エラー、ローディングの扱いを統一する。

**変更**

- `components/ui/`:
  - `Field.tsx`（label / hint / error / required）
  - `Input.tsx`
  - `Select.tsx`
  - `Textarea.tsx`
  - `Button.tsx`
- ルール:
  - visible label 必須。
  - required / optional を明示。
  - error は field の直下 + `aria-describedby`。
  - submit 中は disabled + spinner。
  - モバイル入力は 16px。
- 適用:
  - 予約フォーム
  - ログインフォーム
  - フィルタ
  - 触ったページの管理フォーム（hosts / services / users / settings）

**完了条件**

- [ ] placeholder-only の入力が 0。
- [ ] すべての error が該当 field の近くに出る。
- [ ] submit 中の二重送信ができない。
- [ ] モバイルで入力時にズームしない。
- [ ] 必須 / 任意が分かる。

**検証**

- 空 submit / 不正値 / API error / 成功 を各フォームで確認。
- キーボードだけで完了。

---

### P1-05 ログイン画面の簡素化

**目的**: ログイン画面を「認証」という 1 つの仕事に戻す。

**変更**

- 削除:
  - `observe → approve → auto`
  - `local-first AI`
  - `M1 / authentication + port view`
  - `ADMIN_EMAIL` / `ADMIN_PASSWORD` の説明
  - 起動ログの一時パスワードの説明
- 維持:
  - ブランド
  - メール / パスワード
  - エラー
  - テーマ切替
- 追加:
  - 小さな Port Switchboard の抽象図（任意）。
  - 初期管理者の設定は README へのリンク or 管理者への問い合わせ文言。
- モバイル:
  - フォームのみ。マーケティングパネルは出さない。

**完了条件**

- [ ] ログイン画面に開発者向け情報がない。
- [ ] 画面の目的が「サインイン」だけ。
- [ ] エラーが `role="alert"` で出る。
- [ ] モバイルでフォームが最初から見える。

**検証**

- login の Light / Dark / 390 / 1440。
- 成功 / 失敗 / 空 submit。

---

## 7. P2: 固有の identity

### P2-01 Port Switchboard のビジュアル実装

**目的**: sys4sys でしか成立しない画面にする。

**変更**

- ステータスレールとポート台帳に、Windows / WSL の 2 レーン表現を導入。
- ポート番号を視覚的な背骨にする。
- 競合を「接続不良」として表現。
- ロゴ:
  - 汎用的な緑の角丸 `s4s` バッジをやめる。
  - `sys4sys` の wordmark、またはポート / 接続をモチーフにした最小マーク。
- 背景:
  - 常時 glow を削除。
  - ログイン / 空状態だけ薄いブループリントグリッド。
- カード:
  - すべてを同じ角丸カードにしない。
  - 台帳 / パネル / インラインセクションの 3 階層。

**完了条件**

- [ ] ロゴを隠しても sys4sys と分かる。
- [ ] ファーストビューに Windows / WSL の関係が見える。
- [ ] 装飾 glow がない。
- [ ] カードの角丸 / 影 / border が階層に対応している。

**検証**

- 1440×900 の Light / Dark スクリーンショット。
- 競合あり / なし。

---

### P2-02 コピーとテンプレ chrome の削除

**目的**: AI テンプレートの記号を、ユーザー向けの言葉に置き換える。

**変更**

- 削除:
  - ALL CAPS + tracking ラベル
  - `·` でつなぐ meta 文字列
  - `M1` / milestone
  - `→` 付きの説明的コピー
  - `WORD — fragment` 形式
  - 装飾目的の `font-mono`
- 書き換え:
  - ナビ / ページタイトル / セクション見出しを日本語 + sentence case に。
  - 技術識別子（WSL, TCP, PID, service ID）だけ English / mono。
  - error: 「API に接続できません。再試行してください。」
  - empty: 次の行動を書く。
- ログイン:
  - P1-05 のコピーを確定。

**完了条件**

- [ ] `M1`, `observe →`, `backend operations`, `ports · services` が UI にない。
- [ ] ALL CAPS + tracking が 0。
- [ ] mono は識別子 / 数値 / コマンドだけ。
- [ ] コピーが「ユーザーが次に何をするか」を説明している。

**検証**

```bash
rg -n "M1|observe →|backend operations|ports · services" apps/web/app
rg -n "uppercase[^\"]*tracking-\[" apps/web/app
```

---

### P2-03 Light mode の設計

**目的**: Light を Dark の色反転ではなく、独立したテーマにする。

**変更**

- `--color-white` の再定義をやめる。
- Light 用の surface / border / shadow / focus を個別に調整。
- Light の影を `shadow-black/30` から軽い 2 段階へ。
- glow を削除し、必要なら blueprint grid だけ残す。
- 状態色のコントラストを Light / Dark で再確認。
- スクリーンショットで両テーマを並べて確認。

**完了条件**

- [ ] Light で本文 / muted / placeholder が 4.5:1 以上。
- [ ] Light の影が重すぎない。
- [ ] Light / Dark で同じ情報階層。
- [ ] `--color-white` の意味がテーマで変わらない。

**検証**

- login / dashboard / settings の Light / Dark。
- コントラスト計算。

---

### P2-04 モーションと最終ポリッシュ

**目的**: 動きを意味のある場面だけに残す。

**変更**

- 常時 `animate-pulse` を削除。
- スキャン中だけ progress / bar を表示。
- hover / focus の transition は 150〜200ms。
- dialog / drawer の開閉は短く、状態が分かる程度。
- `prefers-reduced-motion` を維持。
- ページロードの装飾アニメーションは追加しない。

**完了条件**

- [ ] 常時点滅する要素がない。
- [ ] 動きは操作 / 状態変化に紐づく。
- [ ] reduced motion で最終状態が即座に出る。
- [ ] 画面切替でレイアウトシフトがない。

---

## 8. P3: 一貫性と回帰防止

### P3-01 共通コンポーネント化と重複排除

- `AppShell`, `PageHeader`, `Sidebar`, `StatusRail`, `PortLedger`, `StatusBanner`, `EmptyState`, `ConfirmDialog`, `Field`, `Button`, `Badge`, `Table` を共通化。
- 各ページの重複 header / nav / card markup を削除。
- `apps/web/app/page.tsx` の UI 部分を分割し、1,000 行以下を目指す。
- 色 / 角丸 / shadow の直書きを減らす。

### P3-02 回帰防止

- スクリーンショットマトリクス:
  - 390×844 / 768×1024 / 1024×768 / 1440×900
  - Light / Dark
  - login / ports / services / incidents / logs / settings
- キーボードウォークスルー:
  - skip link → nav → main → table → dialog → escape → focus return
- axe:
  - critical / serious 0。
  - 依存追加が必要なら事前に確認する。
- `rg` チェック:
  - `text-[9px]` / `text-[10px]` / `text-[11px]`
  - `window.confirm`
  - `uppercase.*tracking-\[`
  - `M1|observe →|backend operations|ports · services`
  - `focus:outline-none`

### P3-03 ドキュメントとロールアウト

- `README.md` に UI 原則、トークン、アクセシビリティ、テーマを追記。
- `tasks/PLAN.md` から本計画へリンク。
- 変更履歴 / 既知の制約を追記。
- 実装完了後に `tasks/UI_UX_PLAN.md` のステータスを更新。

---

## 9. 共通コンポーネント一覧

| Component                       | 役割                               |
| ------------------------------- | ---------------------------------- |
| `AppShell`                      | サイドバー + topbar + main         |
| `Sidebar`                       | 3 グループのナビ                   |
| `MobileNav`                     | ドロワー                           |
| `PageHeader`                    | `h1`、説明、主操作                 |
| `StatusRail`                    | 競合 / API / 最終スキャン          |
| `Metric`                        | 小さな数値表示（KPI カードの代替） |
| `PortLedger`                    | ポート台帳全体                     |
| `PortTable`                     | desktop table                      |
| `PortCard`                      | mobile card                        |
| `PortFilters`                   | scope / status / search            |
| `PortActions`                   | 詳細 / 履歴 / 停止                 |
| `StatusBanner`                  | success / error / info             |
| `EmptyState`                    | 次の行動                           |
| `ConfirmDialog`                 | 破壊的操作                         |
| `Field`                         | label / hint / error               |
| `Input` / `Select` / `Textarea` | フォーム                           |
| `Button`                        | primary / secondary / danger       |
| `Badge`                         | scope / status                     |
| `Table`                         | header / row / sticky column       |

---

## 10. 検証計画

### 10.1 コマンド

```bash
pnpm --filter @sys4sys/web typecheck
pnpm --filter @sys4sys/web build
pnpm exec prettier --check apps/web
```

### 10.2 静的チェック

```bash
rg -n "text-\[(9|10|11)px\]" apps/web/app
rg -n "uppercase[^\"]*tracking-\[" apps/web/app
rg -n "window\.confirm" apps/web/app
rg -n "focus:outline-none" apps/web/app
rg -n "M1|observe →|backend operations|ports · services" apps/web/app
rg -n "text-mist-400/(50|60|70)" apps/web/app
```

目標:

- 12px 未満: 0（主要 UI）
- uppercase + tracking: 0
- `window.confirm`: 0
- `focus:outline-none`: 0（focus-visible に置換）
- テンプレコピー: 0
- alpha 付き muted text: 0

### 10.3 スクリーンショットマトリクス

| Viewport | Light                     | Dark                      |
| -------- | ------------------------- | ------------------------- |
| 390×844  | login / ports             | login / ports             |
| 768×1024 | login / ports             | login / ports             |
| 1024×768 | ports / services          | ports / services          |
| 1440×900 | login / ports / incidents | login / ports / incidents |

P3 では services / logs / settings / approvals も追加。

### 10.4 手動チェック

- [ ] Tab だけで全操作に到達できる。
- [ ] focus が常に見える。
- [ ] Escape で dialog / drawer が閉じる。
- [ ] dialog を閉じた後、元のボタンに focus が戻る。
- [ ] エラーが赤、成功が緑、情報が青。
- [ ] 色だけで状態を伝えていない。
- [ ] 空状態に CTA がある。
- [ ] 390px でページ全体が横スクロールしない。
- [ ] 44px のタッチターゲット。
- [ ] Light / Dark の両方で読める。
- [ ] reduced motion で動きが止まる。

---

## 11. リスク / 注意

| リスク                                       | 対策                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `page.tsx` が 1,372 行あり、抽出で壊しやすい | P1-03 で UI を小さく分割。各 PR で typecheck / build                                  |
| 全ページの header 置換で差分が大きい         | P1-01 を機械的な置換に限定し、見た目の変更を混ぜない                                  |
| トークン移行で Light が壊れる                | 旧トークンをエイリアスとして残し、P0-01 で段階移行                                    |
| ダッシュボード確認にログインが必要           | ローカル管理者セッションを使う。認証情報は出力しない                                  |
| 日本語フォントが重い                         | Yu Gothic を維持。P2 で BIZ UDPGothic 等を比較                                        |
| 依存追加（axe / Playwright）                 | P3 で必要性を確認してから追加                                                         |
| フォント変更が未コミット                     | P0-01 の前に `feat(web): use IBM Plex fonts` として単独コミットするか、P0-01 に含める |

---

## 12. 要確認（実装前に決める）

1. **デザイン方向**: 「Port Switchboard」で進めるか。推奨: 進める。
2. **ナビ**: 左サイドバー + モバイルドロワーか。推奨: サイドバー。
3. **日本語フォント**: Yu Gothic 維持か、P2 で BIZ UDPGothic / Noto Sans JP を比較するか。推奨: P0/P1 は Yu Gothic、P2 で比較。
4. **対象範囲**: P0/P1 は login + ports + 共通シェル、他ページは P3 で揃えるか。推奨: この範囲。
5. **回帰テスト**: Playwright + axe を追加してよいか。推奨: P3 で追加。
6. **フォント変更のコミット**: 先に単独コミットするか、P0-01 に含めるか。推奨: 先に単独コミット。

---

## 13. 完了定義（UI/UX DoD）

- [ ] 主要 UI に 12px 未満の文字がない。
- [ ] 本文 / muted / placeholder が 4.5:1 以上。
- [ ] すべての操作要素に visible focus。
- [ ] すべてのフォームに visible label。
- [ ] success / error / info が色・文言・role で区別される。
- [ ] 破壊的操作がアプリ内確認 + 影響範囲表示。
- [ ] loading / empty / error に次の行動がある。
- [ ] 390px でページ全体の横スクロールがない。
- [ ] モバイルの操作ターゲットが 44px 以上。
- [ ] Light / Dark の両方でコントラストと影が破綻しない。
- [ ] ALL CAPS + tracking / middle-dot meta / M1 / `→` コピーが UI にない。
- [ ] ファーストビューに競合 / ポート台帳がある。
- [ ] `pnpm --filter @sys4sys/web typecheck` / `build` が通る。
- [ ] キーボード / スクリーンリーダー / reduced motion の手動確認済み。
- [ ] スクリーンショットマトリクスで Light / Dark / 4 viewport を確認済み。

---

## 14. 実装状況（2026-10-27）

- 状態: `feat/web-uiux` ブランチでフェーズ単位にローカルコミット中 / push 未実施
- 検証: `pnpm --filter @sys4sys/web typecheck` / `pnpm --filter @sys4sys/web build` / `pnpm exec prettier --write "apps/web/app/**/*.{ts,tsx,css}"` / `http://127.0.0.1:3000/login` / `http://127.0.0.1:8787/api/health` 確認済み

### 14.1 タスク別ステータス

| ID    | 状態   | 完了内容                                                                                                                                                                                                      | 残作業                                                                                                        |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| P0-01 | 完了   | セマンティックトークン追加、placeholder 色、focus トークン、mobile input 16px、danger-solid トークン追加                                                                                                      | セマンティックトークンへの全ページ移行、cobalt パレットへの置換                                               |
| P0-02 | 完了   | `focus:outline-none` / `outline-none` 削除、global `:focus-visible`、`h1` 修正、`scope="col"`、filter label、`aria-expanded` / `aria-controls`、操作ボタン aria-label、装飾 `aria-hidden`                     | axe 自動化、ThemeToggle を AppShell utility へ移動、スクリーンリーダー手動確認                                |
| P0-03 | 完了   | `StatusBanner` 追加、success / error 分離、API error と action error 分離、`role` / `aria-live`、manual refreshing、aria-busy、EmptyState 追加                                                                | 10 秒ポーリングの視覚的 progress、既存インシデント / 承認カードの EmptyState 化、スクリーンリーダー確認       |
| P0-04 | 完了   | `ConfirmDialog` / `useConfirmDialog` 追加。dashboard、services、approvals、logs、incidents の `window.confirm` をアプリ内確認に置換                                                                           | 全 dialog の focus trap 動作をキーボードで手動確認、dialog 内 error の実測確認                                |
| P0-05 | 部分   | mobile で input 16px、主要な操作ボタンに `min-h-9` / `min-h-11`、ThemeToggle mobile 44px 対応、ポート台帳を mobile カード表示へ変更                                                                           | 390×844 でのページ全体の横スクロール実測、隣接タップ間隔の実測、カード overflow action の実測                 |
| P1-01 | 完了   | AppShell 追加。監視 / 運用 / 管理のグループ Sidebar、モバイルドロワー、skip link、共通ログアウト、ThemeToggle utility、全認証ページを AppShell へ移行、旧 NavLinks 削除                                       | ログイン済み状態での sidebar 実測、390 / 1440 の visual regression、モバイルドロワーの focus 往復確認         |
| P1-02 | 完了   | `StatusRail` 追加。競合 / 予約 / 待受 / WSL relay を圧縮メトリクスへ統合、KPI 4 カード廃止、競合詳細とポート台帳をインシデント / 承認より上へ移動、予約フォームを副次的な下段へ移動                           | 1440×900 での初期表示実測、競合あり / なしのスクリーンショット、StatusRail のモバイル折り返し確認             |
| P1-03 | 完了   | `PortLedger` / `PortTable` / `PortCard` / `PortFilters` / `PortActions` を追加。desktop sticky Scope / Port、競合行強調、可視 search / filter / sort、mobile card 表示、履歴 / 停止の accessible name を改善  | 390 / 768 / 1024 / 1440 の視覚確認、長い command line / 複数 owners の実測、sticky 列の影または背景境界の調整 |
| P1-04 | 未着手 | login と一部フォームは改善済み                                                                                                                                                                                | Field / Button / Input / Select 共通化、全フォームへの適用                                                    |
| P1-05 | 完了   | login をサインイン中心に変更。開発者向け env 注記、marketing pills、M1 削除。日本語 sentence case に変更                                                                                                      | Light / Dark / 390 / 1440 のスクリーンショット確認、初期管理者導線の最终文言                                  |
| P2-01 | 部分   | BrandMark を port-spine wordmark へ変更、body の常時 glow を削除、login の s4s バッジを BrandMark へ置換、PortLedger に Windows / WSL / Relay lane counts、競合を「接続不良」と表現、台帳の border 階層を強化 | 1440×900 Light / Dark 実測、競合あり / なしスクリーンショット、ロゴなしでも sys4sys らしいか reviewer 確認    |
| P2-02 | 部分   | ALL CAPS + tracking を全ページで 0 にした。`observe →`、`backend operations`、footer の M1、API 起動コマンド指示を削除                                                                                        | 全見出し / 補助文言の日本語コピーレビュー、mono の目的外使用チェック                                          |
| P2-03 | 部分   | semantic tokens に Light / Dark を追加。placeholder と focus を両テーマで調整                                                                                                                                 | `--color-white` 再定義の完全撤廃、Light の影 / surface / shadow 実測、コントラスト監査                        |
| P2-04 | 部分   | dashboard の status dot から `animate-pulse` を削除                                                                                                                                                           | 他ページの装飾 motion 監査、スキャン progress、reduced motion 手動確認                                        |
| P3-01 | 部分   | StatusBanner / EmptyState / ConfirmDialog / useConfirmDialog / AppShell / StatusRail / PortTable / PortCard / PortLedger を追加。重複 header 撤廃                                                             | Button / Field の共通化、全フォームへの適用                                                                   |
| P3-02 | 未着手 | 静的チェック実施                                                                                                                                                                                              | screenshot matrix、axe / Playwright、キーボードウォークスルー                                                 |
| P3-03 | 部分   | 本計画に実装状況を追記                                                                                                                                                                                        | README 更新、PLAN.md からのリンク、完了後のステータス更新                                                     |

### 14.2 静的チェック結果

```bash
rg -n "text-\[(9|10|11)px\]" apps/web/app -g "*.tsx"
rg -n "text-mist-400/(50|60|70)" apps/web/app -g "*.tsx"
rg -n "outline-none" apps/web/app -g "*.tsx"
rg -n "window\.confirm" apps/web/app -g "*.tsx"
rg -n "uppercase|tracking-\[" apps/web/app -g "*.tsx"
```

- 12px 未満の Tailwind text utility: 0
- alpha 付き `text-mist-400/50|60|70`: 0
- `outline-none`: 0
- `window.confirm`: 0
- `uppercase` class / `tracking-[...]`: 0
- `M1` は SVG path 内にのみ残存。UI 文言としての `M1` は dashboard footer と login から削除済み
- `observe →`, `backend operations`, `ports · services` は UI コピーから削除済み

### 14.3 次の着手タスク

1. P1-02: dashboard の StatusRail とポート台帳優先
2. P1-03: PortTable / PortCard 分割とモバイルカード表示
3. P2-01: Port Switchboard の dashboard 表現
4. P2-03: Light mode の影・面・コントラストの実測
5. P2-04: motion / reduced motion 最終調整
6. P3-02: axe / Playwright / screenshot matrix

### 14.4 P0 / P1-01 の主な変更範囲

- P0: `apps/web/app/globals.css`
- P0: `apps/web/app/layout.tsx`
- P0: `apps/web/app/page.tsx`
- P0: `apps/web/app/login/page.tsx`
- P0: `apps/web/app/components/ThemeToggle.tsx`
- P0: `apps/web/app/components/ui/StatusBanner.tsx`
- P0: `apps/web/app/components/ui/EmptyState.tsx`
- P0: `apps/web/app/components/ui/ConfirmDialog.tsx`
- P0: `apps/web/app/components/ui/useConfirmDialog.tsx`
- P0: services / approvals / logs / incidents / settings / audit のフォームアクセシビリティと destructive action 修正
- P0: MarkdownPreview の table header semantics
- P1-01: `apps/web/app/components/AppShell.tsx`
- P1-01: 旧 `apps/web/app/components/NavLinks.tsx` 削除
- P1-01: dashboard / services / logs / incidents / reports / approvals / hosts / admin users / audit / settings を AppShell へ移行
- P1-02: `apps/web/app/components/StatusRail.tsx`
- P1-03: `apps/web/app/components/ports/` 配下に types / port-utils / PortLedger / PortTable / PortCard / PortFilters / PortActions / PortBadges を追加
- P1-03: dashboard のポート台帳を `PortLedger` へ抽出し、local table utilities / FragmentRow を削除
- P2-01: `apps/web/app/components/BrandMark.tsx`
- P2-01: `apps/web/app/globals.css` から body 常時 glow を削除
- P2-01: `AppShell.tsx` / `login/page.tsx` の brand を port-spine wordmark へ置換
- P2-01: PortLedger / PortCard / PortTable / StatusRail に lane counts と接続不良表現を追加
