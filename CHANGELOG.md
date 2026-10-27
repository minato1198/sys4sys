# 変更履歴

## v0.3.0 - 2026-10-27

Web UI / UX 刷新をリリースします。API、DB、認証、監視ロジック、CLI コマンド仕様の変更はありません。

### 追加

- 認証後画面に AppShell を導入し、サイドバー、モバイルドロワー、現在位置表示を追加しました。
- ダッシュボードに StatusRail を追加し、ポート競合、接続障害、WSL relay、未解決インシデント、承認待ちを上部に集約しました。
- ポート台帳を PortTable / PortCard へ分離し、一覧・カードの両方で詳細、履歴、停止操作を出せるようにしました。
- Port Switchboard のための意味論的な状態色と予約 / 競合 / 停止の視覚状態を追加しました。
- スキャン進捗と状態更新の motion を追加しました。
- Playwright と axe-core を使った公開画面のアクセシビリティチェックを追加しました。

### 改善

- サイドバーのグループ見出しを日本語化し、カテゴリ見出しとクリックできるリンクを視覚的に分離しました。
- ポート台帳の操作列を広げ、`詳細 / 履歴 / 停止` を 1 行で表示できるようにしました。
- ダッシュボード、ポート台帳、予約一覧、確認ダイアログの主要ラベルを日本語化しました。
- Light / Dark 共通の semantic color tokens を整理し、Light mode の warning コントラストを改善しました。
- スクリーンショットと plan docs に UI 刷新のステータスを追記しました。

### 修正

- 旧 NavLinks と raw palette classes を廃止し、テーマ token 経由の色指定へ寄せました。
- Light mode で warning バッジのコントラストが axe-core の基準を満たさない問題を修正しました。

### リリース

- `sys4sys` CLI package version を `0.2.2` から `0.3.0` へ引き上げました。
- root workspace version を `0.2.0` から `0.3.0` へ引き上げました。
- `@sys4sys/web` package version を `0.1.0` から `0.3.0` へ引き上げました。

## v0.2.2 - 2026-10-27

- npm Trusted Publishing の duplicate transparency-log 再試行用に CLI package version を `0.2.2` へ引き上げました。

## v0.2.0 - 2026-10-26

- CLI platform P2 系、npm 配布、release dry-run、公開 package 検証を追加しました。
