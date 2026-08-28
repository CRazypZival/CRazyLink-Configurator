const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const webRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
const app = fs.readFileSync(path.join(webRoot, "app.js"), "utf8");
const css = fs.readFileSync(path.join(webRoot, "app.css"), "utf8");

test("flash target selector includes STM32F1, AT32, and GD32", () => {
  assert.match(html, /option value="stm32f103c8"/);
  assert.match(html, /option value="at32"/);
  assert.match(html, /option value="gd32"/);
});

test("flash reset setting is sent in the job options and reports its result", () => {
  assert.match(app, /reset: \$\("#resetCheck"\)\.checked/);
  assert.match(app, /resetRequested = \$\("#resetCheck"\)\.checked/);
  assert.match(html, /id="resetCheck" type="checkbox"/);
});

test("serial send format controls are mutually exclusive radios", () => {
  assert.match(html, /id="hexSendCheck" name="sendFormat" type="radio"/);
  assert.match(html, /id="asciiSendCheck" name="sendFormat" type="radio"/);
  assert.match(app, /syncSendFormat/);
  assert.match(css, /\.format-control label\.is-selected/);
});

test("upgrade flow has connection prompts and exclusive disclosure styling", () => {
  assert.match(html, /id="upgradeConnectionPromptCard"/);
  assert.match(html, /id="unsupportedDevicePromptCard"/);
  assert.match(html, /id="upgradeCardBody"/);
  assert.match(html, /class="runtime-mode-hint"/);
  assert.match(app, /setDisclosure\("#runtimeModePanel", "#runtimeModeDisclosure", false\)/);
  assert.match(app, /setDisclosure\("#upgradeCardBody", "#upgradeCardDisclosure", false\)/);
  assert.match(css, /\.upgrade-config-card\[data-expanded="false"\]/);
  assert.match(css, /\.runtime-mode-card\[data-expanded="true"\]/);
  assert.match(css, /\.upgrade-prompt-card \{[^}]*min-height: 32px/);
});
