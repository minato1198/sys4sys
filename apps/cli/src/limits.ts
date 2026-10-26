/**
 * Shared limits for the CLI and its documentation.
 *
 * Keep docs/cli/PERFORMANCE.md in sync when changing these values.
 */
export const CLI_LIMITS = {
  /** Maximum `logs query --limit`. */
  logQueryMaxLimit: 500,
  /** Default `logs query --limit`. */
  logQueryDefaultLimit: 100,
  /** Maximum reconnects after a log stream closes. */
  logTailMaxReconnectAttempts: 10,
  /** Maximum reconnect backoff in milliseconds. */
  logTailMaxBackoffMs: 30_000,
  /** Maximum rows returned by the MCP log tool. */
  mcpLogMaxLimit: 200,
  /** Maximum API token lifetime in days. */
  tokenMaxTtlDays: 365,
  /** Server-side deploy request lifetime in minutes (24 hours). */
  deployRequestTtlMinutes: 1_440,
} as const;
