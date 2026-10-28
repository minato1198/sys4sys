import { afterEach, describe, expect, it, vi } from "vitest";

const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn() }));

vi.mock("./db/index.js", () => ({
  db: { insert: insertMock },
}));

import { tryWriteAudit } from "./audit.js";

afterEach(() => {
  insertMock.mockReset();
  vi.restoreAllMocks();
});

describe("tryWriteAudit", () => {
  it("does not throw when the audit insert fails", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    insertMock.mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error("audit db down")),
    });

    await expect(
      tryWriteAudit({
        actorLabel: "admin@example.test",
        action: "port.kill",
        target: "port:windows:tcp:3000",
      }),
    ).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("audit.write_failed action=port.kill"),
    );
    const message = warning.mock.calls[0]?.[0] as string;
    expect(message).not.toContain("admin@example.test");
  });

  it("writes successfully when the audit insert succeeds", async () => {
    insertMock.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      tryWriteAudit({
        actorLabel: "admin@example.test",
        action: "port.reserve",
        target: "port:windows:tcp:3001",
      }),
    ).resolves.toBeUndefined();
    expect(insertMock).toHaveBeenCalledTimes(1);
  });
});
