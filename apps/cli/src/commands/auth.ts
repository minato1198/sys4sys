import type { ApiClient } from "../client.js";
import type { AuthUser } from "../types.js";
import { printJson } from "../output.js";

export async function whoami(client: ApiClient, json: boolean): Promise<void> {
  const user = await client.whoami();
  if (json) {
    printJson(user);
    return;
  }
  console.log(`${user.email} (${user.role})`);
}

export type { AuthUser };
