const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_TOKEN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const URL_CREDENTIALS = /\b(https?|wss?):\/\/[^/\s:@]+:[^@\s/]+@/gi;
const DB_CREDENTIALS =
  /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|mssql):\/\/[^/\s:@]+:[^@\s/]+@/gi;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|private[_-]?key))\b(\s*[:=]\s*)(["']?)([^\s"',;]{3,})\3/gi;

/**
 * AI に送る前のログ・概要から、代表的なシークレット表現を除去する。
 * 完璧な DLP ではなく、誤送信のリスクを下げるための多層防御。
 */
export function maskText(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(BEARER_TOKEN, "$1 ***")
    .replace(JWT_TOKEN, "[REDACTED JWT]")
    .replace(OPENAI_KEY, "sk-***")
    .replace(AWS_ACCESS_KEY, "AKIA***")
    .replace(GITHUB_TOKEN, "ghp_***")
    .replace(SLACK_TOKEN, "xox-***")
    .replace(DB_CREDENTIALS, "$1://***:***@")
    .replace(URL_CREDENTIALS, "$1://***:***@")
    .replace(SECRET_ASSIGNMENT, "$1$2***");
}

/** 1 行が長すぎる場合に切り詰める。 */
export function truncateLine(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** ログ行をまとめてマスクし、1 行あたりの長さも制限する。 */
export function maskAndTrimLines(lines: string[], maxChars = 2000): string[] {
  return lines.map((line) => truncateLine(maskText(line), maxChars));
}
