import type { PortRow } from "@sys4sys/shared";
import { describe, expect, it } from "vitest";
import {
  buildReservationViews,
  findReservationForEndpoint,
  findReservationForRow,
  isEndpointInUse,
  toReservationView,
  type ReservationRow,
} from "./reservations.js";

function port(overrides: Partial<PortRow> = {}): PortRow {
  return {
    scope: "windows",
    protocol: "tcp",
    address: "0.0.0.0",
    port: 3000,
    pid: 1234,
    process: "node.exe",
    commandLine: "node server.js",
    ...overrides,
  };
}

function reservation(overrides: Partial<ReservationRow> = {}): ReservationRow {
  return {
    id: "res-1",
    scope: "windows" as const,
    port: 3000,
    protocol: "tcp" as const,
    serviceId: "my-api",
    note: "api",
    createdAt: new Date("2026-10-21T00:00:00.000Z"),
    ...overrides,
  };
}

describe("port reservations", () => {
  it("detects active listeners across Windows and WSL scopes", () => {
    expect(
      isEndpointInUse(
        [port({ scope: "wsl", pidScope: "Ubuntu" })],
        "tcp",
        3000,
      ),
    ).toBe(true);
    expect(isEndpointInUse([port()], "udp", 3000)).toBe(false);
    expect(isEndpointInUse([port()], "tcp", 3001)).toBe(false);
  });

  it("matches reservations by protocol and port only", () => {
    const found = findReservationForEndpoint([reservation()], "tcp", 3000);
    expect(found?.serviceId).toBe("my-api");
    expect(findReservationForEndpoint([reservation()], "udp", 3000)).toBe(
      undefined,
    );
    expect(findReservationForEndpoint([reservation()], "tcp", 3001)).toBe(
      undefined,
    );
  });

  it("marks a reservation as conflict when the endpoint is in use", () => {
    const view = toReservationView(reservation(), [
      port({ scope: "wsl", pidScope: "Ubuntu" }),
    ]);
    expect(view.status).toBe("conflict");
    expect(view.inUse).toBe(true);
  });

  it("marks a reservation as reserved when no listener exists", () => {
    const view = toReservationView(reservation(), [port({ port: 4000 })]);
    expect(view.status).toBe("reserved");
    expect(view.inUse).toBe(false);
  });

  it("sorts views by port and protocol", () => {
    const views = buildReservationViews(
      [
        reservation({ id: "b", port: 9000, protocol: "tcp" }),
        reservation({ id: "a", port: 3000, protocol: "udp" }),
        reservation({ id: "c", port: 3000, protocol: "tcp" }),
      ],
      [],
    );
    expect(views.map((view) => view.id)).toEqual(["c", "a", "b"]);
  });

  it("finds the reservation attached to a live port row", () => {
    const row = port({ scope: "windows", likelyWslForward: true });
    expect(
      findReservationForRow([reservation({ scope: "wsl" })], row)?.serviceId,
    ).toBe("my-api");
  });
});
