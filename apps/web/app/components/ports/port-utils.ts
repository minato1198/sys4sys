import type { PortItem, PortOwner } from "./types";

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
}

export function endpointLabel(item: PortItem): string {
  return `${item.scope.toUpperCase()} / ${item.protocol.toUpperCase()} ${item.port}`;
}

export function fallbackPortOwner(item: PortItem): PortOwner {
  return {
    pid: item.pid,
    pidScope: item.pidScope,
    ppid: item.ppid,
    process: item.process,
    processPath: item.processPath,
    commandLine: item.commandLine,
    startedAt: item.startedAt,
    likelyWslForward: item.likelyWslForward,
  };
}

export function portOwnersForItem(item: PortItem): PortOwner[] {
  if (item.owners?.length) return item.owners;
  return [fallbackPortOwner(item)];
}

export function primaryPortOwner(item: PortItem): PortOwner {
  return portOwnersForItem(item)[0] ?? fallbackPortOwner(item);
}

export function killablePortOwners(item: PortItem): PortOwner[] {
  return portOwnersForItem(item).filter(
    (owner) => owner.pid !== null && owner.pid > 4,
  );
}

export function portOwnerKey(item: PortItem, owner: PortOwner): string {
  return [
    item.id,
    owner.pidScope ?? "-",
    owner.pid ?? "-",
    owner.process ?? "-",
    owner.processPath ?? "-",
    owner.commandLine ?? "-",
    owner.startedAt ?? "-",
  ].join("|");
}

export function matchesPortSearch(item: PortItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const owners = portOwnersForItem(item);
  const values: Array<string | number | null | undefined> = [
    item.scope,
    item.pidScope,
    item.protocol,
    item.address,
    item.port,
    item.process,
    item.processPath,
    item.commandLine,
    item.serviceId,
    item.reservation?.serviceId,
    item.reservation?.note,
    ...owners.flatMap((owner) => [
      owner.pid,
      owner.process,
      owner.processPath,
      owner.commandLine,
      owner.pidScope,
    ]),
  ];

  return values
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}
