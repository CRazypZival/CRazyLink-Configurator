const test = require("node:test");
const assert = require("node:assert/strict");
const protocol = require("../js/protocol.js");

test("CRC32 matches the standard vector", () => {
  assert.equal(protocol.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("WebUSB packet preserves maximum binary payload", () => {
  const data = Uint8Array.from({ length: protocol.WEBUSB_DATA_SIZE }, (_, index) => index ^ 0xa5);
  const encoded = protocol.encodePacket({
    opcode: protocol.WebOpcode.JOB_DATA,
    flags: protocol.WebPacketFlag.BUSY,
    sequence: 0xa55a,
    offset: 0x10203040,
    data,
  });
  const decoded = protocol.decodePacket(encoded);
  assert.equal(decoded.opcode, protocol.WebOpcode.JOB_DATA);
  assert.equal(decoded.flags, protocol.WebPacketFlag.BUSY);
  assert.equal(decoded.sequence, 0xa55a);
  assert.equal(decoded.offset, 0x10203040);
  assert.deepEqual(decoded.data, data);
});

test("WebUSB packet rejects corruption and excess data", () => {
  const encoded = protocol.encodePacket({ opcode: protocol.WebOpcode.DEVICE_INFO });
  encoded[20] ^= 1;
  assert.throws(() => protocol.decodePacket(encoded), /CRC/);
  assert.throws(
    () => protocol.encodePacket({ opcode: 1, data: new Uint8Array(protocol.WEBUSB_DATA_SIZE + 1) }),
    /47 bytes/,
  );
});

test("protocol exposes the local device information opcode", () => {
  assert.equal(protocol.WebOpcode.LOCAL_DEVICE_INFO, 18);
});
