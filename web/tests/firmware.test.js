const test = require("node:test");
const assert = require("node:assert/strict");
const firmware = require("../js/firmware.js");

const target = { flashBase: 0x08000000, flashSize: 64 * 1024 };

function intelHexRecord(address, type, data = []) {
  const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
  const checksum = (-bytes.reduce((sum, value) => sum + value, 0)) & 0xff;
  return `:${bytes.concat(checksum).map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

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

test("parses Intel HEX extended linear addresses and validates checksum", () => {
  const text = [
    intelHexRecord(0, 4, [0x08, 0x00]),
    intelHexRecord(0x0010, 0, [1, 2, 3]),
    intelHexRecord(0x0020, 0, [4, 5]),
    intelHexRecord(0, 1),
  ].join("\n");
  const parsed = firmware.parseIntelHex(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].address, 0x08000010);
  assert.deepEqual(parsed[0].data, Uint8Array.of(1, 2, 3));
  assert.throws(() => firmware.parseIntelHex(text.replace(/.$/, "0")), /校验和/);
});

test("parses ELF32 PT_LOAD segments and skips zero-file-size BSS", () => {
  const bytes = new Uint8Array(0x120);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 2, true);
  view.setUint16(18, 40, true);
  view.setUint32(28, 52, true);
  view.setUint16(40, 52, true);
  view.setUint16(42, 32, true);
  view.setUint16(44, 2, true);
  const program = 52;
  view.setUint32(program, 1, true);
  view.setUint32(program + 4, 0x100, true);
  view.setUint32(program + 8, 0x08000000, true);
  view.setUint32(program + 12, 0x08000000, true);
  view.setUint32(program + 16, 4, true);
  view.setUint32(program + 20, 8, true);
  view.setUint32(program + 32, 1, true);
  view.setUint32(program + 36, 0x104, true);
  view.setUint32(program + 40, 0x08000010, true);
  view.setUint32(program + 44, 0x08000010, true);
  view.setUint32(program + 48, 0, true);
  view.setUint32(program + 52, 4, true);
  bytes.set([9, 8, 7, 6], 0x100);
  const parsed = firmware.parseElf(bytes);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].address, 0x08000000);
  assert.deepEqual(parsed[0].data, Uint8Array.of(9, 8, 7, 6));
});

test("merges sparse HEX/ELF-style segments and preserves erased gaps", () => {
  const merged = firmware.mergeFirmware([{ name: "app.hex", kind: "HEX", segments: [
    { address: 0x08000000, data: Uint8Array.of(1, 2) },
    { address: 0x08000004, data: Uint8Array.of(3, 4) },
  ] }], target);
  assert.deepEqual(merged.image, Uint8Array.of(1, 2, 0xff, 0xff, 3, 4));
  assert.equal(firmware.parseFirmwareFile("app.bin", Uint8Array.of(1)).kind, "BIN");
});
