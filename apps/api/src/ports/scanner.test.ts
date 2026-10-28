import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetailedScanResult } from "@sys4sys/agent";

const { scanPortsMock, dbMock } = vi.hoisted(() => {
  const emptyQuery = () => {
    const promise = Promise.resolve([]);
    return {
      where: vi.fn(() => promise),
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    };
  };
  return {
    scanPortsMock: vi.fn(),
    dbMock: {
      select: vi.fn(() => ({ from: vi.fn(emptyQuery) })),
    },
  };
});

vi.mock("@sys4sys/agent", () => ({ scanPorts: scanPortsMock }));
vi.mock("../db/index.js", () => ({ db: dbMock }));

import { scanAndPersist } from "./scanner.js";

function result(): DetailedScanResult {
  return {
    scannedAt: "2026-10-28T00:00:00.000Z",
    rows: [],
    skipped: [],
    scanErrors: [],
    distros: [],
    timings: {},
    warnings: [],
  };
}

afterEach(() => {
  scanPortsMock.mockReset();
});

describe("scanAndPersist single-flight", () => {
  it("shares one scan for concurrent identical options", async () => {
    let release: (value: DetailedScanResult) => void = () => undefined;
    scanPortsMock.mockReturnValue(
      new Promise<DetailedScanResult>((resolve) => {
        release = resolve;
      }),
    );

    const first = scanAndPersist({ scope: "windows" });
    const second = scanAndPersist({ scope: "windows" });
    const third = scanAndPersist({ scope: "windows" });

    try {
      await vi.waitFor(() => {
        expect(scanPortsMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      release(result());
    }
    await Promise.all([first, second, third]);
  });

  it("serializes different options without sharing their result", async () => {
    scanPortsMock.mockResolvedValue(result());
    await Promise.all([
      scanAndPersist({ scope: "windows" }),
      scanAndPersist({ scope: "wsl" }),
    ]);
    expect(scanPortsMock).toHaveBeenCalledTimes(2);
  });
});
