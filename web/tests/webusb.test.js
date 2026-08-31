const test = require("node:test");
const assert = require("node:assert/strict");

global.CRazyLink = require("../js/protocol.js");
const { CrazylinkUsbDevice, findBulkInterface, describeBulkInterfaces } = require("../js/webusb.js");

function endpoint(direction, endpointNumber) {
  return { direction, type: "bulk", endpointNumber };
}

function device(alternates) {
  return { configuration: { interfaces: alternates.map((alternate, interfaceNumber) => ({ interfaceNumber, alternates: [alternate] })) } };
}

test("finds a named CMSIS-DAP v2 vendor bulk interface", () => {
  const found = findBulkInterface(device([{
    interfaceClass: 0xff,
    interfaceName: "CMSIS-DAP v2",
    alternateSetting: 0,
    endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
  }]));
  assert.deepEqual(found, {
    interfaceNumber: 0,
    alternateSetting: 0,
    inputEndpoint: 0x81,
    outputEndpoint: 1,
    interfaceName: "CMSIS-DAP v2",
  });
});

test("falls back to the only vendor bulk interface when its name is absent", () => {
  const found = findBulkInterface(device([{
    interfaceClass: 0xff,
    alternateSetting: 0,
    endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
  }]));
  assert.equal(found.interfaceNumber, 0);
  assert.equal(found.inputEndpoint, 0x81);
});

test("does not select a CDC bulk interface", () => {
  const found = findBulkInterface(device([{
    interfaceClass: 2,
    interfaceName: "TinyUSB CDC",
    alternateSetting: 0,
    endpoints: [endpoint("out", 3), endpoint("in", 0x84)],
  }]));
  assert.equal(found, null);
  assert.match(describeBulkInterfaces(device([{
    interfaceClass: 2,
    interfaceName: "TinyUSB CDC",
    alternateSetting: 0,
    endpoints: [endpoint("out", 3), endpoint("in", 0x84)],
  }])), /TinyUSB CDC/);
});

test("decodes local role, version, flash size, and OTA support", async () => {
  const connection = new CrazylinkUsbDevice({
    serialNumber: "ABC123",
    productName: "CRazyLink CMSIS-DAP",
  });
  connection.request = async (opcode) => {
    assert.equal(opcode, global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO);
    return { data: Uint8Array.of(3, 1, 1, 0, 8, 1, 0) };
  };
  assert.deepEqual(await connection.getLocalDeviceInfo(), {
    role: 3,
    firmwareVersion: "1.1.0",
    flashSize: 8 * 1024 * 1024,
    otaSupported: true,
    mode: 0,
    serialNumber: "ABC123",
    productName: "CRazyLink CMSIS-DAP",
  });
});

test("connect remains available for local TX OTA when RX is offline", async () => {
  const usbDevice = device([{
    interfaceClass: 0xff,
    interfaceName: "CMSIS-DAP v2",
    alternateSetting: 0,
    endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
  }]);
  Object.assign(usbDevice, {
    opened: true,
    serialNumber: "TX123",
    claimInterface: async () => {},
  });
  const connection = new CrazylinkUsbDevice(usbDevice);
  connection.getLocalDeviceInfo = async () => ({ role: 3, firmwareVersion: "1.1.0", flashSize: 8 * 1024 * 1024, otaSupported: true });
  connection.getDeviceInfo = async () => { throw new Error("RX offline"); };
  const info = await connection.connect();
  assert.equal(info.role, 3);
  assert.equal(info.peerConnected, false);
  assert.equal(info.firmwareVersion, "1.1.0");
});

test("USB OTA always targets the unified CRazyLink firmware", async () => {
  const connection = new CrazylinkUsbDevice({});
  connection.localInfo = { role: 2 };
  const requests = [];
  connection.request = async (opcode, options = {}) => {
    requests.push({ opcode, options });
    return {};
  };
  await connection.uploadOta(Uint8Array.from({ length: 48 }, (_, index) => index), () => {});
  assert.deepEqual(requests.map((entry) => entry.opcode), [
    global.CRazyLink.WebOpcode.OTA_BEGIN,
    global.CRazyLink.WebOpcode.OTA_DATA,
    global.CRazyLink.WebOpcode.OTA_DATA,
    global.CRazyLink.WebOpcode.OTA_COMMIT,
  ]);
  assert.equal(requests[0].options.data[0], 3);
});

test("USB OTA rejects an unknown local role", async () => {
  const connection = new CrazylinkUsbDevice({});
  await assert.rejects(() => connection.uploadOta(Uint8Array.of(0xe9)), /无法识别/);
});

test("request ignores TinyUSB zero-length packets", async () => {
  const response = global.CRazyLink.encodePacket({
    opcode: global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO,
    flags: global.CRazyLink.WebPacketFlag.RESPONSE,
    sequence: 1,
    data: Uint8Array.of(1, 1, 1, 0, 8, 1),
  });
  let reads = 0;
  const connection = new CrazylinkUsbDevice({
    opened: true,
    transferOut: async (_, data) => ({ status: "ok", bytesWritten: data.byteLength }),
    transferIn: async () => {
      reads += 1;
      if (reads === 1) return { status: "ok", data: new DataView(new ArrayBuffer(0)) };
      return { status: "ok", data: new DataView(response.buffer) };
    },
  });
  connection.interface = { inputEndpoint: 1, outputEndpoint: 1 };
  const packet = await connection.request(global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO);
  assert.equal(reads, 2);
  assert.deepEqual([...packet.data], [1, 1, 1, 0, 8, 1]);
});

test("flash reset option is encoded for the RX job", async () => {
  const connection = new CrazylinkUsbDevice({});
  const requests = [];
  connection.request = async (opcode, options = {}) => {
    requests.push({ opcode, options });
    return {};
  };
  const job = {
    targetId: 0,
    erase: "chip",
    swdKHz: 1000,
    base: 0x08000000,
    image: Uint8Array.of(1, 2, 3),
    crc: 0,
    verify: true,
    note: "",
  };
  await connection.uploadJob({ ...job, reset: false });
  assert.equal(requests[0].options.data[1] & 8, 0);
  requests.length = 0;
  await connection.uploadJob({ ...job, reset: true });
  assert.equal(requests[0].options.data[1] & 8, 8);
});
