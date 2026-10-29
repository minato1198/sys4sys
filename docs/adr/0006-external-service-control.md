# ADR 0006: 外部 Windows サービスは SCM サービス名を同一性とし、deploy の stop/start 所有者を一意化する

- 状態: Accepted
- 日付: 2026-10-29
- 対象: `apps/api`, `apps/web`, `apps/cli`, `packages/shared`

## 背景

NSSM / WinSW / ネイティブ Windows サービスは、sys4sys が `spawn()` した子プロセスとして管理できない。

- サービスの PID は SCM / NSSM の再起動で変化する。
- NSSM のラッパー PID はアプリ本体 PID と一致しないことがある。
- `taskkill` で NSSM が監視するプロセスを kill すると、NSSM が自動再起動する。
- deploy スクリプトが stop / start を担当する場合、sys4sys が `restartAfter=true` で再起動すると二重制御になる。

## 決定

1. `services.control_mode` を `spawn` / `windows-service` に分ける。
2. `windows-service` の同一性は `services.service_name` とする。PID は診断用の観測値であり、停止操作の基準にしない。
3. 外部サービスの start / stop / restart は常に sys4sys の Windows service controller 経由とし、SCM には `sc.exe` を使う。外部サービスでは `taskkill` を使わない。
4. deploy の stop / start 所有者は `deploy.service_control_owner` で `sys4sys` / `script` のどちらか 1 つに固定する。
   - `sys4sys`: SCM stop → deploy.command → SCM start → health。
   - `script`: deploy スクリプトが stop / start / health を担当し、sys4sys は deploy 中に stop / start しない。
5. 手動 start / stop / restart は `service_control_owner` に関係なく sys4sys controller が担当する。
6. API 起動時、stale deploy reconciliation を service reconciliation より先に行い、deploy 中サービスの状態を上書きしない。
7. `SELF_SERVICE_NAME` を設定すると、sys4sys 自身の service に対する stop / restart / deploy を拒否する。

## 結果

- 外部サービスでは、SCM 起動種別が boot ownership を担当するため `services.auto_start` を使用しない。
- sys4sys と deploy wrapper が同時に stop / start しないことを `SYS4SYS_SERVICE_CONTROL` で保証する。
- deploy 中は手動 lifecycle、incident 自動再起動、ports kill を 409 またはスキップで止める。
- 同一サービスの pending / running deploy は DB の partial unique index と API の local lock で防止する。
- 外部サービスの実行ログは NSSM / WinSW のファイルログを `log_sources` 経由で取り込む。
- 外部サービスでも既存の `spawn` 管理サービスと WSL 管理は変更しない。
