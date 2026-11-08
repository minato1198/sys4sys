import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tempDir: string;
let isLocalEndpoint: typeof import("./ai.js").isLocalEndpoint;
let closeDb: (() => Promise<void>) | null = null;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-ai-settings-"));
  process.env.DATABASE_URL = join(tempDir, "ai-settings.db");
  process.env.LOG_LEVEL = "silent";
  process.env.MONITOR_ENABLED = "false";
  process.env.AI_LOCAL_HOSTS = "localhost,ollama,host.docker.internal";

  const settings = await import("./ai.js");
  isLocalEndpoint = settings.isLocalEndpoint;
  const db = (await import("../db/index.js")).db;
  closeDb = async () => {
    await (db as any)?.$client?.close?.();
  };
});

afterAll(async () => {
  await closeDb?.();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("AI local endpoint detection", () => {
  it("accepts explicit allowlist hosts", () => {
    expect(isLocalEndpoint("http://localhost:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://ollama:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://host.docker.internal:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://myapp.localhost:11434/v1")).toBe(true);
  });

  it("accepts private IP ranges", () => {
    expect(isLocalEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://10.20.30.40:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://172.16.0.1:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://192.168.1.20:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://[::1]:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://[fd12::1]:11434/v1")).toBe(true);
  });

  it("rejects broad non-private endpoints and metadata-like addresses", () => {
    expect(isLocalEndpoint("http://ai.example.com/v1")).toBe(false);
    expect(isLocalEndpoint("http://ollama.example.com/v1")).toBe(false);
    expect(isLocalEndpoint("http://mymachine.local/v1")).toBe(false);
    expect(isLocalEndpoint("http://169.254.169.254/latest/v1")).toBe(false);
    expect(isLocalEndpoint("http://0.0.0.0:11434/v1")).toBe(false);
    expect(isLocalEndpoint("http://[fe80::1]:11434/v1")).toBe(false);
    expect(isLocalEndpoint("not-a-url")).toBe(false);
  });
});
