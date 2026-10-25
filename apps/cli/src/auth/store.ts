import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { CliError } from "../errors.js";

export interface StoredCredentials {
  apiUrl: string;
  token?: string;
  tokenId?: string;
  tokenPrefix?: string;
  tokenExpiresAt?: string;
  sessionCookie?: string;
  sessionExpiresAt?: string;
}

export interface CredentialStore {
  load(): Promise<StoredCredentials | null>;
  save(credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
  path(): string;
}

export type CredentialSource =
  | "env-token"
  | "token-file"
  | "stored-token"
  | "env-cookie"
  | "stored-cookie"
  | "password"
  | "none";

export interface ResolvedCredentials {
  apiUrl?: string;
  token?: string;
  tokenId?: string;
  tokenPrefix?: string;
  tokenExpiresAt?: string;
  sessionCookie?: string;
  sessionExpiresAt?: string;
  email?: string;
  password?: string;
  source: CredentialSource;
  stored: StoredCredentials | null;
}

const storedCredentialsSchema = z.object({
  apiUrl: z.string().min(1),
  token: z.string().min(1).optional(),
  tokenId: z.string().min(1).optional(),
  tokenPrefix: z.string().min(1).optional(),
  tokenExpiresAt: z.string().min(1).optional(),
  sessionCookie: z.string().min(1).optional(),
  sessionExpiresAt: z.string().min(1).optional(),
});

export function defaultCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.SYS4SYS_CONFIG_DIR?.trim();
  if (override) return join(resolve(override), "credentials.json");

  if (process.platform === "win32") {
    const appData =
      env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, "sys4sys", "credentials.json");
  }

  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "sys4sys", "credentials.json");
}

export class FileCredentialStore implements CredentialStore {
  constructor(private readonly filePath: string) {}

  path(): string {
    return this.filePath;
  }

  async load(): Promise<StoredCredentials | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new CliError(
        `資格情報ファイルを読み込めません (${this.filePath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliError(
        `資格情報ファイルが壊れています (${this.filePath})。削除せずに残しています。` +
          " `sys4sys auth login` で上書きするか、手動で確認してください。",
      );
    }

    const result = storedCredentialsSchema.safeParse(parsed);
    if (!result.success) {
      throw new CliError(
        `資格情報ファイルの形式が不正です (${this.filePath})。` +
          " 削除せずに残しています。`sys4sys auth login` で上書きできます。",
      );
    }
    return result.data;
  }

  async save(credentials: StoredCredentials): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);

    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporary, 0o600).catch(() => undefined);

    try {
      await rename(temporary, this.filePath);
    } catch (error) {
      // Windows では既存ファイルへの rename が失敗することがある。
      if (isPermissionOrExists(error)) {
        await rm(this.filePath, { force: true });
        await rename(temporary, this.filePath);
      } else {
        await rm(temporary, { force: true });
        throw new CliError(
          `資格情報ファイルを書き込めません (${this.filePath}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (error) {
      if (!isNotFound(error)) {
        throw new CliError(
          `資格情報ファイルを削除できません (${this.filePath}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isPermissionOrExists(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

export function createCredentialStore(
  env: NodeJS.ProcessEnv = process.env,
): CredentialStore {
  return new FileCredentialStore(defaultCredentialsPath(env));
}

async function readTokenFile(path: string, cwd: string): Promise<string> {
  const resolved = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    const token = (await readFile(resolved, "utf8")).trim();
    if (!token) {
      throw new CliError(`トークンファイルが空です: ${resolved}`);
    }
    return token;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `トークンファイルを読み込めません (${resolved}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 認証情報の優先順位:
 * env token > token file > stored token > env cookie > stored cookie > password
 */
export async function resolveCredentials(
  input: {
    apiUrl?: string;
    store?: CredentialStore;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<ResolvedCredentials> {
  const env = input.env ?? process.env;
  const store = input.store ?? createCredentialStore(env);
  const stored = await store.load();
  const apiUrl = input.apiUrl?.trim() || stored?.apiUrl?.trim() || undefined;
  const cwd = input.cwd ?? process.cwd();

  const envToken = env.SYS4SYS_TOKEN?.trim();
  if (envToken) {
    return { apiUrl, token: envToken, source: "env-token", stored };
  }

  const tokenFile = env.SYS4SYS_TOKEN_FILE?.trim();
  if (tokenFile) {
    return {
      apiUrl,
      token: await readTokenFile(tokenFile, cwd),
      source: "token-file",
      stored,
    };
  }

  if (stored?.token) {
    return {
      apiUrl,
      token: stored.token,
      tokenId: stored.tokenId,
      tokenPrefix: stored.tokenPrefix,
      tokenExpiresAt: stored.tokenExpiresAt,
      source: "stored-token",
      stored,
    };
  }

  const envCookie = env.SYS4SYS_SESSION_COOKIE?.trim();
  if (envCookie) {
    return { apiUrl, sessionCookie: envCookie, source: "env-cookie", stored };
  }

  if (stored?.sessionCookie) {
    return {
      apiUrl,
      sessionCookie: stored.sessionCookie,
      sessionExpiresAt: stored.sessionExpiresAt,
      source: "stored-cookie",
      stored,
    };
  }

  const email = env.SYS4SYS_EMAIL?.trim();
  const password = env.SYS4SYS_PASSWORD;
  if (email && password) {
    return {
      apiUrl,
      email,
      password,
      source: "password",
      stored,
    };
  }

  return { apiUrl, source: "none", stored };
}
