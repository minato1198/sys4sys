"use client";

import { KillOwnerButton, PortActionButtons } from "./PortActions";
import { ReservationBadge, ScopeBadge } from "./PortBadges";
import {
  formatDate,
  portOwnerKey,
  portOwnersForItem,
  primaryPortOwner,
} from "./port-utils";
import type { PortItem, PortOwner } from "./types";

export function PortCardList({
  items,
  expandedIds,
  canOperate,
  killBusyKey,
  onToggle,
  onHistory,
  onKillOwner,
}: {
  items: PortItem[];
  expandedIds: Set<string>;
  canOperate: boolean;
  killBusyKey: string | null;
  onToggle: (item: PortItem) => void;
  onHistory: (item: PortItem) => void;
  onKillOwner: (item: PortItem, owner: PortOwner) => void;
}) {
  return (
    <ul className="grid gap-3 p-4 lg:hidden">
      {items.map((item) => {
        const expanded = expandedIds.has(item.id);
        const owners = portOwnersForItem(item);
        const primary = primaryPortOwner(item);

        return (
          <li
            key={item.id}
            className={`overflow-hidden rounded-lg border ${
              item.conflict
                ? "border-danger/40 bg-danger/10"
                : "border-border bg-surface"
            }`}
          >
            <div className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <ScopeBadge item={item} />
                  <div className="mt-2 font-mono text-xl tabular-nums text-fg">
                    {item.port}
                    <span className="ml-2 text-sm text-fg-muted">
                      {item.protocol}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-fg">
                    {primary.process ?? (
                      <span className="text-fg-muted">—</span>
                    )}
                    {owners.length > 1 ? (
                      <span className="ml-1 rounded bg-warning/15 px-1 text-xs text-warning">
                        +{owners.length - 1} owners
                      </span>
                    ) : null}
                  </div>
                </div>
                <ReservationBadge reservation={item.reservation} />
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div>
                  <dt className="text-fg-muted">Bind</dt>
                  <dd className="break-all font-mono text-fg">
                    {item.address || "*"}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-muted">PID / PPID</dt>
                  <dd className="font-mono text-fg">
                    {primary.pid ?? "—"} / {primary.ppid ?? "—"}
                  </dd>
                </div>
              </dl>

              <div className="mt-4">
                <PortActionButtons
                  item={item}
                  expanded={expanded}
                  canOperate={canOperate}
                  killBusyKey={killBusyKey}
                  onToggle={() => onToggle(item)}
                  onHistory={() => onHistory(item)}
                  onKillOwner={(owner) => onKillOwner(item, owner)}
                />
              </div>

              {expanded ? (
                <div
                  id={`port-detail-${item.id}`}
                  className="mt-4 border-t border-border pt-4"
                >
                  <dl className="grid gap-x-4 gap-y-2 text-sm">
                    <DetailItem
                      label="First seen"
                      value={formatDate(item.firstSeen)}
                    />
                    <DetailItem
                      label="Last seen"
                      value={formatDate(item.lastSeen)}
                    />
                    <DetailItem
                      label="Executable"
                      value={primary.processPath ?? item.processPath ?? "—"}
                    />
                    <DetailItem
                      label="Command line"
                      value={primary.commandLine ?? item.commandLine ?? "—"}
                    />
                    <DetailItem
                      label="Seen in"
                      value={item.seenIn.length ? item.seenIn.join(", ") : "—"}
                    />
                  </dl>

                  {owners.length > 1 ? (
                    <div className="mt-4">
                      <h3 className="text-sm font-medium text-fg-muted">
                        Owners ({owners.length})
                      </h3>
                      <div className="mt-2 grid gap-2">
                        {owners.map((owner) => {
                          const ownerKey = portOwnerKey(item, owner);
                          return (
                            <div
                              key={ownerKey}
                              className="rounded-md border border-border bg-surface-muted p-3"
                            >
                              <div className="font-mono text-sm text-fg">
                                PID {owner.pid ?? "—"} / PPID{" "}
                                {owner.ppid ?? "—"} · {owner.process ?? "—"}
                              </div>
                              <div className="mt-1 break-all font-mono text-xs text-fg-muted">
                                {owner.commandLine ?? "—"}
                              </div>
                              <div className="mt-1 font-mono text-xs text-fg-muted">
                                {owner.pidScope ?? "—"} ·{" "}
                                {formatDate(owner.startedAt ?? item.startedAt)}
                                {owner.likelyWslForward ? " · WSL relay" : ""}
                              </div>
                              <div className="mt-3">
                                <KillOwnerButton
                                  item={item}
                                  owner={owner}
                                  canOperate={canOperate}
                                  killBusyKey={killBusyKey}
                                  onKillOwner={(owner) =>
                                    onKillOwner(item, owner)
                                  }
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="break-all font-mono text-fg">{value}</dd>
    </div>
  );
}
