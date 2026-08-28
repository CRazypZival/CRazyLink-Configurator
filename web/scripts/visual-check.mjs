import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = new URL(process.env.CRAZYLINK_WEB_URL || "http://127.0.0.1:4173/");
const chromePath = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outputDirectory = process.env.CRAZYLINK_VISUAL_OUTPUT || "/tmp/crazylink-visual";
const viewSpecs = [
  { name: "flash", activeId: "flashView" },
  { name: "serial", activeId: "serialView" },
  { name: "upgrade", activeId: "upgradeView" },
];
const viewports = [
  { name: "desktop-1440", width: 1440, height: 960 },
  { name: "tablet-1024", width: 1024, height: 768 },
  { name: "mobile-320", width: 320, height: 920 },
  { name: "mobile-375", width: 375, height: 920 },
  { name: "mobile-414", width: 414, height: 920 },
];

function routeUrl(view) {
  const url = new URL(baseUrl);
  url.searchParams.set("view", view);
  return url.toString();
}

async function configureReleaseMocks(page) {
  await page.route("https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "window.lucide={createIcons:function(){}};",
  }));
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
}

async function verifyFlashTablet(page, failures) {
  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      erase: rect("#eraseSelect"),
      speed: rect("#speedSelect"),
      target: rect("#targetSelect"),
      action: rect("#flashButton"),
      settings: rect(".flash-settings-panel"),
    };
  });
  if (!layout.erase || !layout.speed || !layout.target || !layout.action || !layout.settings) {
    failures.push("flash/tablet-1024: action band controls are missing");
    return;
  }
  const rowCenter = layout.erase.y + layout.erase.height / 2;
  const sameRow = [layout.speed, layout.target, layout.action].every((item) => Math.abs(item.y + item.height / 2 - rowCenter) < 5);
  const ordered = layout.erase.x < layout.speed.x && layout.speed.x < layout.target.x && layout.target.x < layout.action.x;
  if (!sameRow || !ordered) failures.push("flash/tablet-1024: controls are not a single ordered action band");
  if (Math.abs(layout.action.width - 168) > 2) failures.push("flash/tablet-1024: flash action width is not 168px");
  if (layout.settings.height > 128) failures.push("flash/tablet-1024: action band is taller than Pencil reference");
}

async function verifySerialTablet(page, failures) {
  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height, visible: getComputedStyle(element).display !== "none" };
    };
    return {
      config: rect(".serial-config-bar"),
      title: rect(".serial-config-title"),
      listening: rect(".listening-state"),
      baud: rect(".field-label:has(#baudSelect)"),
      dataBits: rect(".field-label:has(#dataBitsSelect)"),
      stopBits: rect(".field-label:has(#stopBitsSelect)"),
      parity: rect(".field-label:has(#paritySelect)"),
      flow: rect(".flow-field"),
      terminal: rect(".terminal-panel"),
    };
  });
  const fields = [layout.baud, layout.dataBits, layout.stopBits, layout.parity, layout.flow];
  if (fields.some((item) => !item?.visible) || !layout.title || !layout.listening || !layout.terminal || !layout.config) {
    failures.push("serial/tablet-1024: complete parameter controls are missing");
    return;
  }
  const fieldsShareRow = fields.every((item) => Math.abs(item.y - layout.baud.y) < 2);
  if (!fieldsShareRow || Math.abs(layout.title.y - layout.listening.y) >= 2 || layout.terminal.y <= layout.config.y + layout.config.height) {
    failures.push("serial/tablet-1024: configuration rows do not match Pencil structure");
  }
  if (layout.config.height > 110) failures.push("serial/tablet-1024: configuration bar is taller than Pencil reference");
}

