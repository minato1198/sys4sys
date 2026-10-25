import { Buffer } from "node:buffer";
import type { AuthMe } from "@sys4sys/shared";
import type { CredentialStore, ResolvedCredentials } from "../auth/store.js";
import { ApiClient } from "../client.js";
import { CliError, UsageError } from "../errors.js";
import { printJson, writeErr, writeOut, type CliOutput } from "../output.js";

export async function whoami(
  client: ApiClient,
  json: boolean,
  output?: CliOutput,
): Promise<void> {
  const user = await client.whoami();
  if (json) {
    printJson(user, output);
    return;
  }
  await writeOut(output, `${user.email} (${user.role})\n`);
  await writeOut(output, `auth: ${user.authMethod}\n`);
  if (user.token) await writeOut(output, `token: ${user.token.prefix}\n`);
  await writeOut(output, `scopes: ${user.scopes.join(", ") || "(none)"}\n`);
}

export interface AuthLoginOptions {
  email?: string;
  passwordStdin: boolean;
  json: boolean;
  store: CredentialStore;
  output?: CliOutput;
}

export async function authLogin(
  client: ApiClient,
  options: AuthLoginOptions,
): Promise<void> {
  const email = options.email?.trim() || process.env.SYS4SYS_EMAIL?.trim();
  if (!email) {
    throw new UsageError("--email または SYS4SYS_EMAIL を指定してください。");
  }

  let password: string;
  if (options.passwordStdin) {
    password = (await readStdin()).trim();
  } else if (process.env.SYS4SYS_PASSWORD) {
    password = process.env.SYS4SYS_PASSWORD;
  } else {
    password = await promptHidden("Password: ");
  }
  if (!password) {
    throw new UsageError("パスワードが空です。");
  }

  const { user, cookie } = await client.loginWithPassword(email, password);
  await options.store.save({
    apiUrl: client.apiUrl,
    sessionCookie: cookie,
  });

  if (options.json) {
    printJson(
      {
        user,
        authMethod: "session",
        apiUrl: client.apiUrl,
      },
      options.output,
    );
    return;
  }
  writeErr(
    options.output,
    `${user.email} (${user.role}) としてログインしました\n保存先: ${options.store.path()}\n`,
  );
}

export interface AuthLogoutOptions {
  apiUrl?: string;
  revokeToken: boolean;
  json: boolean;
  store: CredentialStore;
  output?: CliOutput;
}

export async function authLogout(options: AuthLogoutOptions): Promise<void> {
  const stored = await options.store.load();
  const envTokenSet = Boolean(
    process.env.SYS4SYS_TOKEN?.trim() || process.env.SYS4SYS_TOKEN_FILE?.trim(),
  );

  if (!stored) {
    if (envTokenSet) {
      writeErr(
        options.output,
        "環境変数のトークンはローカルの保存物ではないため失効しません。必要に応じて別途失効してください。\n",
      );
    }
    if (options.json) {
      printJson({ loggedOut: true, hadCredentials: false }, options.output);
    } else {
      await writeOut(options.output, "保存済みの資格情報はありません。\n");
    }
    return;
  }

  let warning: string | null = null;
  const targetApiUrl = options.apiUrl?.trim() || stored.apiUrl;

  if (stored.token) {
    try {
      const api = new ApiClient({ apiUrl: targetApiUrl, token: stored.token });
      const tokenId = stored.tokenId ?? (await api.whoami()).token?.id;
      if (!tokenId) {
        throw new CliError("保存済みトークンの ID を特定できませんでした。");
      }
      await api.request("DELETE", `/api/tokens/${encodeURIComponent(tokenId)}`);
    } catch (error) {
      if (options.revokeToken) throw error;
      warning = `トークンの失効に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  } else if (stored.sessionCookie) {
    try {
      const api = new ApiClient({
        apiUrl: targetApiUrl,
        sessionCookie: stored.sessionCookie,
      });
      await api.request("POST", "/api/auth/logout");
    } catch (error) {
      warning = `セッションの失効に失敗しました: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  await options.store.clear();

  if (warning) writeErr(options.output, `${warning}\n`);
  if (envTokenSet) {
    writeErr(
      options.output,
      "環境変数のトークンはローカルの保存物ではないため失効しません。必要に応じて別途失効してください。\n",
    );
  }

  if (options.json) {
    printJson(
      { loggedOut: true, hadCredentials: true, warning },
      options.output,
    );
  } else {
    await writeOut(options.output, "ログアウトしました。\n");
  }
}

export async function authStatus(
  client: ApiClient,
  resolved: ResolvedCredentials,
  json: boolean,
  commandOutput?: CliOutput,
): Promise<void> {
  const me: AuthMe = await client.whoami();
  const output = {
    apiUrl: client.apiUrl,
    authMethod: me.authMethod,
    user: {
      id: me.id,
      email: me.email,
      name: me.name,
      role: me.role,
    },
    scopes: me.scopes,
    tokenPrefix: resolved.tokenPrefix ?? me.token?.prefix ?? null,
    tokenExpiresAt: resolved.tokenExpiresAt ?? null,
    source: resolved.source,
  };

  if (json) {
    printJson(output, commandOutput);
    return;
  }

  await writeOut(commandOutput, `API: ${output.apiUrl}\n`);
  await writeOut(
    commandOutput,
    `auth: ${output.authMethod} (${output.source})\n`,
  );
  await writeOut(commandOutput, `user: ${me.email} (${me.role})\n`);
  await writeOut(
    commandOutput,
    `scopes: ${me.scopes.join(", ") || "(none)"}\n`,
  );
  if (output.tokenPrefix) {
    await writeOut(commandOutput, `token: ${output.tokenPrefix}\n`);
  }
  if (output.tokenExpiresAt) {
    await writeOut(commandOutput, `expires: ${output.tokenExpiresAt}\n`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      "TTY がない場合は --password-stdin でパスワードを渡してください。",
    );
  }

  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new CliError("ログインをキャンセルしました", 130));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.on("data", onData);
  });
}

export type { AuthMe };
