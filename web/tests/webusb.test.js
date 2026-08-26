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
    productName: "CRazyLink_TX CMSIS-DAP",
  });
  connection.request = async (opcode) => {
    assert.equal(opcode, global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO);
    return { data: Uint8Array.of(1, 1, 1, 0, 8, 1) };
  };
  assert.deepEqual(await connection.getLocalDeviceInfo(), {
    role: 1,
    firmwareVersion: "1.1.0",
    flashSize: 8 * 1024 * 1024,
    otaSupported: true,
    serialNumber: "ABC123",
    productName: "CRazyLink_TX CMSIS-DAP",
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
  connection.getLocalDeviceInfo = async () => ({ role: 1, firmwareVersion: "1.1.0", flashSize: 8 * 1024 * 1024, otaSupported: true });
  connection.getDeviceInfo = async () => { throw new Error("RX offline"); };
  const info = await connection.connect();
  assert.equal(info.role, 1);
  assert.equal(info.peerConnected, false);
  assert.equal(info.firmwareVersion, "1.1.0");
});
