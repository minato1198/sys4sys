import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, queryOf, startTestServer, text } from "../test-server.js";
import { exportReport, getReport, listReports } from "./reports.js";
import { type CommandOptions } from "./services.js";

function baseOptions(
  memory: MemoryOutput,
  overrides: Partial<CommandOptions> = {},
): CommandOptions {
  return {
    json: false,
    showEnv: false,
    dryRun: false,
    yes: false,
    wait: false,
    output: memory.output,
    ...overrides,
  };
}

function reportDetail() {
  return {
    id: "rep-1",
    incidentId: "inc-1",
    format: "md",
    body: "# Report\nincident detail",
    createdAt: "2026-10-01T00:00:00.000Z",
    incident: {
      id: "inc-1",
      title: "service down",
      severity: "error",
      status: "open",
      serviceName: "demo",
    },
    analysis: null,
  };
}

test("reports list maps incident filter to API query", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/reports") {
      json(response, {
        items: [
          {
            id: "rep-1",
            incidentId: "inc-1",
            format: "md",
            body: "# Report",
            createdAt: "2026-10-01T00:00:00.000Z",
            incident: {
              id: "inc-1",
              title: "service down",
              severity: "error",
              status: "open",
              serviceName: "demo",
            },
          },
        ],
        total: 1,
      });
      return;
    }

    json(
      response,
      { type: "about:blank", title: "Not Found", status: 404, detail: "no" },
      404,
    );
  });

  const memory = memoryOutput();
  try {
    await listReports(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory, { json: true, incident: "inc-1", limit: "20" }),
    );
    const url = queryOf(server.requests[0]?.url ?? "");
    assert.equal(url.searchParams.get("incidentId"), "inc-1");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(JSON.parse(memory.out).total, 1);
  } finally {
    await server.close();
  }
});

test("reports get prints a short body by default", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/reports/rep-1") {
      json(response, reportDetail());
      return;
    }

    json(
      response,
      { type: "about:blank", title: "Not Found", status: 404, detail: "no" },
      404,
    );
  });

  const memory = memoryOutput();
  try {
    await getReport(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["rep-1"],
      baseOptions(memory),
    );
    assert.match(memory.out, /# Report/);
  } finally {
    await server.close();
  }
});

test("reports export writes markdown to a new file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sys4sys-reports-"));
  const path = join(dir, "report.md");
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "GET" &&
      url.pathname === "/api/reports/rep-1/export"
    ) {
      text(response, "# Exported\nreport body", "text/markdown");
      return;
    }

    json(
      response,
      { type: "about:blank", title: "Not Found", status: 404, detail: "no" },
      404,
    );
  });

  const memory = memoryOutput();
  try {
    await exportReport(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["rep-1"],
      baseOptions(memory, { outputPath: path }),
    );
    const content = await stat(path);
    assert.ok(content.size > 0);
    assert.match(memory.out, /exported/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports export rejects existing output unless --force", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sys4sys-reports-"));
  const path = join(dir, "report.md");
  await writeFile(path, "old", "utf8");
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "GET" &&
      url.pathname === "/api/reports/rep-1/export"
    ) {
      text(response, "# Exported\nreport body", "text/markdown");
      return;
    }

    json(
      response,
      { type: "about:blank", title: "Not Found", status: 404, detail: "no" },
      404,
    );
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      exportReport(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["rep-1"],
        baseOptions(memory, { outputPath: path }),
      ),
      UsageError,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports export --format --force overwrites and outputs JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sys4sys-reports-"));
  const path = join(dir, "report.json");
  await writeFile(path, "old", "utf8");
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "GET" &&
      url.pathname === "/api/reports/rep-1/export"
    ) {
      assert.equal(url.searchParams.get("format"), "json");
      json(response, { report: reportDetail(), analysis: null });
      return;
    }

    json(
      response,
      { type: "about:blank", title: "Not Found", status: 404, detail: "no" },
      404,
    );
  });

  const memory = memoryOutput();
  try {
    await exportReport(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["rep-1"],
      baseOptions(memory, {
        json: true,
        format: "json",
        outputPath: path,
        force: true,
      }),
    );
    const exported = JSON.parse(await readFile(path, "utf8"));
    assert.equal(exported.report.id, "rep-1");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
