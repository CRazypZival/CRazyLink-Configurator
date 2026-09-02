const test = require("node:test");
const assert = require("node:assert/strict");

global.CRazyLink = require("../js/protocol.js");
const { CrazylinkUsbDevice, CrazylinkUsbManager, findBulkInterface, describeBulkInterfaces, sameUsbDevice } = require("../js/webusb.js");

function endpoint(direction, endpointNumber) {
  return { direction, type: "bulk", endpointNumber };
}

function device(alternates) {
  return { configuration: { interfaces: alternates.map((alternate, interfaceNumber) => ({ interfaceNumber, alternates: [alternate] })) } };
}

function linkError(message = "RX is not connected") {
  const error = new Error(message);
  error.code = 8;
  return error;
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

test("identifies WebUSB wrappers for the same physical device", () => {
  const first = { vendorId: 0xcafe, productId: 0x4010, serialNumber: "D0CF1314EDB4" };
  const second = { vendorId: 0xcafe, productId: 0x4010, serialNumber: "D0CF1314EDB4" };
  assert.equal(sameUsbDevice(first, second), true);
  assert.equal(sameUsbDevice(first, { ...second, serialNumber: "D0CF131506CC" }), false);
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
  connection.getDeviceInfo = async () => { throw linkError(); };
  const info = await connection.connect();
  assert.equal(info.role, 3);
  assert.equal(info.peerConnected, false);
  assert.equal(info.firmwareVersion, "1.1.0");
});

test("connect retries while Windows is changing the USB interface state", async () => {
  const usbDevice = device([{
    interfaceClass: 0xff,
    interfaceName: "CMSIS-DAP v2",
    alternateSetting: 0,
    endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
  }]);
  let claims = 0;
  Object.assign(usbDevice, {
    opened: true,
    claimInterface: async () => {
      claims += 1;
      if (claims === 1) throw new DOMException("An operation that changes interface state is in progress", "InvalidStateError");
    },
  });
  const connection = new CrazylinkUsbDevice(usbDevice);
  connection.getLocalDeviceInfo = async () => ({ role: 3, firmwareVersion: "1.1.3", flashSize: 8 * 1024 * 1024, otaSupported: true });
  connection.getDeviceInfo = async () => { throw linkError(); };

  await connection.connect();
  assert.equal(claims, 2);
});

test("connect retries the full Windows USB open lifecycle", async () => {
  const usbDevice = {
    opened: false,
    configuration: null,
    serialNumber: "WIN-LIFECYCLE",
    openCalls: 0,
    selectCalls: 0,
    claimCalls: 0,
    open: async function () {
      this.openCalls += 1;
      if (this.openCalls === 1) {
        throw new DOMException("An operation that changes interface state is in progress", "InvalidStateError");
      }
      this.opened = true;
    },
    selectConfiguration: async function () {
      this.selectCalls += 1;
      this.configuration = device([{
        interfaceClass: 0xff,
        interfaceName: "CMSIS-DAP v2",
        alternateSetting: 0,
        endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
      }]).configuration;
    },
    claimInterface: async function () { this.claimCalls += 1; },
  };
  const connection = new CrazylinkUsbDevice(usbDevice);
  connection.getLocalDeviceInfo = async () => ({ role: 3, firmwareVersion: "1.1.3", flashSize: 8 * 1024 * 1024, otaSupported: true });
  connection.getDeviceInfo = async () => { throw linkError(); };

  await connection.connect();
  assert.equal(usbDevice.openCalls, 2);
  assert.equal(usbDevice.selectCalls, 1);
  assert.equal(usbDevice.claimCalls, 1);
});

test("manager reuses one in-progress connection for the same USB device", async () => {
  const usbDevice = device([{
    interfaceClass: 0xff,
    interfaceName: "CMSIS-DAP v2",
    alternateSetting: 0,
    endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
  }]);
  let claims = 0;
  let releaseClaim;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  Object.assign(usbDevice, {
    opened: true,
    serialNumber: "WIN123",
    claimInterface: async () => {
      claims += 1;
      await claimGate;
    },
  });
  const manager = new CrazylinkUsbManager({ addEventListener: () => {} });
  const originalConnect = CrazylinkUsbDevice.prototype.connect;
  CrazylinkUsbDevice.prototype.connect = async function () {
    await this.device.claimInterface(0);
    this.interface = { interfaceNumber: 0, inputEndpoint: 1, outputEndpoint: 1 };
    this.localInfo = { role: 3, firmwareVersion: "1.1.3", flashSize: 8 * 1024 * 1024, otaSupported: true };
    this.info = { role: 3, firmwareVersion: "1.1.3" };
    return this.info;
  };

  try {
    const first = manager.connectDevice(usbDevice);
    const second = manager.connectDevice(usbDevice);
    releaseClaim();
    const [firstConnection, secondConnection] = await Promise.all([first, second]);
    assert.equal(firstConnection, secondConnection);
    assert.equal(claims, 1);
  } finally {
    CrazylinkUsbDevice.prototype.connect = originalConnect;
  }
});

test("manager coalesces different wrappers for the same physical device", async () => {
  let releaseConnect;
  const connectGate = new Promise((resolve) => { releaseConnect = resolve; });
  const first = { vendorId: 0xcafe, productId: 0x4010, serialNumber: "WIN-WRAPPER" };
  const second = { vendorId: 0xcafe, productId: 0x4010, serialNumber: "WIN-WRAPPER" };
  const manager = new CrazylinkUsbManager({ addEventListener: () => {} });
  let connects = 0;
  const originalConnect = CrazylinkUsbDevice.prototype.connect;
  CrazylinkUsbDevice.prototype.connect = async function () {
    connects += 1;
    await connectGate;
    this.interface = { interfaceNumber: 0, inputEndpoint: 1, outputEndpoint: 1 };
  };

  try {
    const firstConnection = manager.connectDevice(first);
    const secondConnection = manager.connectDevice(second);
    releaseConnect();
    assert.equal(await firstConnection, await secondConnection);
    assert.equal(connects, 1);
  } finally {
    CrazylinkUsbDevice.prototype.connect = originalConnect;
  }
});

test("manager recognizes disconnect events from an equivalent device wrapper", () => {
  let disconnectListener;
  const manager = new CrazylinkUsbManager({
    addEventListener: (name, listener) => {
      if (name === "disconnect") disconnectListener = listener;
    },
  });
  manager.current = {
    device: { vendorId: 0xcafe, productId: 0x4010, serialNumber: "WIN-DISCONNECT" },
    markDisconnected: () => {},
  };
  disconnectListener({
    device: { vendorId: 0xcafe, productId: 0x4010, serialNumber: "WIN-DISCONNECT" },
  });
  assert.equal(manager.current, null);
});

test("USB OTA always targets the unified CRazyLink firmware", async () => {
  const connection = new CrazylinkUsbDevice({});
  connection.localInfo = { role: 2 };
  const requests = [];
  connection.request = async (opcode, options = {}) => {
    requests.push({ opcode, options });
    return {};
  };
  connection.requestBatch = async (opcode, optionsList) => {
    requests.push({ opcode, options: optionsList });
    return optionsList.map(() => ({}));
  };
  await connection.uploadOta(Uint8Array.from({ length: 48 }, (_, index) => index), () => {});
  assert.deepEqual(requests.map((entry) => entry.opcode), [
    global.CRazyLink.WebOpcode.OTA_BEGIN,
    global.CRazyLink.WebOpcode.OTA_DATA,
    global.CRazyLink.WebOpcode.OTA_COMMIT,
  ]);
  assert.equal(requests[0].options.data[0], 3);
  assert.equal(requests[1].options.length, 2);
});

test("batched WebUSB requests send before waiting for ordered responses", async () => {
  const events = [];
  const sent = [];
  const connection = new CrazylinkUsbDevice({
    opened: true,
    transferOut: async (_, data) => {
      events.push("out");
      sent.push(global.CRazyLink.decodePacket(new Uint8Array(data)));
      return { status: "ok", bytesWritten: data.byteLength };
    },
    transferIn: async () => {
      events.push("in");
      const request = sent.shift();
      const response = global.CRazyLink.encodePacket({
        opcode: request.opcode,
        flags: global.CRazyLink.WebPacketFlag.RESPONSE,
        sequence: request.sequence,
        offset: request.offset,
      });
      return { status: "ok", data: new DataView(response.buffer) };
    },
  });
  connection.interface = { inputEndpoint: 1, outputEndpoint: 1 };
  const responses = await connection.requestBatch(global.CRazyLink.WebOpcode.OTA_DATA, [
    { offset: 0, data: Uint8Array.of(1) },
    { offset: 1, data: Uint8Array.of(2) },
  ]);
  assert.deepEqual(events, ["out", "out", "in", "in"]);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses.map((response) => response.offset), [0, 1]);
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

test("request recovers a stalled WebUSB IN endpoint", async () => {
  const response = global.CRazyLink.encodePacket({
    opcode: global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO,
    flags: global.CRazyLink.WebPacketFlag.RESPONSE,
    sequence: 1,
    data: Uint8Array.of(3, 1, 1, 4, 16, 1),
  });
  let reads = 0;
  const clearHaltCalls = [];
  const connection = new CrazylinkUsbDevice({
    opened: true,
    transferOut: async (_, data) => ({ status: "ok", bytesWritten: data.byteLength }),
    transferIn: async () => {
      reads += 1;
      if (reads === 1) return { status: "stall", data: null };
      return { status: "ok", data: new DataView(response.buffer) };
    },
    clearHalt: async (direction, endpoint) => { clearHaltCalls.push({ direction, endpoint }); },
  });
  connection.interface = { inputEndpoint: 0x81, outputEndpoint: 1 };
  const packet = await connection.request(global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO);
  assert.equal(packet.data[0], 3);
  assert.deepEqual(clearHaltCalls, [{ direction: "in", endpoint: 0x81 }]);
  assert.equal(reads, 2);
});

test("request retries a transient Windows interface-state error", async () => {
  const response = global.CRazyLink.encodePacket({
    opcode: global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO,
    flags: global.CRazyLink.WebPacketFlag.RESPONSE,
    sequence: 1,
    data: Uint8Array.of(3, 1, 1, 4, 16, 1),
  });
  let reads = 0;
  const connection = new CrazylinkUsbDevice({
    opened: true,
    transferOut: async (_, data) => ({ status: "ok", bytesWritten: data.byteLength }),
    transferIn: async () => {
      reads += 1;
      if (reads === 1) throw new DOMException("An operation that changes interface state is in progress", "InvalidStateError");
      return { status: "ok", data: new DataView(response.buffer) };
    },
    clearHalt: async () => {},
  });
  connection.interface = { inputEndpoint: 1, outputEndpoint: 1 };
  const packet = await connection.request(global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO);
  assert.equal(packet.data[0], 3);
  assert.equal(reads, 2);
});

test("manager times out a stuck Windows connection", async () => {
  const usbDevice = { serialNumber: "STUCK" };
  const manager = new CrazylinkUsbManager({
    addEventListener: () => {},
    getDevices: async () => [],
  }, { connectTimeoutMs: 20 });
  const originalConnect = CrazylinkUsbDevice.prototype.connect;
  CrazylinkUsbDevice.prototype.connect = () => new Promise(() => {});
  try {
    await assert.rejects(() => manager.connectDevice(usbDevice), /连接设备超时/);
    assert.equal(manager.pendingConnection, null);
  } finally {
    CrazylinkUsbDevice.prototype.connect = originalConnect;
  }
});

test("manager does not release an interface while Chrome is still claiming it", async () => {
  let releases = 0;
  let closes = 0;
  const usbDevice = device([{
    interfaceClass: 0xff,
    interfaceName: "CMSIS-DAP v2",
    alternateSetting: 0,
    endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
  }]);
  Object.assign(usbDevice, {
    opened: true,
    vendorId: 0xcafe,
    productId: 0x4010,
    serialNumber: "STUCK-CLAIM",
    claimInterface: () => new Promise(() => {}),
    releaseInterface: async () => { releases += 1; },
    close: async () => { closes += 1; },
  });
  const manager = new CrazylinkUsbManager({ addEventListener: () => {} }, { connectTimeoutMs: 20 });

  await assert.rejects(() => manager.connectDevice(usbDevice), /连接设备超时（打开 CMSIS-DAP 接口）/);
  assert.equal(releases, 0);
  assert.equal(closes, 0);
});

test("a timed-out claim settles before a retry can claim the same device", async () => {
  let finishFirstClaim;
  const firstClaim = new Promise((resolve) => { finishFirstClaim = resolve; });
  let claims = 0;
  let releases = 0;
  const usbDevice = device([{
    interfaceClass: 0xff,
    interfaceName: "CMSIS-DAP v2",
    alternateSetting: 0,
    endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
  }]);
  Object.assign(usbDevice, {
    opened: true,
    vendorId: 0xcafe,
    productId: 0x4010,
    serialNumber: "LATE-CLAIM",
    claimInterface: async () => {
      claims += 1;
      if (claims === 1) await firstClaim;
    },
    releaseInterface: async () => { releases += 1; },
    close: async function () { this.opened = false; },
    open: async function () { this.opened = true; },
  });
  const manager = new CrazylinkUsbManager({ addEventListener: () => {} }, { connectTimeoutMs: 20 });
  const originalLocalInfo = CrazylinkUsbDevice.prototype.getLocalDeviceInfo;
  const originalDeviceInfo = CrazylinkUsbDevice.prototype.getDeviceInfo;
  CrazylinkUsbDevice.prototype.getLocalDeviceInfo = async () => ({
    role: 3,
    firmwareVersion: "1.1.5",
    flashSize: 16 * 1024 * 1024,
    otaSupported: true,
    mode: 0,
  });
  CrazylinkUsbDevice.prototype.getDeviceInfo = async () => ({ role: 3, mode: 0 });
  try {
    await assert.rejects(() => manager.connectDevice(usbDevice), /连接设备超时/);
    const retry = manager.connectDevice(usbDevice);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(claims, 1);
    finishFirstClaim();
    const connection = await retry;
    assert.equal(claims, 2);
    assert.equal(releases, 1);
    await manager.disconnectDevice(connection);
  } finally {
    CrazylinkUsbDevice.prototype.getLocalDeviceInfo = originalLocalInfo;
    CrazylinkUsbDevice.prototype.getDeviceInfo = originalDeviceInfo;
  }
});

test("physical disconnect cancels a pending claim and releases the manager queue", async () => {
  let disconnectListener;
  let claims = 0;
  const first = device([{
    interfaceClass: 0xff,
    interfaceName: "CMSIS-DAP v2",
    alternateSetting: 0,
    endpoints: [endpoint("out", 1), endpoint("in", 0x81)],
  }]);
  Object.assign(first, {
    opened: true,
    vendorId: 0xcafe,
    productId: 0x4010,
    serialNumber: "PENDING-DISCONNECT",
    claimInterface: () => {
      claims += 1;
      return new Promise(() => {});
    },
  });
  const second = {
    vendorId: 0xcafe,
    productId: 0x4010,
    serialNumber: "AFTER-DISCONNECT",
  };
  const manager = new CrazylinkUsbManager({
    addEventListener: (name, listener) => {
      if (name === "disconnect") disconnectListener = listener;
    },
  }, { connectTimeoutMs: 1000 });
  const originalConnect = CrazylinkUsbDevice.prototype.connect;
  try {
    const pending = manager.connectDevice(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    disconnectListener({ device: { ...first } });
    await assert.rejects(() => pending, /USB 已断开/);

    CrazylinkUsbDevice.prototype.connect = async function () {
      this.interface = { interfaceNumber: 0, inputEndpoint: 1, outputEndpoint: 1 };
      this.device.opened = true;
    };
    const connected = await manager.connectDevice(second);
    assert.equal(connected.device, second);
    assert.equal(claims, 1);
  } finally {
    CrazylinkUsbDevice.prototype.connect = originalConnect;
  }
});

test("disconnect waits for an active transfer before releasing the interface", async () => {
  let finishRead;
  const readGate = new Promise((resolve) => { finishRead = resolve; });
  let releases = 0;
  let closes = 0;
  const response = global.CRazyLink.encodePacket({
    opcode: global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO,
    flags: global.CRazyLink.WebPacketFlag.RESPONSE,
    sequence: 1,
    data: Uint8Array.of(3, 1, 1, 5, 16, 1),
  });
  const usbDevice = {
    opened: true,
    transferOut: async (_, data) => ({ status: "ok", bytesWritten: data.byteLength }),
    transferIn: async () => {
      await readGate;
      return { status: "ok", data: new DataView(response.buffer) };
    },
    releaseInterface: async () => { releases += 1; },
    close: async function () { closes += 1; this.opened = false; },
  };
  const connection = new CrazylinkUsbDevice(usbDevice);
  connection.interface = { interfaceNumber: 0, inputEndpoint: 1, outputEndpoint: 1 };
  const request = connection.request(global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const disconnect = connection.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(releases, 0);
  assert.equal(closes, 0);
  finishRead();
  await request;
  await disconnect;
  assert.equal(releases, 1);
  assert.equal(closes, 1);
});

test("a timed-out transfer cannot overlap a following request", async () => {
  let finishRead;
  const readGate = new Promise((resolve) => { finishRead = resolve; });
  let reads = 0;
  const response = global.CRazyLink.encodePacket({
    opcode: global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO,
    flags: global.CRazyLink.WebPacketFlag.RESPONSE,
    sequence: 1,
    data: Uint8Array.of(3, 1, 1, 5, 16, 1),
  });
  const connection = new CrazylinkUsbDevice({
    opened: true,
    transferOut: async (_, data) => ({ status: "ok", bytesWritten: data.byteLength }),
    transferIn: async () => {
      reads += 1;
      await readGate;
      return { status: "ok", data: new DataView(response.buffer) };
    },
  });
  connection.interface = { interfaceNumber: 0, inputEndpoint: 1, outputEndpoint: 1 };
  await assert.rejects(
    () => connection.request(global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO, { timeoutMs: 20 }),
    /等待 WebUSB 响应超时/,
  );
  await assert.rejects(
    () => connection.request(global.CRazyLink.WebOpcode.LOCAL_DEVICE_INFO),
    /等待浏览器收敛/,
  );
  assert.equal(reads, 1);
  finishRead();
  await connection.queue;
});

test("device authorization is separate from opening the Windows interface", async () => {
  const selected = { vendorId: 0xcafe, productId: 0x4010, serialNumber: "SELECTED" };
  let requests = 0;
  const manager = new CrazylinkUsbManager({
    addEventListener: () => {},
    requestDevice: async () => {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return selected;
    },
  }, { requestDeviceTimeoutMs: 1 });

  assert.equal(await manager.selectDevice(), selected);
  assert.equal(requests, 1);
  assert.equal(manager.current, null);
  assert.equal(manager.pendingConnection, null);
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
