import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const read = (name) => readFile(resolve(root, name), "utf8");
const packageJson = JSON.parse(await read("package.json"));
const version = `v${String(packageJson.version).replace(/^v/, "")}`;
const commit = (process.env.CONFIGURATOR_COMMIT || process.env.GITHUB_SHA || "dev").slice(0, 7);
const appVersion = `${version} · ${commit}`;

const html = await read("index.html");
const tokens = await read("tokens.css");
const css = await read("app.css");
const protocol = await read("js/protocol.js");
const firmware = await read("js/firmware.js");
const webusb = await read("js/webusb.js");
const uiState = await read("js/ui-state.js");
const release = await read("js/release.js");
const esptool = await read("js/esptool.js");
const app = await read("app.js");

const vendorBuild = await build({
  entryPoints: [resolve(root, "scripts/esptool-global-entry.mjs")],
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: ["chrome89"],
  write: false,
});
const esptoolVendor = vendorBuild.outputFiles[0].text;
const vendorOutput = resolve(root, "vendor/esptool-global.js");
await mkdir(dirname(vendorOutput), { recursive: true });
await writeFile(vendorOutput, esptoolVendor, "utf8");

let lucide = "window.lucide={createIcons:function(){}};";
try {
  const response = await fetch("https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js");
  if (response.ok) lucide = await response.text();
} catch (_) {
  // The single-file fallback remains usable without decorative icons.
}

const inline = html
  .replace(/\s*<link rel="manifest"[^>]*>/, "")
  .replace(/\s*<link rel="stylesheet" href="tokens\.css">/, "")
  .replace(/\s*<link rel="stylesheet" href="app\.css">/, () => `<style>\n${tokens}\n${css}\n</style>`)
  .replace(/(<div class="app-version">)[^<]*(<\/div>)/, `$1${appVersion}$2`)
  .replace(/\s*<script src="https:\/\/unpkg\.com\/lucide@0\.468\.0\/dist\/umd\/lucide\.min\.js"><\/script>/, () => `<script>${lucide}</script>`)
  .replace(/\s*<script src="js\/protocol\.js"><\/script>/, () => `<script>${protocol}</script>`)
  .replace(/\s*<script src="js\/firmware\.js"><\/script>/, () => `<script>${firmware}</script>`)
  .replace(/\s*<script src="js\/webusb\.js"><\/script>/, () => `<script>${webusb}</script>`)
  .replace(/\s*<script src="js\/ui-state\.js"><\/script>/, () => `<script>${uiState}</script>`)
  .replace(/\s*<script src="js\/release\.js"><\/script>/, () => `<script>${release}</script>`)
  .replace(/\s*<script src="vendor\/esptool-global\.js"><\/script>/, () => `<script>${esptoolVendor}</script>`)
  .replace(/\s*<script src="js\/esptool\.js"><\/script>/, () => `<script>${esptool}</script>`)
  .replace(/\s*<script src="app\.js"><\/script>/, () => `<script>${app}</script>`);

const output = resolve(root, "dist/index.html");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, inline, "utf8");
try {
  await cp(resolve(root, "releases"), resolve(root, "dist/releases"), { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(`single-file build: ${output} (${inline.length} bytes)`);
