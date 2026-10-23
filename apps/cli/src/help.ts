export function printHelp(): void {
  console.log(`sys4sys CLI

Usage:
  sys4sys --help
  sys4sys whoami [--json]
  sys4sys hosts list [--json]
  sys4sys services list [--host <id>] [--status <status>] [--json]
  sys4sys services get <id> [--json]
  sys4sys services create --file <service.json|-> [--dry-run] [--json]
  sys4sys services update <id> --file <patch.json|-> [--dry-run] [--json]
  sys4sys services deploy <id> [--dry-run] [--yes] [--wait] [--timeout <sec>] [--json]

Options:
  --api <url>        API のルート URL (default: http://127.0.0.1:8787)
  --json, -j         JSON で出力
  --show-env         env / deploy.env の値を表示（既定はマスク）
  --dry-run          API を変更せず検証・表示のみ
  --yes, -y          deploy の確認を省略
  --wait             deploy の完了まで待つ
  --timeout <sec>    deploy 待ちのタイムアウト
  --help, -h         このヘルプ

Environment:
  SYS4SYS_API_URL           API のルート URL
  SYS4SYS_EMAIL             ログインメール
  SYS4SYS_PASSWORD          ログインパスワード
  SYS4SYS_SESSION_COOKIE    既存の sys4sys_session Cookie

Examples:
  pnpm sys4sys -- whoami --json
  pnpm sys4sys -- hosts list --json
  pnpm sys4sys -- services list --json
  pnpm sys4sys -- services create --file apps/cli/examples/service.create.json --dry-run
  pnpm sys4sys -- services deploy <id> --dry-run`);
}
