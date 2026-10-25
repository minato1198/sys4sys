import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileCredentialStore,
  defaultCredentialsPath,
  resolveCredentials,
} from "./store.js";
import { CliError } from "../errors.js";

async function withTempDir(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sys4sys-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

test("saves, loads, and clears credentials atomically", async () => {
  await withTempDir(async (directory) => {
    const store = new FileCredentialStore(join(directory, "credentials.json"));
    assert.equal(await store.load(), null);

    await store.save({
      apiUrl: "http://127.0.0.1:8787",
      token: "s4s_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
      tokenId: "token-1",
      tokenPrefix: "s4s_abcd",
      tokenExpiresAt: "2027-01-01T00:00:00.000Z",
    });

    const loaded = await store.load();
    assert.equal(loaded?.tokenId, "token-1");
    assert.equal(loaded?.apiUrl, "http://127.0.0.1:8787");
    const raw = await readFile(store.path(), "utf8");
    assert.match(raw, /s4s_/);

    await store.save({
      apiUrl: "http://127.0.0.1:8787",
      sessionCookie: "session-token",
    });
    const replaced = await store.load();
    assert.equal(replaced?.sessionCookie, "session-token");
    assert.equal(replaced?.token, undefined);

    await store.clear();
    assert.equal(await store.load(), null);
    await store.clear();
  });
});

test("leaves a corrupted credentials file untouched and reports an error", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "credentials.json");
    await writeFile(path, "{not-json");
    const store = new FileCredentialStore(path);

    await assert.rejects(() => store.load(), CliError);
    assert.equal(await readFile(path, "utf8"), "{not-json");
  });
});

test("uses SYS4SYS_CONFIG_DIR for the default path", () => {
  const path = defaultCredentialsPath({
    SYS4SYS_CONFIG_DIR: "C:\\custom\\config",
  });
  assert.match(
    path.replaceAll("\\", "/"),
    /C:\/custom\/config\/credentials\.json$/,
  );
});

test("resolves credentials in the documented priority order", async () => {
  await withTempDir(async (directory) => {
    const store = new FileCredentialStore(join(directory, "credentials.json"));
    const tokenFile = join(directory, "token.txt");
    await writeFile(tokenFile, "s4s_file_token\n");

    await store.save({
      apiUrl: "http://stored",
      token: "stored-token",
      tokenId: "stored-id",
      tokenPrefix: "stored-prefix",
    });
    let resolved = await resolveCredentials({
      store,
      env: { SYS4SYS_TOKEN: "env-token" },
    });
    assert.equal(resolved.source, "env-token");
    assert.equal(resolved.token, "env-token");
    assert.equal(resolved.apiUrl, "http://stored");

    resolved = await resolveCredentials({
      store,
      env: { SYS4SYS_TOKEN_FILE: tokenFile },
    });
    assert.equal(resolved.source, "token-file");
    assert.equal(resolved.token, "s4s_file_token");

    resolved = await resolveCredentials({ store, env: {} });
    assert.equal(resolved.source, "stored-token");
    assert.equal(resolved.tokenId, "stored-id");

    await store.save({
      apiUrl: "http://stored",
      sessionCookie: "stored-cookie",
    });
    resolved = await resolveCredentials({
      store,
      env: { SYS4SYS_SESSION_COOKIE: "env-cookie" },
    });
    assert.equal(resolved.source, "env-cookie");
    assert.equal(resolved.sessionCookie, "env-cookie");

    resolved = await resolveCredentials({ store, env: {} });
    assert.equal(resolved.source, "stored-cookie");
    assert.equal(resolved.sessionCookie, "stored-cookie");

    await store.clear();
    resolved = await resolveCredentials({
      store,
      env: { SYS4SYS_EMAIL: "ai@example.local", SYS4SYS_PASSWORD: "secret" },
    });
    assert.equal(resolved.source, "password");
    assert.equal(resolved.email, "ai@example.local");

    resolved = await resolveCredentials({ store, env: {} });
    assert.equal(resolved.source, "none");
  });
});

test("rejects empty token files", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "empty-token.txt");
    await writeFile(path, "  \n");
    await assert.rejects(
      () =>
        resolveCredentials({
          store: new FileCredentialStore(join(directory, "credentials.json")),
          env: { SYS4SYS_TOKEN_FILE: path },
        }),
      CliError,
    );
  });
});
