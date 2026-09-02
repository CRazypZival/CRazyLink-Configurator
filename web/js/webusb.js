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
  const OTA_BATCH_SIZE = 4;
  const USB_STATE_RETRY_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800, 1200]);
  const USB_TRANSFER_RETRY_DELAYS_MS = Object.freeze([20, 50, 100, 200, 400, 800]);
  const USB_CONNECT_TIMEOUT_MS = 15000;
  const USB_TIMEOUT_CODE = "USB_OPERATION_TIMEOUT";
  const USB_DISCONNECTED_CODE = "USB_DEVICE_DISCONNECTED";
  const WEB_ERROR_LINK = 8;

  function operationError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function timeoutError(label) {
    const value = typeof label === "function" ? label() : label;
    return operationError(`${value}超时`, USB_TIMEOUT_CODE);
  }

  function disconnectedError() {
    return operationError("CRazyLink USB 已断开", USB_DISCONNECTED_CODE);
  }

  function isTimeoutError(error) {
    return error?.code === USB_TIMEOUT_CODE;
  }

  function withTimeout(promise, timeoutMs, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function isUsbStateBusy(error) {
    return /operation that changes interface state is in progress|device is busy|transfer.*pending/i.test(error?.message || "");
  }

  async function retryUsbStateOperation(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isUsbStateBusy(error) || attempt >= USB_STATE_RETRY_DELAYS_MS.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, USB_STATE_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  function isTransientTransferError(error) {
    return /stall|babble|transfer.*(pending|error)|device.*busy|networkerror|operation that changes interface state/i.test(error?.message || "");
  }

  function transferStatusError(direction, endpoint, status) {
    const error = new Error(`WebUSB ${direction}端点 ${endpoint} 传输失败（状态: ${status || "unknown"}）`);
    error.status = status || "unknown";
    return error;
  }

  async function recoverTransfer(device, direction, endpoint, deadline, attempt) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("等待设备响应超时");
    const delay = USB_TRANSFER_RETRY_DELAYS_MS[Math.min(attempt, USB_TRANSFER_RETRY_DELAYS_MS.length - 1)];
    if (direction === "in" && typeof device.clearHalt === "function") {
      try { await device.clearHalt("in", endpoint); } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
  }

  async function transferInWithRecovery(device, endpoint, deadline) {
    let attempts = 0;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("等待设备响应超时");
      try {
        const result = await device.transferIn(endpoint, protocol.WEBUSB_PACKET_SIZE);
        if (result?.status === "ok" && result.data) return result;
        if (!result || !["stall", "babble"].includes(result.status) ||
            attempts >= USB_TRANSFER_RETRY_DELAYS_MS.length) {
          throw transferStatusError("IN", endpoint, result?.status);
        }
        await recoverTransfer(device, "in", endpoint, deadline, attempts);
        attempts += 1;
      } catch (error) {
        if (!isTransientTransferError(error) || attempts >= USB_TRANSFER_RETRY_DELAYS_MS.length) throw error;
        await recoverTransfer(device, "in", endpoint, deadline, attempts);
        attempts += 1;
      }
    }
  }

  const claimInterfaceWithRetry = (device, interfaceNumber) =>
    retryUsbStateOperation(() => device.claimInterface(interfaceNumber));
  const releaseInterfaceWithRetry = (device, interfaceNumber) =>
    retryUsbStateOperation(() => device.releaseInterface(interfaceNumber));
  const closeDeviceWithRetry = (device) => retryUsbStateOperation(() => device.close());
  const openDeviceWithRetry = (device) => retryUsbStateOperation(() => device.open());
  const selectConfigurationWithRetry = (device, value) =>
    retryUsbStateOperation(() => device.selectConfiguration(value));
  const selectAlternateInterfaceWithRetry = (device, interfaceNumber, alternateSetting) =>
    retryUsbStateOperation(() => device.selectAlternateInterface(interfaceNumber, alternateSetting));

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

  function sameUsbDevice(left, right) {
    if (left === right) return true;
    if (!left || !right || !left.serialNumber || !right.serialNumber) return false;
    return left.vendorId === right.vendorId && left.productId === right.productId &&
      left.serialNumber === right.serialNumber;
  }

  function decodeError(packet) {
    const code = packet.data[0] || 1;
    const message = packet.data.length > 1 ? textDecoder.decode(packet.data.slice(1)) : "设备拒绝了请求";
    const error = new Error(message || `设备错误 ${code}`);
    error.code = code;
    return error;
  }

  function isPeerLinkError(error) {
    return Number(error?.code) === WEB_ERROR_LINK;
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
      this.cancelled = false;
      this.cancelReason = null;
      this.connectStage = "idle";
      this.operationStage = "idle";
      this.closing = false;
      this.disconnected = false;
      this.quarantined = false;
      this.disconnectPromise = null;
      this.resolveDetached = null;
      this.detached = new Promise((resolve) => { this.resolveDetached = resolve; });
    }

    get serialNumber() {
      return this.device.serialNumber || "CRAZYLINK";
    }

    cancelConnect(reason) {
      this.cancelled = true;
      this.cancelReason = reason || new Error("连接已取消");
    }

    markDisconnected(reason) {
      if (this.disconnected) return;
      const error = reason || disconnectedError();
      this.disconnected = true;
      this.closing = true;
      this.cancelConnect(error);
      this.interface = null;
      this.info = null;
      this.localInfo = null;
      if (this.resolveDetached) {
        this.resolveDetached(error);
        this.resolveDetached = null;
      }
    }

    assertConnectActive() {
      if (this.cancelled) throw this.cancelReason || new Error("连接已取消");
    }

    async awaitConnectOperation(operation) {
      const usbOperation = Promise.resolve().then(operation);
      const detached = this.detached.then((error) => Promise.reject(error));
      return Promise.race([usbOperation, detached]);
    }

    async waitForIoOrDetach() {
      await Promise.race([
        this.queue.catch(() => undefined),
        this.detached,
      ]);
    }

    async cleanupUsb(claimed) {
      this.closing = true;
      await this.waitForIoOrDetach();
      if (!this.disconnected) {
        if (claimed && this.device.opened && this.interface) {
          try { await releaseInterfaceWithRetry(this.device, this.interface.interfaceNumber); } catch (_) {}
        }
        if (this.device.opened) {
          try { await closeDeviceWithRetry(this.device); } catch (_) {}
        }
      }
      this.interface = null;
      this.info = null;
      this.localInfo = null;
      this.connectStage = "idle";
      this.operationStage = "idle";
    }

    enqueueOperation(operation, timeoutMs, label) {
      if (this.disconnected) return Promise.reject(disconnectedError());
      if (this.closing) return Promise.reject(new Error("CRazyLink 正在断开连接"));
      if (this.quarantined) {
        return Promise.reject(new Error("上一次 WebUSB 传输仍在等待浏览器收敛，请重新插拔设备"));
      }

      let publicSettled = false;
      let timedOut = false;
      let resolvePublic;
      let rejectPublic;
      const publicResult = new Promise((resolve, reject) => {
        resolvePublic = resolve;
        rejectPublic = reject;
      });
      const previous = this.queue.catch(() => undefined);
      const settlement = previous.then(async () => {
        let timer;
        try {
          if (this.disconnected) throw disconnectedError();
          if (this.closing) throw new Error("CRazyLink 正在断开连接");
          timer = setTimeout(() => {
            timedOut = true;
            this.quarantined = true;
            if (!publicSettled) {
              publicSettled = true;
              rejectPublic(timeoutError(label));
            }
          }, timeoutMs);
          const value = await operation();
          if (!publicSettled) {
            publicSettled = true;
            resolvePublic(value);
          }
          return value;
        } catch (error) {
          if (!publicSettled) {
            publicSettled = true;
            rejectPublic(error);
          }
          throw error;
        } finally {
          clearTimeout(timer);
          if (timedOut) this.quarantined = false;
          this.operationStage = "idle";
        }
      });
      this.queue = settlement.catch(() => undefined);
      const detachedResult = this.detached.then((error) => Promise.reject(error));
      return Promise.race([publicResult, detachedResult]);
    }

    async connect() {
      let claimed = false;
      this.cancelled = false;
      this.cancelReason = null;
      this.closing = false;
      try {
        this.connectStage = "打开 USB 设备";
        if (!this.device.opened) {
          await this.awaitConnectOperation(() => openDeviceWithRetry(this.device));
        }
        this.assertConnectActive();
        this.connectStage = "选择 USB 配置";
        if (!this.device.configuration) {
          await this.awaitConnectOperation(() => selectConfigurationWithRetry(this.device, 1));
        }
        this.assertConnectActive();
        this.connectStage = "查找 CMSIS-DAP 接口";
        this.interface = findBulkInterface(this.device);
        if (!this.interface) {
          throw new Error(`未找到 CRazyLink CMSIS-DAP v2 Bulk 接口（${describeBulkInterfaces(this.device)}）`);
        }
        this.connectStage = "打开 CMSIS-DAP 接口";
        await this.awaitConnectOperation(
          () => claimInterfaceWithRetry(this.device, this.interface.interfaceNumber),
        );
        claimed = true;
        this.assertConnectActive();
        if (this.interface.alternateSetting) {
          this.connectStage = "选择 CMSIS-DAP 接口模式";
          await this.awaitConnectOperation(
            () => selectAlternateInterfaceWithRetry(
              this.device,
              this.interface.interfaceNumber,
              this.interface.alternateSetting,
            ),
          );
          this.assertConnectActive();
        }
        this.connectStage = "读取本机设备信息";
        this.localInfo = await this.getLocalDeviceInfo();
        this.assertConnectActive();
        this.connectStage = "读取运行状态";
        try {
          this.info = await this.getDeviceInfo();
        } catch (error) {
          if (!isPeerLinkError(error)) throw error;
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
        this.assertConnectActive();
        this.connectStage = "connected";
        this.dispatchEvent(new CustomEvent("connected", { detail: this.info }));
        return this.info;
      } catch (error) {
        await this.cleanupUsb(claimed);
        throw error;
      }
    }

    async disconnect() {
      if (this.disconnectPromise) return this.disconnectPromise;
      this.cancelConnect(new Error("连接已取消"));
      const claimed = Boolean(this.interface);
      this.disconnectPromise = (async () => {
        await this.cleanupUsb(claimed);
        this.dispatchEvent(new Event("disconnected"));
      })();
      try {
        await this.disconnectPromise;
      } finally {
        this.disconnectPromise = null;
      }
    }

    request(opcode, options) {
      const settings = options || {};
      return this.enqueueOperation(
        () => this.performRequest(opcode, settings),
        settings.timeoutMs || 2500,
        () => this.operationStage === "idle" ? "WebUSB 请求" : this.operationStage,
      );
    }

    requestBatch(opcode, optionsList) {
      const settingsList = Array.isArray(optionsList) ? optionsList.map((options) => options || {}) : [];
      const timeoutMs = settingsList.reduce(
        (maximum, settings) => Math.max(maximum, settings.timeoutMs || 2500),
        2500,
      );
      return this.enqueueOperation(
        () => this.performRequestBatch(opcode, settingsList),
        timeoutMs,
        () => this.operationStage === "idle" ? "WebUSB 批量请求" : this.operationStage,
      );
    }

    async performRequest(opcode, options) {
      if (!this.interface || !this.device.opened) throw new Error("CRazyLink 尚未连接");
      const usbInterface = this.interface;
      const sequence = this.sequence;
      this.sequence = (this.sequence % 0xffff) + 1;
      const request = protocol.encodePacket({
        opcode,
        flags: options.flags || 0,
        sequence,
        offset: options.offset || 0,
        data: options.data,
      });
      this.operationStage = "发送 WebUSB 请求";
      const outResult = await this.device.transferOut(usbInterface.outputEndpoint, request);
      if (outResult.status !== "ok" || outResult.bytesWritten !== request.length) {
        throw new Error("WebUSB 请求未完整发送");
      }
      const timeoutMs = options.timeoutMs || 2500;
      const deadline = Date.now() + timeoutMs;
      let lastMismatch = false;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("等待设备响应超时");
        this.operationStage = "等待 WebUSB 响应";
        const inResult = await transferInWithRecovery(this.device, usbInterface.inputEndpoint, deadline);
        if (inResult.data.byteLength === 0) continue;
        const response = protocol.decodePacket(new Uint8Array(
          inResult.data.buffer,
          inResult.data.byteOffset,
          inResult.data.byteLength,
        ));
        if (response.sequence !== sequence || response.opcode !== opcode ||
            !(response.flags & protocol.WebPacketFlag.RESPONSE)) {
          lastMismatch = true;
          continue;
        }
        if (response.flags & protocol.WebPacketFlag.ERROR) throw decodeError(response);
        return response;
      }
      throw new Error(lastMismatch ? "WebUSB 响应与请求不匹配" : "等待设备响应超时");
    }

    async performRequestBatch(opcode, optionsList) {
      if (!optionsList.length) return [];
      if (!this.interface || !this.device.opened) throw new Error("CRazyLink 尚未连接");
      const usbInterface = this.interface;
      const requests = optionsList.map((options) => {
        const sequence = this.sequence;
        this.sequence = (this.sequence % 0xffff) + 1;
        return {
          sequence,
          options,
          packet: protocol.encodePacket({
            opcode,
            flags: options.flags || 0,
            sequence,
            offset: options.offset || 0,
            data: options.data,
          }),
        };
      });

      // Keep the send order deterministic so the device's small receive queue
      // can be drained and acknowledged in the same order.
      for (const request of requests) {
        this.operationStage = "发送 WebUSB 批量请求";
        const outResult = await this.device.transferOut(usbInterface.outputEndpoint, request.packet);
        if (outResult.status !== "ok" || outResult.bytesWritten !== request.packet.length) {
          throw new Error("WebUSB 请求未完整发送");
        }
      }

      const responses = [];
      for (const request of requests) {
        const timeoutMs = request.options.timeoutMs || 2500;
        const deadline = Date.now() + timeoutMs;
        let response = null;
        let lastMismatch = false;
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("等待设备响应超时");
          this.operationStage = "等待 WebUSB 批量响应";
          const inResult = await transferInWithRecovery(this.device, usbInterface.inputEndpoint, deadline);
          if (inResult.data.byteLength === 0) continue;
          response = protocol.decodePacket(new Uint8Array(
            inResult.data.buffer,
            inResult.data.byteOffset,
            inResult.data.byteLength,
          ));
          if (response.sequence !== request.sequence || response.opcode !== opcode ||
              !(response.flags & protocol.WebPacketFlag.RESPONSE)) {
            lastMismatch = true;
            response = null;
            continue;
          }
          break;
        }
        if (!response) throw new Error(lastMismatch ? "WebUSB 响应与请求不匹配" : "等待设备响应超时");
        if (response.flags & protocol.WebPacketFlag.ERROR) throw decodeError(response);
        responses.push(response);
      }
      return responses;
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
      for (let offset = 0; offset < bytes.length;) {
        const batch = [];
        while (batch.length < OTA_BATCH_SIZE && offset < bytes.length) {
          const chunk = bytes.slice(offset, offset + protocol.WEBUSB_DATA_SIZE);
          batch.push({ offset, data: chunk, timeoutMs: 5000 });
          offset += chunk.length;
        }
        await this.requestBatch(protocol.WebOpcode.OTA_DATA, batch);
        if (onProgress) {
          for (let index = 0; index < batch.length; index += 1) {
            const end = batch[index].offset + batch[index].data.length;
            onProgress(Math.round((end / bytes.length) * 100));
          }
        }
      }
      await this.request(protocol.WebOpcode.OTA_COMMIT, { timeoutMs: 15000 });
    }
  }

  class CrazylinkUsbManager extends EventTarget {
    constructor(usb, options) {
      const settings = options || {};
      super();
      this.usb = usb || (typeof navigator !== "undefined" ? navigator.usb : null);
      this.connectTimeoutMs = settings.connectTimeoutMs || USB_CONNECT_TIMEOUT_MS;
      this.current = null;
      this.connectionQueue = Promise.resolve();
      this.pendingDevice = null;
      this.pendingConnection = null;
      this.attempts = new Set();
      if (this.usb) {
        this.usb.addEventListener("disconnect", (event) => this.handleUsbDisconnect(event.device));
      }
    }

    get supported() {
      return Boolean(this.usb);
    }

    cancelAttempt(attempt, error, physicallyDisconnected) {
      if (!attempt.cancelled) {
        attempt.cancelled = true;
        attempt.reason = error;
      }
      if (attempt.connection) {
        if (physicallyDisconnected) attempt.connection.markDisconnected(error);
        else attempt.connection.cancelConnect(error);
      }
      if (!attempt.disconnectSignalled) {
        attempt.disconnectSignalled = true;
        attempt.rejectDisconnect(error);
      }
    }

    handleUsbDisconnect(device) {
      const error = disconnectedError();
      let affected = false;
      if (this.current && sameUsbDevice(device, this.current.device)) {
        this.current.markDisconnected(error);
        this.current = null;
        affected = true;
      }
      for (const attempt of this.attempts) {
        if (sameUsbDevice(device, attempt.device)) {
          this.cancelAttempt(attempt, error, true);
          affected = true;
        }
      }
      if (affected) this.dispatchEvent(new Event("disconnected"));
    }

    connectDevice(device) {
      if (sameUsbDevice(this.current?.device, device) && this.current.interface && this.current.device.opened) {
        return Promise.resolve(this.current);
      }
      if (sameUsbDevice(this.pendingDevice, device) && this.pendingConnection) return this.pendingConnection;

      const attempt = {
        device,
        connection: null,
        cancelled: false,
        reason: null,
        disconnectSignalled: false,
        rejectDisconnect: null,
      };
      const disconnected = new Promise((_, reject) => { attempt.rejectDisconnect = reject; });
      this.attempts.add(attempt);

      const lifecycle = this.connectionQueue.catch(() => undefined).then(async () => {
        if (attempt.cancelled) throw attempt.reason || new Error("连接已取消");
        if (sameUsbDevice(this.current?.device, device) && this.current.interface && this.current.device.opened) {
          return this.current;
        }
        if (this.current) {
          const previous = this.current;
          this.current = null;
          await previous.disconnect();
          if (attempt.cancelled) throw attempt.reason || new Error("连接已取消");
        }
        const connection = new CrazylinkUsbDevice(device);
        attempt.connection = connection;
        if (attempt.cancelled) {
          connection.cancelConnect(attempt.reason);
          throw attempt.reason || new Error("连接已取消");
        }
        await connection.connect();
        if (attempt.cancelled) {
          connection.cancelConnect(attempt.reason);
          await connection.disconnect();
          throw attempt.reason || new Error("连接已取消");
        }
        this.current = connection;
        this.dispatchEvent(new CustomEvent("connected", { detail: connection }));
        return connection;
      });
      this.connectionQueue = lifecycle.catch(() => undefined);

      const timedConnection = withTimeout(lifecycle, this.connectTimeoutMs, "连接设备");
      const operation = Promise.race([timedConnection, disconnected]).catch((error) => {
        if (isTimeoutError(error)) {
          const stage = attempt.connection?.connectStage || "等待上一设备操作完成";
          const detailed = operationError(`连接设备超时（${stage}）`, USB_TIMEOUT_CODE);
          this.cancelAttempt(attempt, detailed, false);
          throw detailed;
        }
        throw error;
      });
      this.pendingDevice = device;
      this.pendingConnection = operation;
      operation.then(() => {
        if (this.pendingConnection === operation) {
          this.pendingDevice = null;
          this.pendingConnection = null;
        }
      }, () => {
        if (this.pendingConnection === operation) {
          this.pendingDevice = null;
          this.pendingConnection = null;
        }
      });
      void lifecycle.then(
        () => this.attempts.delete(attempt),
        () => this.attempts.delete(attempt),
      );
      return operation;
    }

    async disconnectDevice(connection) {
      const target = connection || this.current;
      if (!target) return;
      if (this.current === target || sameUsbDevice(this.current?.device, target.device)) {
        this.current = null;
      }
      await target.disconnect();
    }

    async connectAuthorized() {
      if (!this.usb) return null;
      const devices = await this.usb.getDevices();
      const device = devices.find((item) => item.vendorId === VID && item.productId === PID);
      return device ? this.connectDevice(device) : null;
    }

    async selectDevice() {
      if (!this.usb) throw new Error("当前浏览器不支持 WebUSB，请使用最新版 Chrome 或 Edge");
      return this.usb.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
    }

    async requestDevice() {
      return this.connectDevice(await this.selectDevice());
    }
  }

  return { CrazylinkUsbDevice, CrazylinkUsbManager, DeviceRole, DeviceMode, FlashState, findBulkInterface, describeBulkInterfaces, sameUsbDevice };
});
