import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.CRAZYLINK_WEB_URL || "http://127.0.0.1:4173/?view=upgrade";
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outputDirectory = process.env.CRAZYLINK_VISUAL_OUTPUT || "/tmp/crazylink-visual";
const viewports = [
  { name: "desktop-1440", width: 1440, height: 960 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "mobile-320", width: 320, height: 920 },
  { name: "mobile-375", width: 375, height: 920 },
  { name: "mobile-414", width: 414, height: 920 },
];

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const failures = [];
try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const consoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.route("https://api.github.com/repos/CRazypZival/CRazyLink-Configurator/releases?per_page=30", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ tag_name: "v1.1.0", draft: false, prerelease: false, published_at: "2026-08-26T00:00:00Z", assets: [{ name: "manifest.json", browser_download_url: "https://example.invalid/manifest.json" }] }]),
    }));
    await page.route("https://example.invalid/manifest.json", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ packages: [{ role: "CRAZYLINK", file: "CRazyLink_v1.1.0.crl" }] }),
    }));
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("#upgradeStatusText")?.textContent.includes("设备可用"));
    const layout = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      bodyWidth: document.body.scrollWidth,
      activeView: document.querySelector(".view.is-active")?.id,
      buttonText: document.querySelector("#upgradeFlashButton")?.textContent.trim(),
      clipped: Array.from(document.querySelectorAll(".upgrade-view *")).filter((element) => {
        const style = getComputedStyle(element);
        return element.scrollWidth > element.clientWidth + 1 && !["auto", "scroll"].includes(style.overflowX);
      }).map((element) => element.id || element.className).slice(0, 10),
    }));
    if (layout.documentWidth > layout.viewportWidth || layout.bodyWidth > layout.viewportWidth) failures.push(`${viewport.name}: horizontal overflow`);
    if (layout.activeView !== "upgradeView") failures.push(`${viewport.name}: upgrade view is not active`);
    if (layout.buttonText !== "更新 CRazyLink") failures.push(`${viewport.name}: upgrade action label changed`);
    if (layout.clipped.length) failures.push(`${viewport.name}: clipped elements ${layout.clipped.join(", ")}`);
    if (consoleErrors.length) failures.push(`${viewport.name}: console errors ${consoleErrors.join(" | ")}`);
    await page.screenshot({ path: resolve(outputDirectory, `${viewport.name}.png`), fullPage: true });
    if (viewport.name === "desktop-1440") {
      if (await page.locator("#upgradeReleaseSelect option").count() !== 2) failures.push("desktop-1440: release selector did not load");
      if (await page.locator("#blankFlashCard").isVisible()) failures.push("desktop-1440: blank flash card is visible before UART0 selection");
      await page.locator("#connectButton").click();
      if (!await page.locator("#upgradeDeviceDialog").isVisible()) failures.push("desktop-1440: device dialog did not open");
      if (await page.locator(".upgrade-device-choice").count() !== 2) failures.push("desktop-1440: device choices are incomplete");
      await page.locator("#closeUpgradeDeviceDialog").click();
    }
    console.log(`${viewport.name}: ${layout.viewportWidth}px, no horizontal overflow`);
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`visual check: PASS (${outputDirectory})`);
}
