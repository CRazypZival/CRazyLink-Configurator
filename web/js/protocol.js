(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CRazyLink = Object.assign(root.CRazyLink || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PACKET_SIZE = 64;
  const CRC_OFFSET = 60;
  const DATA_OFFSET = 13;
  const DATA_SIZE = CRC_OFFSET - DATA_OFFSET;
  const COMMAND = 0x80;
  const MAGIC_0 = 0x43;
  const MAGIC_1 = 0x4c;
  const VERSION = 1;

  const Opcode = Object.freeze({
    DEVICE_INFO: 1,
    SET_MODE: 2,
    JOB_BEGIN: 3,
    JOB_DATA: 4,
    JOB_COMMIT: 5,
    FLASH_START: 6,
    FLASH_STATUS: 7,
    JOB_INFO: 8,
    UART_CONFIG: 9,
    UART_WRITE: 10,
    UART_READ: 11,
    UART_CLOSE: 12,
    OTA_BEGIN: 13,
    OTA_DATA: 14,
    OTA_COMMIT: 15,
    REBOOT: 16,
    FLASH_CANCEL: 17,
  });

  const PacketFlag = Object.freeze({
    RESPONSE: 1,
    ERROR: 2,
    BUSY: 4,
  });

  function asBytes(value) {
    if (value == null) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return Uint8Array.from(value);
  }

  function crc32(value, length) {
    const bytes = asBytes(value);
    const count = length == null ? bytes.length : length;
    let crc = 0xffffffff;
    for (let index = 0; index < count; index += 1) {
      crc ^= bytes[index];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function encodePacket(input) {
    const data = asBytes(input.data);
    if (!Number.isInteger(input.opcode) || input.opcode < 1 || input.opcode > 0xff) {
      throw new TypeError("Invalid WebUSB opcode");
    }
    if (data.length > DATA_SIZE) throw new RangeError("WebUSB packet data exceeds 47 bytes");

    const packet = new Uint8Array(PACKET_SIZE);
    const view = new DataView(packet.buffer);
    packet[0] = COMMAND;
    packet[1] = MAGIC_0;
    packet[2] = MAGIC_1;
    packet[3] = VERSION;
    packet[4] = input.opcode;
    packet[5] = input.flags || 0;
    view.setUint16(6, input.sequence || 0, true);
    view.setUint32(8, input.offset || 0, true);
    packet[12] = data.length;
    packet.set(data, DATA_OFFSET);
    view.setUint32(CRC_OFFSET, crc32(packet, CRC_OFFSET), true);
    return packet;
  }

  function decodePacket(value) {
    const input = asBytes(value);
    if (input.length !== PACKET_SIZE) throw new Error("WebUSB response is not 64 bytes");
    if (input[0] !== COMMAND || input[1] !== MAGIC_0 || input[2] !== MAGIC_1) {
      throw new Error("WebUSB response magic is invalid");
    }
    if (input[3] !== VERSION) throw new Error("WebUSB protocol version is not supported");
    if (input[12] > DATA_SIZE) throw new Error("WebUSB response data length is invalid");

    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    if (view.getUint32(CRC_OFFSET, true) !== crc32(input, CRC_OFFSET)) {
      throw new Error("WebUSB response CRC is invalid");
    }
    return {
      opcode: input[4],
      flags: input[5],
      sequence: view.getUint16(6, true),
      offset: view.getUint32(8, true),
      data: input.slice(DATA_OFFSET, DATA_OFFSET + input[12]),
      raw: input.slice(),
    };
  }

  return {
    WEBUSB_PACKET_SIZE: PACKET_SIZE,
    WEBUSB_DATA_SIZE: DATA_SIZE,
    WebOpcode: Opcode,
    WebPacketFlag: PacketFlag,
    asBytes,
    crc32,
    encodePacket,
    decodePacket,
  };
});
