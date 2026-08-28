const test = require("node:test");
const assert = require("node:assert/strict");

const { upgradeVariant } = require("../js/ui-state.js");

test("upgrade state identifies an unconnected device", () => {
  assert.equal(upgradeVariant({ transport: null, serialProbeState: "idle" }), "disconnected");
});

test("upgrade state identifies a CRazyLink USB device", () => {
  assert.equal(upgradeVariant({ transport: "usb", serialProbeState: "idle" }), "crazylink");
});

test("upgrade state identifies an ESP32-S3 download-mode device", () => {
  assert.equal(upgradeVariant({ transport: "serial", serialProbeState: "ready" }), "blank");
});

test("upgrade state distinguishes unsupported and missing serial targets", () => {
  assert.equal(upgradeVariant({ transport: null, serialProbeState: "unsupported" }), "unsupported");
  assert.equal(upgradeVariant({ transport: null, serialProbeState: "missing" }), "download-required");
});
