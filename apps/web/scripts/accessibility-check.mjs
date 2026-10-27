import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import axe from "axe-core";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const outDir = process.env.OUT_DIR ?? "test-results/accessibility";

fs.mkdirSync(outDir, { recursive: true });

const views = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
];

const failures = [];
const screenshots = [];
const axeSummaries = [];

function summarizeViolations(label, results) {
  const violations = (results.violations ?? []).filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );

  if (violations.length > 0) {
    failures.push(
      `${label}: ${violations.length} critical/serious axe violations`,
    );
  }

  axeSummaries.push({
    label,
    criticalOrSerious: violations.length,
    all: (results.violations ?? []).length,
    violations: violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      helpUrl: violation.helpUrl,
      targets: violation.nodes.map((node) => node.target).flat(),
    })),
  });
}

async function runAxe(page, label) {
  await page.addScriptTag({ content: axe.source });
  const results = await page.evaluate(async () => window.axe.run(document));
  summarizeViolations(label, results);
}

async function setTheme(page, theme) {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  }, theme);
  await page.waitForTimeout(120);
}

async function capture(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
}

async function captureLoginTheme(browser, view, theme) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const label = `login ${view.name} ${theme}`;

  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
    await setTheme(page, theme);
    await capture(page, `login-${view.name}-${theme}`);
    await runAxe(page, label);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();

try {
  for (const view of views) {
    for (const theme of ["dark", "light"]) {
      await captureLoginTheme(browser, view, theme);
    }
  }

  const keyboardContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const keyboardPage = await keyboardContext.newPage();
  try {
    await keyboardPage.goto(`${baseUrl}/login`, { waitUntil: "load" });
    await keyboardPage.waitForTimeout(300);
    await keyboardPage.keyboard.press("Tab");
    const active = await keyboardPage.evaluate(() => {
      const el = document.activeElement;
      return {
        tagName: el?.tagName ?? "",
        type: el?.getAttribute("type") ?? "",
      };
    });

    if (active.tagName !== "INPUT" || active.type !== "password") {
      failures.push(
        `login keyboard focus moved to ${active.tagName} ${active.type}; expected INPUT password`,
      );
    }
  } finally {
    await keyboardContext.close();
  }

  const redirectContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const redirectPage = await redirectContext.newPage();
  try {
    await redirectPage.goto(`${baseUrl}/`, { waitUntil: "load" });
    await redirectPage.waitForURL("**/login", { timeout: 15_000 });
    await redirectPage.waitForLoadState("networkidle");
    await setTheme(redirectPage, "dark");
    await capture(redirectPage, "root-redirects-login-1440-dark");
    await runAxe(redirectPage, "root redirect login 1440 dark");
  } catch (error) {
    failures.push(`root redirect check failed: ${error.message}`);
  } finally {
    await redirectContext.close();
  }
} finally {
  await browser.close();
}

console.log(
  JSON.stringify({ baseUrl, outDir, screenshots, axeSummaries }, null, 2),
);

if (failures.length > 0) {
  console.error("accessibility check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("accessibility check passed");
