# ADR 0003: CLI の資格情報は API トークン優先、必要ならファイル保存する

- 日付: 2026-10-25
- 状態: 採用

## 背景

sys4sys CLI は CI・開発者ワークステーション・運用端末から API を操作する。トークンを毎回引数で渡すのは、シェル履歴・プロセス一覧・CI ログに残る可能性がある。一方で、資格情報を平文ファイルに保存すると Git やバックアップに混入するリスクがある。

既存の Web API には人間向けのセッション Cookie 認証もあるが、CLI 自动化では API トークン（ADR 0002）を第一選択にしたい。

## 決定

**CLI の資格情報解決は環境変数・ファイル入力を優先し、明示的な保存操作だけをファイルに書き出す。**

優先順位:

1. `SYS4SYS_API_URL` / `--api`
2. `SYS4SYS_TOKEN`
3. `SYS4SYS_TOKEN_FILE`
4. 保存済み API トークン
5. `SYS4SYS_SESSION_COOKIE`
6. 保存済みセッション Cookie
7. `SYS4SYS_EMAIL` + `SYS4SYS_PASSWORD`

保存ファイル:

- 保存先は `SYS4SYS_CONFIG_DIR/credentials.json` があればそこ
- Windows は既定で `%APPDATA%\sys4sys\credentials.json`
- macOS / Linux は `$XDG_CONFIG_HOME/sys4sys/credentials.json` または `~/.config/sys4sys/credentials.json`
- Unix ではファイル `0600`、ディレクトリ `0700` を目指す。Windows は ACL を絞れる範囲で絞り、広い場合は警告する
- 一時ファイルに書いて rename する。壊れた JSON は勝手に削除せず、ユーザーに確認を求める
- `auth logout` は保存済み資格情報を削除し、可能なら API の logout / token revoke を呼ぶ

CLI 側で新しい API トークンを発行するときは、環境変数または secret store へ移す前提とし、`credentials.json` に保存するかどうかは明示的な `--save` などの操作でのみ行う。`--token` はシェル履歴・プロセス一覧に残す可能性があるため採用しない。

## 理由

- CI では環境変数またはファイル経由で注入でき、Git 管理対象外にしやすい
- 人間向けの対話運用では保存済みトークン/Cookie を使える
- 保存時は別方式を置き換えることで、古いセッションと強いトークンの混在を防げる
- 壊れたファイルは即削除しないため、誤って認証手段を失いにくい
- API 認証・スコープ・監査の中心は ADR 0002 の Bearer token 側に置ける

## 代替案

- OS keyring を主記憶にする案は安全面で有利だが、CI・WSL・Windows・macOS/Linux で運用差が大きく、まずは portable な file fallback を採用した。keyring 連携は将来の改善として検討する
- `SYS4SYS_PASSWORD` を保存する案は、認証失敗時の再ログインは楽になるが、ユーザーパスワードを永続化するため却下した。CLI は password 環境変数を一時的に受け取るだけで、通常保存しない
- 引数で直接トークンを受け取る案は、シェル履歴と `ps` 露出が危険なため却下

## 運用上の注意

- `credentials.json` は Git 管理対象外にする
- 配布アーカイブ、バックアップ、ログ、Issue、PR に `credentials.json` を含めない
- CI では `SYS4SYS_TOKEN` または `SYS4SYS_TOKEN_FILE` を優先する
- 保存済みトークンを使う端末では、OS のディスク暗号化とユーザーアクセス制御を前提にする
- 共用端末では `auth logout` を使い、不要な資格情報を残さない
