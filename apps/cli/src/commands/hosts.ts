import type { ApiClient } from "../client.js";
import type { Host } from "../types.js";
import { printJson, printTable, shortId } from "../output.js";

export async function listHosts(
  client: ApiClient,
  json: boolean,
): Promise<void> {
  const hosts = await client.request<Host[]>("GET", "/api/hosts");

  if (json) {
    printJson(hosts);
    return;
  }

  printTable(
    ["ID", "KIND", "NAME", "STATE", "DISTRO"],
    hosts.map((host) => [
      shortId(host.id),
      host.kind,
      host.name,
      host.state ?? "-",
      host.distro ?? "-",
    ]),
  );
}