async function verifyUpgradeStates(page, failures) {
  const disconnected = await page.evaluate(() => ({
    variant: document.querySelector("#upgradeView")?.dataset.variant,
    connectionPromptVisible: !document.querySelector("#upgradeConnectionPromptCard")?.hidden,
    upgradeVisible: !document.querySelector(".upgrade-config-card")?.hidden,
    runtimeVisible: !document.querySelector(".runtime-mode-card")?.hidden,
  }));
  if (disconnected.variant !== "disconnected" || !disconnected.connectionPromptVisible || disconnected.upgradeVisible || disconnected.runtimeVisible) {
    failures.push("upgrade: disconnected state does not match the Pencil prompt layout");
  }

  await page.evaluate(() => { window.CRazyLinkApp.state.upgrade.transport = "usb"; });
  await page.locator('.nav-item[data-view="upgrade"]').click();
  await page.waitForFunction(() => document.querySelector("#upgradeView")?.dataset.variant === "crazylink");
  await page.locator("#runtimeModeDisclosure").click();
  const runtimeExpanded = await page.evaluate(() => ({
    upgradeHidden: document.querySelector("#upgradeCardBody")?.hidden,
    runtimeHidden: document.querySelector("#runtimeModePanel")?.hidden,
  }));
  if (!runtimeExpanded.upgradeHidden || runtimeExpanded.runtimeHidden) {
    failures.push("upgrade: expanding runtime mode does not collapse firmware upgrade");
  }

  await page.locator("#upgradeCardDisclosure").click();
  const upgradeExpanded = await page.evaluate(() => ({
    upgradeHidden: document.querySelector("#upgradeCardBody")?.hidden,
    runtimeHidden: document.querySelector("#runtimeModePanel")?.hidden,
  }));
  if (upgradeExpanded.upgradeHidden || !upgradeExpanded.runtimeHidden) {
    failures.push("upgrade: expanding firmware upgrade does not collapse runtime mode");
  }
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const failures = [];
try {
  for (const view of viewSpecs) {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const consoleErrors = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("pageerror", (error) => consoleErrors.push(error.message));
      await configureReleaseMocks(page);
      await page.goto(routeUrl(view.name), { waitUntil: "networkidle" });
      await page.waitForFunction((activeId) => document.getElementById(activeId)?.classList.contains("is-active"), view.activeId);
      if (view.name === "upgrade") await page.waitForFunction(() => {
        const text = document.querySelector("#upgradeStatusText")?.textContent || "";
        return text.includes("设备可用") || text.includes("请连接设备") || text.includes("请插入设备");
      });
      const layout = await page.evaluate((activeId) => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        bodyWidth: document.body.scrollWidth,
        activeView: document.querySelector(".view.is-active")?.id,
        clipped: Array.from(document.querySelectorAll(`#${activeId} *`)).filter((element) => {
          const style = getComputedStyle(element);
          return style.display !== "none" && !element.closest(".sr-only") && element.id !== "firmwareInput" && element.scrollWidth > element.clientWidth + 1 && !["auto", "scroll"].includes(style.overflowX);
        }).map((element) => element.id || element.className).slice(0, 10),
      }), view.activeId);
      if (layout.documentWidth > layout.viewportWidth || layout.bodyWidth > layout.viewportWidth) failures.push(`${view.name}/${viewport.name}: horizontal overflow`);
      if (layout.activeView !== view.activeId) failures.push(`${view.name}/${viewport.name}: incorrect active view`);
      if (layout.clipped.length) failures.push(`${view.name}/${viewport.name}: clipped elements ${layout.clipped.join(", ")}`);
      if (consoleErrors.length) failures.push(`${view.name}/${viewport.name}: console errors ${consoleErrors.join(" | ")}`);
      if (view.name === "flash" && viewport.name === "tablet-1024") await verifyFlashTablet(page, failures);
      if (view.name === "serial" && viewport.name === "tablet-1024") await verifySerialTablet(page, failures);
      if (view.name === "upgrade" && viewport.name === "desktop-1440" && await page.locator("#upgradeReleaseSelect option").count() !== 2) {
        failures.push("upgrade/desktop-1440: release selector did not load");
      }
      if (view.name === "upgrade" && viewport.name === "desktop-1440") await verifyUpgradeStates(page, failures);
      await page.screenshot({ path: resolve(outputDirectory, `${view.name}-${viewport.name}.png`), fullPage: true });
      console.log(`${view.name}/${viewport.name}: ${layout.viewportWidth}px, no horizontal overflow`);
      await page.close();
    }
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
