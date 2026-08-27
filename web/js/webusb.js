(function (root, factory) {
  const api = factory(root.CRazyLink);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CRazyLink = Object.assign(root.CRazyLink || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (protocol) {
  "use strict";

  const VID = 0xcafe;
  const PID = 0x4010;
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const DeviceRole = Object.freeze({ TX: 1, RX: 2, CRAZYLINK: 3 });
  const DeviceMode = Object.freeze({ INDEPENDENT: 0, OFFLINE: 1, REMOTE_HOST: 2, REMOTE_DEVICE: 3 });
  const FlashState = Object.freeze({ IDLE: 0, READY: 1, FLASHING: 2, SUCCESS: 3, ERROR: 4, CANCELLED: 5 });

  function withTimeout(promise, timeoutMs, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function findBulkInterface(device) {
    if (!device.configuration) return null;
    const candidates = [];
    for (const item of device.configuration.interfaces) {
      for (const alternate of item.alternates) {
        const endpoints = alternate.endpoints || [];
        const input = endpoints.find((endpoint) => endpoint.direction === "in" && endpoint.type === "bulk");
        const output = endpoints.find((endpoint) => endpoint.direction === "out" && endpoint.type === "bulk");
        if (Number(alternate.interfaceClass) === 0xff && input && output) {
          candidates.push({
            interfaceNumber: item.interfaceNumber,
            alternateSetting: alternate.alternateSetting,
            inputEndpoint: input.endpointNumber,
            outputEndpoint: output.endpointNumber,
            interfaceName: alternate.interfaceName || "",
          });
        }
      }
    }
    if (!candidates.length) return null;
    return candidates.find((candidate) => /cmsis[- ]?dap/i.test(candidate.interfaceName)) ||
      (candidates.length === 1 ? candidates[0] : null);
  }

  function describeBulkInterfaces(device) {
    if (!device.configuration) return "设备没有活动 USB 配置";
    const interfaces = [];
    for (const item of device.configuration.interfaces) {
      for (const alternate of item.alternates) {
        const endpoints = alternate.endpoints || [];
        const bulk = endpoints.filter((endpoint) => endpoint.type === "bulk");
        if (bulk.length) {
          interfaces.push(`#${item.interfaceNumber}/${alternate.alternateSetting} class=0x${Number(alternate.interfaceClass).toString(16)} name=${alternate.interfaceName || "(空)"} bulk=${bulk.map((endpoint) => `${endpoint.direction}:${endpoint.endpointNumber}`).join(",")}`);
        }
      }
    }
    return interfaces.length ? interfaces.join("; ") : "未发现 Bulk 端点";
  }

  function decodeError(packet) {
    const code = packet.data[0] || 1;
    const message = packet.data.length > 1 ? textDecoder.decode(packet.data.slice(1)) : "设备拒绝了请求";
    const error = new Error(message || `设备错误 ${code}`);
    error.code = code;
    return error;
  }

  class CrazylinkUsbDevice extends EventTarget {
    constructor(device) {
      super();
      this.device = device;
      this.interface = null;
      this.sequence = 1;
      this.queue = Promise.resolve();
      this.info = null;
      this.localInfo = null;
    }

    get serialNumber() {
      return this.device.serialNumber || "CRAZYLINK";
    }

    async connect() {
      if (!this.device.opened) await this.device.open();
      if (!this.device.configuration) await this.device.selectConfiguration(1);
      this.interface = findBulkInterface(this.device);
      if (!this.interface) {
        throw new Error(`未找到 CRazyLink CMSIS-DAP v2 Bulk 接口（${describeBulkInterfaces(this.device)}）`);
      }
      await this.device.claimInterface(this.interface.interfaceNumber);
      if (this.interface.alternateSetting) {
        await this.device.selectAlternateInterface(
          this.interface.interfaceNumber,
          this.interface.alternateSetting,
        );
      }
      this.localInfo = await this.getLocalDeviceInfo();
      try {
        this.info = await this.getDeviceInfo();
      } catch (_) {
        this.info = {
          role: this.localInfo.role,
          mode: Number.isInteger(this.localInfo.mode)
            ? this.localInfo.mode
            : (this.localInfo.role === DeviceRole.RX ? DeviceMode.REMOTE_DEVICE : DeviceMode.REMOTE_HOST),
          capabilities: 0,
          peerConnected: false,
          jobStored: false,
          automatic: false,
          flashing: false,
          protocolVersion: 1,
          firmwareVersion: this.localInfo.firmwareVersion,
          jobSize: 0,
          jobCrc: 0,
          jobBase: 0,
          targetId: 0,
          progress: 0,
          flashState: FlashState.IDLE,
          serialNumber: this.serialNumber,
        };
      }
      this.dispatchEvent(new CustomEvent("connected", { detail: this.info }));
      return this.info;
    }

    async disconnect() {
      if (this.device.opened && this.interface) {
        try { await this.device.releaseInterface(this.interface.interfaceNumber); } catch (_) {}
      }
      if (this.device.opened) await this.device.close();
      this.interface = null;
      this.info = null;
      this.localInfo = null;
      this.dispatchEvent(new Event("disconnected"));
    }

    request(opcode, options) {
      const settings = options || {};
      const operation = () => this.performRequest(opcode, settings);
      const pending = this.queue.catch(() => undefined).then(operation);
      this.queue = pending;
      return pending;
    }

    async performRequest(opcode, options) {
      if (!this.interface || !this.device.opened) throw new Error("CRazyLink 尚未连接");
      const sequence = this.sequence;
      this.sequence = (this.sequence % 0xffff) + 1;
      const request = protocol.encodePacket({
        opcode,
        flags: options.flags || 0,
        sequence,
        offset: options.offset || 0,
        data: options.data,
      });
      const outResult = await withTimeout(
        this.device.transferOut(this.interface.outputEndpoint, request),
        options.timeoutMs || 2500,
        "发送请求",
      );
      if (outResult.status !== "ok" || outResult.bytesWritten !== request.length) {
        throw new Error("WebUSB 请求未完整发送");
      }
      const timeoutMs = options.timeoutMs || 2500;
      const deadline = Date.now() + timeoutMs;
      let inResult;
      do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("等待设备响应超时");
        inResult = await withTimeout(
          this.device.transferIn(this.interface.inputEndpoint, protocol.WEBUSB_PACKET_SIZE),
          remaining,
          "等待设备响应",
        );
        if (inResult.status !== "ok" || !inResult.data) throw new Error("WebUSB 响应读取失败");
      } while (inResult.data.byteLength === 0);
      const response = protocol.decodePacket(new Uint8Array(
        inResult.data.buffer,
        inResult.data.byteOffset,
        inResult.data.byteLength,
      ));
      if (response.sequence !== sequence || response.opcode !== opcode ||
          !(response.flags & protocol.WebPacketFlag.RESPONSE)) {
        throw new Error("WebUSB 响应与请求不匹配");
      }
      if (response.flags & protocol.WebPacketFlag.ERROR) throw decodeError(response);
      return response;
    }

    async getDeviceInfo() {
      const packet = await this.request(protocol.WebOpcode.DEVICE_INFO);
      if (packet.data.length < 32) throw new Error("设备信息响应不完整");
      const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
      const flags = packet.data[4];
      return {
        role: packet.data[0],
        mode: packet.data[1],
        capabilities: view.getUint16(2, true),
        peerConnected: Boolean(flags & 1),
        jobStored: Boolean(flags & 2),
        automatic: Boolean(flags & 4),
        flashing: Boolean(flags & 8),
        protocolVersion: packet.data[5],
        firmwareVersion: `${packet.data[6]}.${packet.data[7]}.${packet.data[8]}`,
        jobSize: view.getUint32(16, true),
        jobCrc: view.getUint32(20, true),
        jobBase: view.getUint32(24, true),
        targetId: packet.data[28],
        progress: packet.data[29],
        flashState: packet.data[30],
        serialNumber: this.serialNumber,
      };
    }

    async getLocalDeviceInfo() {
      const packet = await this.request(protocol.WebOpcode.LOCAL_DEVICE_INFO);
      if (packet.data.length < 6) throw new Error("本机设备信息响应不完整");
      return {
        role: packet.data[0],
        firmwareVersion: `${packet.data[1]}.${packet.data[2]}.${packet.data[3]}`,
        flashSize: packet.data[4] * 1024 * 1024,
        otaSupported: Boolean(packet.data[5] & 1),
        mode: packet.data.length > 6 ? packet.data[6] : null,
        serialNumber: this.serialNumber,
        productName: this.device.productName || "CRazyLink CMSIS-DAP",
      };
    }

    async setMode(mode) {
      await this.request(protocol.WebOpcode.SET_MODE, { data: Uint8Array.of(mode) });
      this.info = await this.getDeviceInfo();
      return this.info;
    }

    async uploadJob(job, onProgress) {
      const note = textEncoder.encode(job.note || "").slice(0, 30);
      const data = new Uint8Array(17 + note.length);
      const view = new DataView(data.buffer);
      data[0] = job.targetId;
      const erase = job.erase === "chip" ? 1 : job.erase === "none" ? 2 : 0;
      data[1] = erase | (job.verify ? 4 : 0) | (job.reset ? 8 : 0) | (job.storeOnly ? 16 : 0);
      view.setUint16(2, job.swdKHz, true);
      view.setUint32(4, job.base, true);
      view.setUint32(8, job.image.length, true);
      view.setUint32(12, job.crc, true);
      data[16] = note.length;
      data.set(note, 17);
      await this.request(protocol.WebOpcode.JOB_BEGIN, { data, timeoutMs: 5000 });

      for (let offset = 0; offset < job.image.length; offset += protocol.WEBUSB_DATA_SIZE) {
        const chunk = job.image.slice(offset, offset + protocol.WEBUSB_DATA_SIZE);
        await this.request(protocol.WebOpcode.JOB_DATA, { offset, data: chunk, timeoutMs: 5000 });
        if (onProgress) onProgress(Math.round(((offset + chunk.length) / job.image.length) * 100));
      }
      await this.request(protocol.WebOpcode.JOB_COMMIT, { timeoutMs: 10000 });
    }

    async startFlash() {
      return this.request(protocol.WebOpcode.FLASH_START, { timeoutMs: 5000 });
    }

    async cancelFlash() {
      return this.request(protocol.WebOpcode.FLASH_CANCEL);
    }

    async getFlashStatus() {
      const packet = await this.request(protocol.WebOpcode.FLASH_STATUS);
      if (packet.data.length < 16) throw new Error("烧录状态响应不完整");
      const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
      return {
        state: packet.data[0],
        progress: packet.data[1],
        errorCode: packet.data[2],
        mode: packet.data[3],
        completed: view.getUint32(4, true),
        total: view.getUint32(8, true),
        elapsedMs: view.getUint32(12, true),
        message: packet.data.length > 16 ? textDecoder.decode(packet.data.slice(16)) : "",
      };
    }

    async waitForFlash(onProgress, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || 120000);
      while (Date.now() < deadline) {
        const status = await this.getFlashStatus();
        if (onProgress) onProgress(status);
        if ([FlashState.SUCCESS, FlashState.ERROR, FlashState.CANCELLED].includes(status.state)) {
          if (status.state !== FlashState.SUCCESS) throw new Error(status.message || "烧录未成功完成");
          return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      throw new Error("烧录状态等待超时");
    }

    async openUart(config) {
      const data = new Uint8Array(7);
      const view = new DataView(data.buffer);
      view.setUint32(0, config.baudRate, false);
      data[4] = config.dataBits;
      data[5] = config.parity === "odd" ? 1 : config.parity === "even" ? 2 : 0;
      data[6] = config.stopBits === 1.5 ? 1 : config.stopBits === 2 ? 2 : 0;
      await this.request(protocol.WebOpcode.UART_CONFIG, { data });
    }

    async writeUart(value) {
      const bytes = protocol.asBytes(value);
      for (let offset = 0; offset < bytes.length; offset += protocol.WEBUSB_DATA_SIZE) {
        await this.request(protocol.WebOpcode.UART_WRITE, {
          data: bytes.slice(offset, offset + protocol.WEBUSB_DATA_SIZE),
        });
      }
    }

    async readUart() {
      const packet = await this.request(protocol.WebOpcode.UART_READ, { timeoutMs: 3000 });
      return packet.data;
    }

    async closeUart() {
      await this.request(protocol.WebOpcode.UART_CLOSE);
    }

    async uploadOta(image, onProgress) {
      if (!this.localInfo || ![DeviceRole.CRAZYLINK, DeviceRole.TX, DeviceRole.RX].includes(this.localInfo.role)) {
        throw new Error("无法识别当前 CRazyLink 设备");
      }
      const bytes = protocol.asBytes(image);
      const begin = new Uint8Array(9);
      const view = new DataView(begin.buffer);
      begin[0] = DeviceRole.CRAZYLINK;
      view.setUint32(1, bytes.length, true);
      view.setUint32(5, protocol.crc32(bytes), true);
      await this.request(protocol.WebOpcode.OTA_BEGIN, { data: begin, timeoutMs: 30000 });
      for (let offset = 0; offset < bytes.length; offset += protocol.WEBUSB_DATA_SIZE) {
        const chunk = bytes.slice(offset, offset + protocol.WEBUSB_DATA_SIZE);
        await this.request(protocol.WebOpcode.OTA_DATA, { offset, data: chunk, timeoutMs: 5000 });
        if (onProgress) onProgress(Math.round(((offset + chunk.length) / bytes.length) * 100));
      }
      await this.request(protocol.WebOpcode.OTA_COMMIT, { timeoutMs: 15000 });
    }
  }

  class CrazylinkUsbManager extends EventTarget {
    constructor(usb) {
      super();
      this.usb = usb || (typeof navigator !== "undefined" ? navigator.usb : null);
      this.current = null;
      if (this.usb) {
        this.usb.addEventListener("disconnect", (event) => {
          if (this.current && event.device === this.current.device) {
            this.current = null;
            this.dispatchEvent(new Event("disconnected"));
          }
        });
      }
    }

    get supported() {
      return Boolean(this.usb);
    }

    async connectDevice(device) {
      if (this.current) await this.current.disconnect();
      const connection = new CrazylinkUsbDevice(device);
      await connection.connect();
      this.current = connection;
      this.dispatchEvent(new CustomEvent("connected", { detail: connection }));
      return connection;
    }

    async connectAuthorized() {
      if (!this.usb) return null;
      const devices = await this.usb.getDevices();
      const device = devices.find((item) => item.vendorId === VID && item.productId === PID);
      return device ? this.connectDevice(device) : null;
    }

    async requestDevice() {
      if (!this.usb) throw new Error("当前浏览器不支持 WebUSB，请使用最新版 Chrome 或 Edge");
      const device = await this.usb.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
      return this.connectDevice(device);
    }
  }

  return { CrazylinkUsbDevice, CrazylinkUsbManager, DeviceRole, DeviceMode, FlashState, findBulkInterface, describeBulkInterfaces };
});
