import {
  tokenCreateSchema,
  tokenScopeSchema,
  type TokenCreated,
  type TokenScope,
  type TokenView,
} from "@sys4sys/shared";
import { ZodError } from "zod";
import type { CredentialStore, ResolvedCredentials } from "../auth/store.js";
import type { ApiClient } from "../client.js";
import { createInterface } from "node:readline/promises";
import { CliError, UsageError } from "../errors.js";
import {
  printJson,
  printTable,
  shortId,
  writeErr,
  writeOut,
} from "../output.js";
import type { CommandOptions } from "./services.js";

export interface TokenCommandContext {
  store: CredentialStore;
  resolved: ResolvedCredentials;
}

function zodToUsage(error: unknown): UsageError {
  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    return new UsageError(`入力が不正です: ${details}`);
  }
  return new UsageError(
    `入力が不正です: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function parseScopes(values: string[] | undefined): TokenScope[] {
  const raw = (values ?? []).flatMap((value) => value.split(","));
  const unique: TokenScope[] = [];
  for (const item of raw) {
    const scope = item.trim();
    if (!scope) continue;
    let parsed: TokenScope;
    try {
      parsed = tokenScopeSchema.parse(scope);
    } catch {
      throw new UsageError(
        `不明なスコープです: ${scope}（有効: ${tokenScopeSchema.options.join(", ")}）`,
      );
    }
    if (!unique.includes(parsed)) unique.push(parsed);
  }
  if (unique.length === 0) {
    throw new UsageError("--scope を 1 つ以上指定してください。");
  }
  return unique;
}

export function parseExpiresIn(value: string | undefined): number {
  if (value === undefined) return 90;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    throw new UsageError(
      "--expires-in は 1〜365 の整数（日）で指定してください。",
    );
  }
  return parsed;
}

export async function listTokens(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const params = new URLSearchParams();
  if (options.user) params.set("userId", options.user);
  const query = params.toString();
  const tokens = await client.request<TokenView[]>(
    "GET",
    query ? `/api/tokens?${query}` : "/api/tokens",
  );

  if (options.json) {
    printJson(tokens, options.output);
    return;
  }

  if (tokens.length === 0) {
    await writeOut(options.output, "トークンはありません。\n");
    return;
  }

  printTable(
    ["ID", "NAME", "PREFIX", "SCOPES", "EXPIRES", "STATUS"],
    tokens.map((token) => [
      shortId(token.id),
      token.name,
      token.prefix,
      token.scopes.join(","),
      token.expiresAt.slice(0, 10),
      token.revokedAt ? "revoked" : "active",
    ]),
    options.output,
  );
}

export async function createToken(
  client: ApiClient,
  options: CommandOptions,
  context: TokenCommandContext,
): Promise<void> {
  if (!options.name?.trim()) {
    throw new UsageError("tokens create には --name が必要です。");
  }

  let input;
  try {
    input = tokenCreateSchema.parse({
      name: options.name.trim(),
      scopes: parseScopes(options.scope),
      expiresInDays: parseExpiresIn(options.expiresIn),
      userId: options.user,
    });
  } catch (error) {
    throw zodToUsage(error);
  }

  const created = await client.request<TokenCreated>(
    "POST",
    "/api/tokens",
    input,
  );

  if (options.save) {
    await context.store.save({
      apiUrl: client.apiUrl,
      token: created.token,
      tokenId: created.id,
      tokenPrefix: created.prefix,
      tokenExpiresAt: created.expiresAt,
    });
    if (
      process.env.SYS4SYS_TOKEN?.trim() ||
      process.env.SYS4SYS_TOKEN_FILE?.trim()
    ) {
      writeErr(
        options.output,
        "警告: SYS4SYS_TOKEN / SYS4SYS_TOKEN_FILE が設定されているため、" +
          "保存したトークンより環境変数が優先されます。\n",
      );
    }
  }

  if (options.json) {
    printJson(created, options.output);
    return;
  }

  writeErr(
    options.output,
    "このトークンは一度しか表示されません。安全な場所に保存してください。\n",
  );
  await writeOut(options.output, `Token:   ${created.token}\n`);
  await writeOut(options.output, `ID:      ${created.id}\n`);
  await writeOut(options.output, `Name:    ${created.name}\n`);
  await writeOut(options.output, `Prefix:  ${created.prefix}\n`);
  await writeOut(options.output, `Scopes:  ${created.scopes.join(", ")}\n`);
  await writeOut(options.output, `Expires: ${created.expiresAt}\n`);
}

async function confirmRevoke(tokenId: string, options: CommandOptions) {
  if (options.yes) return;
  if (options.json || !process.stdin.isTTY) {
    throw new UsageError(
      "非対話環境でトークンを失効するには --yes を指定してください。",
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      `token ${tokenId} を失効します。よろしいですか? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CliError("トークンの失効をキャンセルしました。", 1);
    }
  } finally {
    rl.close();
  }
}

export async function revokeToken(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = positionals[0]?.trim();
  if (!id) {
    throw new UsageError("tokens revoke にはトークンIDが必要です。");
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `tokens revoke にはトークンID以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }

  await confirmRevoke(id, options);
  await client.request<void>("DELETE", `/api/tokens/${encodeURIComponent(id)}`);

  if (options.json) {
    printJson({ revoked: true, id }, options.output);
  } else {
    await writeOut(options.output, `token revoked: ${id}\n`);
  }
}
