const test = require("node:test");
const assert = require("node:assert/strict");

const { EspSerialFlasher, describeSerialPort } = require("../js/esptool.js");

function firmware(role = "TX") {
  return {
    manifest: { chip: "ESP32-S3", role },
    segments: [
      { name: "bootloader", address: 0, data: Uint8Array.of(1, 2) },
      { name: "application", address: 0x10000, data: Uint8Array.of(3, 4, 5) },
    ],
  };
}

test("describes FTDI and native ESP32-S3 serial ports", () => {
  assert.equal(describeSerialPort({ getInfo: () => ({ usbVendorId: 0x0403, usbProductId: 0x6015 }) }), "FTDI UART0 · 0403:6015");
  assert.equal(describeSerialPort({ getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }) }), "ESP32-S3 USB Download Mode · 303A:1001");
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
