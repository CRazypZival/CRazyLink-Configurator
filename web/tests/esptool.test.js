const test = require("node:test");
const assert = require("node:assert/strict");

const { EspSerialFlasher, describeSerialPort, isLikelyEsp32Port, validatePackage } = require("../js/esptool.js");

function firmware(role = "TX") {
  return {
    manifest: { chip: "ESP32-S3", role, flashSize: 8 * 1024 * 1024 },
    segments: [
      { name: "bootloader", address: 0, data: Uint8Array.of(1, 2) },
      { name: "application", address: 0x10000, data: Uint8Array.of(3, 4, 5) },
    ],
  };
}

test("serial flasher rejects overlapping or out-of-range CRL segments", () => {
  assert.throws(() => validatePackage({
    manifest: { chip: "ESP32-S3", flashSize: 0x100 },
    segments: [
      { name: "a", address: 0, data: Uint8Array.of(1, 2) },
      { name: "b", address: 1, data: Uint8Array.of(3) },
    ],
  }), /重叠/);
  assert.throws(() => validatePackage({
    manifest: { chip: "ESP32-S3", flashSize: 0x100 },
    segments: [{ name: "a", address: 0xff, data: Uint8Array.of(1, 2) }],
  }), /超出 Flash/);
});

test("describes FTDI and native ESP32-S3 serial ports", () => {
  assert.equal(describeSerialPort({ getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6015 }) }), "FTDI UART0 · 0403:6015");
  assert.equal(describeSerialPort({ getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) }), "ESP32-S3 USB Download Mode · 303A:1001");
});

test("auto-detects an authorized ESP32-S3 port by USB enumeration", async () => {
  const good = { getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) };
  const wrong = { getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }) };
  const calls = [];
  class Transport {
    constructor(port) { calls.push(port); }
    async disconnect() {}
  }
  class ESPLoader {
    async main() { return "ESP32-S3"; }
  }
  const flasher = new EspSerialFlasher({
    serial: { getPorts: async () => [wrong, good] },
    library: { Transport, ESPLoader, md5: () => "md5" },
  });
  assert.equal(isLikelyEsp32Port(wrong), false);
  const result = await flasher.detectAuthorized();
  assert.equal(result.port, good);
  assert.equal(result.chip, "ESP32-S3");
  assert.deepEqual(calls, [good]);
});

test("serial probe confirms an ESP32-S3 and closes its transport", async () => {
  const calls = [];
  class Transport {
    constructor(port) { calls.push(["transport", port]); }
    async disconnect() { calls.push(["disconnect"]); }
  }
  class ESPLoader {
    constructor(options) { calls.push(["loader", options.baudrate]); }
    async main(mode) { calls.push(["main", mode]); return "ESP32-S3 (revision v0.2)"; }
  }
  const flasher = new EspSerialFlasher({
    serial: { requestPort: async () => ({}) },
    library: { Transport, ESPLoader, md5: () => "md5" },
  });
  const result = await flasher.probe({ name: "port" });
  assert.equal(result.chip, "ESP32-S3 (revision v0.2)");
  assert.deepEqual(calls, [
    ["transport", { name: "port" }],
    ["loader", 460800],
    ["main", "default_reset"],
    ["disconnect"],
  ]);
});

test("serial probe rejects non-S3 chips and always closes its transport", async () => {
  let disconnected = false;
  class Transport { async disconnect() { disconnected = true; } }
  class ESPLoader { async main() { return "ESP32-C3"; } }
  const flasher = new EspSerialFlasher({
    serial: { requestPort: async () => ({}) },
    library: { Transport, ESPLoader, md5: () => "md5" },
  });
  await assert.rejects(() => flasher.probe({}), /ESP32-S3/);
  assert.equal(disconnected, true);
});

test("serial probe closes its transport after a ROM connection error", async () => {
  let disconnected = false;
  class Transport { async disconnect() { disconnected = true; } }
  class ESPLoader { async main() { throw new Error("Unable to connect"); } }
  const flasher = new EspSerialFlasher({
    serial: { requestPort: async () => ({}) },
    library: { Transport, ESPLoader, md5: () => "md5" },
  });
  await assert.rejects(() => flasher.probe({}), /Unable to connect/);
  assert.equal(disconnected, true);
});

test("serial flasher writes every CRL segment and verifies with MD5", async () => {
  const calls = [];
  class Transport {
    constructor(port) { calls.push(["transport", port]); }
    async disconnect() { calls.push(["disconnect"]); }
  }
  class ESPLoader {
    constructor(options) { calls.push(["loader", options.baudrate]); }
    async main(mode) { calls.push(["main", mode]); return "ESP32-S3 (revision v0.2)"; }
    async writeFlash(options) {
      calls.push(["write", options.fileArray.map((entry) => [entry.address, Array.from(entry.data)]), options.eraseAll]);
      assert.equal(options.calculateMD5Hash(Uint8Array.of(1)), "md5");
      options.reportProgress(0, 2, 2);
      options.reportProgress(1, 3, 3);
    }
    async after(mode) { calls.push(["after", mode]); }
  }
  const progress = [];
  const flasher = new EspSerialFlasher({
    serial: { requestPort: async () => ({}) },
    library: { Transport, ESPLoader, md5: () => "md5" },
  });
  const result = await flasher.flash({ name: "port" }, firmware(), { eraseAll: true, onProgress: (value) => progress.push(value) });
  assert.equal(result.bytesWritten, 5);
  assert.deepEqual(progress, [40, 100]);
  assert.deepEqual(calls.at(-1), ["disconnect"]);
  assert.ok(calls.some((entry) => entry[0] === "after" && entry[1] === "hard_reset"));
});

test("serial flasher rejects a non-S3 chip and always disconnects", async () => {
  let disconnected = false;
  class Transport { async disconnect() { disconnected = true; } }
  class ESPLoader { async main() { return "ESP32-C3"; } }
  const flasher = new EspSerialFlasher({
    serial: { requestPort: async () => ({}) },
    library: { Transport, ESPLoader, md5: () => "md5" },
  });
  await assert.rejects(() => flasher.flash({}, firmware()), /ESP32-S3/);
  assert.equal(disconnected, true);
});
