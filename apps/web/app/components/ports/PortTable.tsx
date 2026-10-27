"use client";

import { Fragment } from "react";
import { KillOwnerButton, PortActionButtons } from "./PortActions";
import { ReservationBadge, ScopeBadge } from "./PortBadges";
import {
  formatDate,
  portOwnerKey,
  portOwnersForItem,
  primaryPortOwner,
} from "./port-utils";
import type { PortItem, PortOwner } from "./types";

export function PortTable({
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
    <div className="scrollbar-thin hidden overflow-x-auto lg:block">
      <table className="w-full min-w-[1180px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-surface-muted text-sm text-fg-muted">
            <th
              scope="col"
              className="sticky left-0 z-30 w-32 bg-surface-muted px-4 py-2 font-medium"
            >
              Scope
            </th>
            <th
              scope="col"
              className="sticky left-32 z-20 w-24 bg-surface-muted px-4 py-2 font-medium"
            >
              Port
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Process / Owner
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Reservation / Status
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Bind
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              PID / PPID
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const expanded = expandedIds.has(item.id);
            const owners = portOwnersForItem(item);
            const primary = primaryPortOwner(item);
            const ownerExtraCount = owners.length > 1 ? owners.length - 1 : 0;
            const rowTone = item.conflict
              ? "border-b border-border bg-danger/10 hover:bg-danger/15"
              : "border-b border-border bg-surface hover:bg-surface-muted";
            const stickyCell = item.conflict
              ? "border-b border-danger bg-inherit"
              : "border-b border-border bg-inherit";

            return (
              <Fragment key={item.id}>
                <tr className={rowTone}>
                  <td
                    className={`sticky left-0 z-20 px-4 py-2 ${stickyCell} ${
                      item.conflict ? "border-l-4" : ""
                    }`}
                  >
                    <ScopeBadge item={item} />
                  </td>
                  <td className="sticky left-32 z-10 bg-inherit px-4 py-2 font-mono text-base tabular-nums text-fg">
                    {item.port}
                    <span className="ml-1 text-xs text-fg-muted">
                      {item.protocol}
                    </span>
                  </td>
                  <td className="max-w-[260px] truncate px-4 py-2 text-sm text-fg">
                    {primary.process ?? (
                      <span className="text-fg-muted">—</span>
                    )}
                    {ownerExtraCount > 0 ? (
                      <span
                        title="同じ endpoint に複数のオーナーがあります"
                        className="ml-1 rounded bg-warning/15 px-1 text-xs text-warning"
                      >
                        +{ownerExtraCount}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2">
                    <ReservationBadge reservation={item.reservation} />
                    {item.conflict ? (
                      <span className="mt-1 block text-xs font-medium text-danger">
                        接続不良
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-fg-muted">
                    {item.address || "*"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs tabular-nums text-fg-muted">
                    {primary.pid ?? "—"} / {primary.ppid ?? "—"}
                    {ownerExtraCount > 0 ? (
                      <span className="text-warning">
                        {" "}
                        (+{ownerExtraCount})
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2">
                    <PortActionButtons
                      item={item}
                      expanded={expanded}
                      canOperate={canOperate}
                      killBusyKey={killBusyKey}
                      onToggle={() => onToggle(item)}
                      onHistory={() => onHistory(item)}
                      onKillOwner={(owner) => onKillOwner(item, owner)}
                    />
                  </td>
                </tr>
                {expanded ? (
                  <tr key={`${item.id}-detail`} className="bg-surface-muted">
                    <td colSpan={7} className="px-4 py-3">
                      <dl
                        id={`port-detail-${item.id}`}
                        className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4"
                      >
                        <DetailItem
                          label="Primary PID / PPID"
                          value={`${primary.pid ?? "—"} / ${primary.ppid ?? "—"}`}
                        />
                        <DetailItem
                          label="Process started"
                          value={formatDate(
                            primary.startedAt ?? item.startedAt,
                          )}
                        />
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
                          wide
                        />
                        <DetailItem
                          label="Seen in"
                          value={
                            item.seenIn.length ? item.seenIn.join(", ") : "—"
                          }
                          wide
                        />
                        <DetailItem
                          label="Primary command line"
                          value={primary.commandLine ?? item.commandLine ?? "—"}
                          wide
                          wideWide
                        />
                        {owners.length > 1 ? (
                          <div className="sm:col-span-2 lg:col-span-4">
                            <dt className="text-fg-muted">
                              Owners ({owners.length})
                            </dt>
                            <dd className="space-y-2">
                              {owners.map((owner) => {
                                const ownerKey = portOwnerKey(item, owner);
                                return (
                                  <div
                                    key={ownerKey}
                                    className="flex flex-wrap items-start gap-2 rounded-md border border-border bg-surface px-2 py-2"
                                  >
                                    <div className="min-w-[220px] flex-1">
                                      <div className="font-mono text-sm text-fg">
                                        PID {owner.pid ?? "—"} / PPID{" "}
                                        {owner.ppid ?? "—"} ·{" "}
                                        {owner.process ?? "—"}
                                      </div>
                                      <div className="max-w-[520px] break-all font-mono text-xs text-fg-muted">
                                        {owner.commandLine ?? "—"}
                                      </div>
                                      <div className="font-mono text-xs text-fg-muted">
                                        {owner.pidScope ?? "—"} ·{" "}
                                        {formatDate(
                                          owner.startedAt ?? item.startedAt,
                                        )}
                                        {owner.likelyWslForward
                                          ? " · WSL relay"
                                          : ""}
                                      </div>
                                    </div>
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
                                );
                              })}
                            </dd>
                          </div>
                        ) : null}
                        {item.reservation ? (
                          <div className="sm:col-span-2 lg:col-span-4">
                            <dt className="text-fg-muted">Reservation</dt>
                            <dd className="font-mono text-sm text-fg">
                              {item.reservation.serviceId} ·{" "}
                              {item.reservation.status} ·{" "}
                              {item.reservation.note ?? "no note"}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailItem({
  label,
  value,
  wide = false,
  wideWide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
  wideWide?: boolean;
}) {
  return (
    <div
      className={`${wideWide ? "sm:col-span-2 lg:col-span-4" : wide ? "sm:col-span-2" : ""}`}
    >
      <dt className="text-fg-muted">{label}</dt>
      <dd className="break-all font-mono text-fg">{value}</dd>
    </div>
  );
}
