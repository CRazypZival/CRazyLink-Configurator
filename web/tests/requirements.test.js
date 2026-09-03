const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
const app = fs.readFileSync(path.join(webRoot, "app.js"), "utf8");
const css = fs.readFileSync(path.join(webRoot, "app.css"), "utf8");

test("flash target selector includes plain STM32, AT32, and GD32 labels", () => {
  assert.match(html, /option value="stm32f103c8">STM32<\/option>/);
  assert.match(html, /option value="at32">AT32<\/option>/);
  assert.match(html, /option value="gd32">GD32<\/option>/);
  assert.doesNotMatch(html, /STM32F1\s*·/);
  assert.match(app, /label: "AT32"/);
  assert.match(app, /label: "GD32"/);
  assert.match(app, /label: "STM32"/);
  assert.match(app, /请使用 CMSIS-DAP \/ OpenOCD 烧录/);
});

test("flash reset setting is sent in the job options and reports its result", () => {
  assert.match(app, /reset: \$\("#resetCheck"\)\.checked/);
  assert.match(app, /resetRequested = \$\("#resetCheck"\)\.checked/);
  assert.match(html, /id="resetCheck" type="checkbox"/);
  assert.match(html, /data-switch="reset" role="switch" aria-checked="true"/);
  assert.match(app, /row\.setAttribute\("aria-checked", checked\)/);
});

test("serial send format controls are mutually exclusive radios", () => {
  assert.match(html, /id="hexSendCheck" name="sendFormat" type="radio"/);
  assert.match(html, /id="asciiSendCheck" name="sendFormat" type="radio"/);
  assert.match(app, /syncSendFormat/);
  assert.match(css, /\.format-control label\.is-selected/);
  assert.match(html, /data-format-option="hex" aria-checked="false"/);
  assert.match(html, /data-format-option="ascii" aria-checked="true"/);
  assert.match(app, /label\.dataset\.selected = String\(selected\)/);
  assert.match(app, /label\.setAttribute\("aria-checked", String\(selected\)\)/);
});

test("serial configuration supports a validated custom baud rate", () => {
  assert.match(html, /id="customBaudCheck" type="checkbox"/);
  assert.match(html, /id="customBaudInput" type="number" min="1200" max="921600"/);
  assert.match(app, /function selectedBaudRate\(\)/);
  assert.match(app, /波特率必须是 1200 到 921600 之间的整数/);
  assert.match(app, /const baudRate = selectedBaudRate\(\)/);
  assert.match(app, /baudRate, dataBits/);
});

test("upgrade flow has connection prompts and exclusive disclosure styling", () => {
  assert.match(html, /id="upgradeConnectionPromptCard"/);
  assert.match(html, /id="unsupportedDevicePromptCard"/);
  assert.match(html, /id="upgradeUsbChoice"/);
  assert.match(html, /id="upgradeSerialChoice"/);
  assert.match(html, /UART0 \/ USB Download Mode/);
  assert.match(html, /id="upgradeCardBody"/);
  assert.match(html, /class="runtime-mode-hint"/);
  assert.match(app, /setDisclosure\("#runtimeModePanel", "#runtimeModeDisclosure", false\)/);
  assert.match(app, /setDisclosure\("#upgradeCardBody", "#upgradeCardDisclosure", false\)/);
  assert.match(app, /view\.dataset\.variant = variant/);
  assert.match(app, /if \(previousVariant !== variant\)/);
  assert.match(html, /data-view-panel="upgrade"[\s\S]*?id="blankFlashCard"/);
  assert.doesNotMatch(app, /flashNav\.classList\.toggle\("is-active", blankMode\)/);
  assert.doesNotMatch(app, /upgradeNav\.classList\.toggle\("is-active", !blankMode\)/);
  assert.match(app, /selectUpgradeAutomatically/);
  assert.match(app, /detectAuthorized\(\)/);
  assert.match(app, /const upgradeConnected = Boolean\(state\.upgrade\.transport\)/);
  assert.match(app, /const reconnectLabel =/);
  assert.match(app, /connectionState === "busy"/);
  assert.doesNotMatch(app, /upgradeConnected \? "断开连接"/);
  assert.doesNotMatch(app, /connected \? "断开设备"/);
  assert.match(app, /async function chooseUpgradeConnection\(\)/);
  assert.match(app, /state\.upgrade\.transport \|\| state\.device \|\| state\.upgrade\.serialPort/);
  assert.match(app, /if \(!dialog\.open\) dialog\.showModal\(\)/);
  assert.match(app, /app\.manager\.requestDevice\(\)/);
  assert.match(app, /app\.espFlasher\.requestPort\(\)/);
  assert.doesNotMatch(app, /async function chooseUpgradeConnection\(\)[\s\S]*?await selectUpgradeAutomatically\(\)/);
  assert.match(app, /if \(state\.view === "upgrade"\) \{\s*await chooseUpgradeConnection\(\)/);
  assert.doesNotMatch(app, /if \(state\.upgrade\.transport\) \{\s*await disconnectDevice\(\)\s*\}\s*await selectUpgradeAutomatically\(\)/);
  assert.match(app, /state\.upgrade\.serialPort = null/);
  assert.match(app, /RELEASES_PAGE/);
  assert.match(css, /\.upgrade-config-card\[data-expanded="false"\]/);
  assert.match(css, /\.runtime-mode-card\[data-expanded="true"\]/);
  assert.match(css, /\.runtime-mode-card\[data-expanded="true"\] \.runtime-mode-disclosure \{[^}]*padding: 16px 16px 12px/);
  assert.match(css, /\.upgrade-prompt-card \{[^}]*min-height: 32px/);
});

test("WebUSB authorization and connection have one explicit lifecycle", () => {
  assert.match(app, /selectedDevice = await (?:app\.)?manager\.selectDevice\(\)/);
  assert.match(app, /setConnection\("busy", "正在连接 CRazyLink…"\)/);
  assert.match(app, /connection = await manager\.connectDevice\(selectedDevice\)/);
  assert.match(app, /if \(state\.connecting\) return/);
  assert.match(app, /if \(connection\) await releaseUsbConnection\(connection\)/);
  assert.match(app, /async function selectUpgradeSerial\(\)[\s\S]*?state\.connecting = true/);
  const bootSource = app.slice(app.indexOf("async function boot()"), app.indexOf("window.CRazyLinkApp"));
  assert.doesNotMatch(bootSource, /connectAuthorized\(\)/);
});

test("Configurator version is consistent across source metadata and sidebar", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(webRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(webRoot, "package-lock.json"), "utf8"));
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.match(html, new RegExp(`class="app-version">v${packageJson.version} \\u00b7`));
});
