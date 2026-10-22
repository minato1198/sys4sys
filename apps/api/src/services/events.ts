import { EventEmitter } from "node:events";

export interface ServiceExitEvent {
  serviceId: string;
  hostId: string;
  code: number | null;
  signal: string | null;
  exitedAt: string;
}

export interface ServiceDegradedEvent {
  serviceId: string;
  detail: string;
  consecutiveFailures: number;
  checkedAt: string;
}

/**
 * サービス管理から監視エンジンへのイベント。
 * manager は監視モジュールに依存せず、監視側が subscribe する。
 */
export const serviceEvents = new EventEmitter();
serviceEvents.setMaxListeners(50);
