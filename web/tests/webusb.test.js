const test = require("node:test");
const assert = require("node:assert/strict");

global.CRazyLink = require("../js/protocol.js");
const { findBulkInterface, describeBulkInterfaces } = require("../js/webusb.js");

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
