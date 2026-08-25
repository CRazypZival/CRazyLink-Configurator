const test = require("node:test");
const assert = require("node:assert/strict");
const firmware = require("../js/firmware.js");

const target = { flashBase: 0x08000000, flashSize: 64 * 1024 };

test("first BIN defaults to 0x08000000 and gaps are erased bytes", () => {
  const merged = firmware.mergeFirmware([
    { name: "boot.bin", data: Uint8Array.of(1, 2) },
    { name: "app.bin", address: "0x08000004", data: Uint8Array.of(3, 4) },
  ], target);
  assert.equal(merged.base, 0x08000000);
  assert.equal(merged.end, 0x08000006);
  assert.deepEqual(merged.image, Uint8Array.of(1, 2, 0xff, 0xff, 3, 4));
});

test("merge rejects overlap, fourth image, and target overflow", () => {
  assert.throws(() => firmware.mergeFirmware([
    { name: "a.bin", address: 0x08000000, data: new Uint8Array(8) },
    { name: "b.bin", address: 0x08000004, data: new Uint8Array(8) },
  ], target), /重叠/);
  assert.throws(() => firmware.mergeFirmware([1, 2, 3, 4].map((_, index) => ({
    address: 0x08000000 + index,
    data: Uint8Array.of(index),
  })), target), /三个/);
  assert.throws(() => firmware.mergeFirmware([
    { address: 0x0800ffff, data: Uint8Array.of(1, 2) },
  ], target), /Flash/);
});

test("address parsing is strict and formats fixed-width uppercase hex", () => {
  assert.equal(firmware.parseAddress("0x08001000"), 0x08001000);
  assert.equal(firmware.formatAddress(0x8001000), "0x08001000");
  assert.throws(() => firmware.parseAddress("0x0800zzzz"), /格式/);
});
