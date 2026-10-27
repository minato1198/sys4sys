import {
  endpointLabel,
  killablePortOwners,
  portOwnerKey,
  portOwnersForItem,
  primaryPortOwner,
} from "./port-utils";
import type { PortItem, PortOwner } from "./types";

export function PortActionButtons({
  item,
  expanded,
  canOperate,
  killBusyKey,
  onToggle,
  onHistory,
  onKillOwner,
  actionClassName = "flex flex-wrap items-center gap-2",
}: {
  item: PortItem;
  expanded: boolean;
  canOperate: boolean;
  killBusyKey: string | null;
  onToggle: () => void;
  onHistory: () => void;
  onKillOwner: (owner: PortOwner) => void;
  actionClassName?: string;
}) {
  const killable = killablePortOwners(item);
  const primary = primaryPortOwner(item);
  const rowKillOwner =
    killable.length === 1 ? (killable[0] ?? primary) : primary;
  const rowKillKey = portOwnerKey(item, rowKillOwner);
  const canRowKill =
    canOperate &&
    rowKillOwner.pid !== null &&
    rowKillOwner.pid > 4 &&
    killable.length <= 1;

  return (
    <div className={actionClassName}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`port-detail-${item.id}`}
        aria-label={`${endpointLabel(item)} の詳細を開閉`}
        className="min-h-11 whitespace-nowrap rounded-md border border-border px-3 text-sm text-fg-muted transition hover:border-fg-muted/40 hover:text-fg"
      >
        {expanded ? "閉じる" : "詳細"}
      </button>
      <button
        type="button"
        onClick={onHistory}
        aria-label={`${endpointLabel(item)} の履歴を開く`}
        className="min-h-11 whitespace-nowrap rounded-md border border-border px-3 text-sm text-fg-muted transition hover:border-info/40 hover:text-info"
      >
        履歴
      </button>
      {canRowKill ? (
        <KillOwnerButton
          item={item}
          owner={rowKillOwner}
          canOperate={canOperate}
          killBusyKey={killBusyKey}
          onKillOwner={onKillOwner}
        />
      ) : killable.length > 1 ? (
        <span
          title="複数プロセスがあります。詳細を開いて PID を選んで停止してください"
          className="min-h-11 rounded-md border border-warning/30 bg-warning/10 px-3 text-sm text-warning"
        >
          複数
        </span>
      ) : null}
    </div>
  );
}

export function KillOwnerButton({
  item,
  owner,
  canOperate,
  killBusyKey,
  onKillOwner,
}: {
  item: PortItem;
  owner: PortOwner;
  canOperate: boolean;
  killBusyKey: string | null;
  onKillOwner: (owner: PortOwner) => void;
}) {
  const ownerKey = portOwnerKey(item, owner);
  const ownerBusy = killBusyKey === ownerKey;
  const ownerKillable = owner.pid !== null && owner.pid > 4;

  if (!ownerKillable) return null;

  return (
    <button
      type="button"
      onClick={() => onKillOwner(owner)}
      disabled={!canOperate || killBusyKey !== null}
      aria-label={`PID ${owner.pid} (${owner.process ?? "unknown"}) を停止`}
      className="min-h-11 whitespace-nowrap rounded-md border border-border px-3 text-sm text-fg-muted transition hover:border-danger/50 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
    >
      {ownerBusy ? "停止中…" : "停止"}
    </button>
  );
}
