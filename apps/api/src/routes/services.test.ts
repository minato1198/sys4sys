import { describe, expect, it } from "vitest";
import { serviceActionsQuerySchema } from "@sys4sys/shared";
import { decodeActionsCursor, encodeActionsCursor } from "./services.js";

describe("service actions cursor", () => {
  it("round-trips startedAt and id", () => {
    const row = {
      id: "act-2",
      startedAt: new Date("2026-10-24T00:00:00.000Z"),
    };
    const cursor = encodeActionsCursor(row);
    expect(cursor).toBe("2026-10-24T00:00:00.000Z|act-2");
    expect(decodeActionsCursor(cursor)).toEqual(row);
  });

  it("accepts ids containing a pipe by using the first separator", () => {
    const decoded = decodeActionsCursor("2026-10-24T00:00:00.000Z|act|2");
    expect(decoded?.id).toBe("act|2");
  });

  it("rejects malformed cursors", () => {
    expect(decodeActionsCursor("not-a-cursor")).toBeNull();
    expect(decodeActionsCursor("2026-10-24T00:00:00.000Z|")).toBeNull();
    expect(decodeActionsCursor("bad-date|act-1")).toBeNull();
  });

  it("applies action query defaults and bounds", () => {
    expect(serviceActionsQuerySchema.parse({})).toEqual({
      limit: 50,
    });
    expect(serviceActionsQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(() => serviceActionsQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => serviceActionsQuerySchema.parse({ limit: 201 })).toThrow();
  });
});
