(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CRazyLink = Object.assign(root.CRazyLink || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_BAUD_RATE = 460800;

  function portInfo(port) {
    if (!port || typeof port.getInfo !== "function") return {};
    return port.getInfo() || {};
  }

  function hexId(value) {
    return Number.isInteger(value) ? value.toString(16).padStart(4, "0").toUpperCase() : "----";
  }

  function describeSerialPort(port) {
    const info = portInfo(port);
    const vid = info.usbVendorId;
    const pid = info.usbProductId;
    const kind = vid === 0x0403
      ? "FTDI UART0"
      : vid === 0x303a
        ? "ESP32-S3 USB Download Mode"
        : "USB Serial";
    return `${kind} · ${hexId(vid)}:${hexId(pid)}`;
  }

  function validatePackage(openedPackage) {
    if (!openedPackage?.manifest || !Array.isArray(openedPackage.segments) || !openedPackage.segments.length) {
      throw new Error("CRL 固件包没有可烧录分段");
    }
    if (openedPackage.manifest.chip !== "ESP32-S3") throw new Error("固件目标不是 ESP32-S3");
    for (const segment of openedPackage.segments) {
      if (!Number.isInteger(segment.address) || segment.address < 0 || !(segment.data instanceof Uint8Array) || !segment.data.length) {
        throw new Error(`CRL 固件分段无效：${segment.name || "unknown"}`);
      }
    }
  }

  class EspSerialFlasher {
    constructor(options) {
      const settings = options || {};
      this.serial = settings.serial || (typeof navigator !== "undefined" ? navigator.serial : null);
      this.library = settings.library || (typeof globalThis !== "undefined" ? globalThis.CRazyLinkEspToolLib : null);
    }

    get supported() {
      return Boolean(this.serial && this.library?.ESPLoader && this.library?.Transport && this.library?.md5);
    }

    async getAuthorizedPorts() {
      return this.serial?.getPorts ? this.serial.getPorts() : [];
    }

    async requestPort() {
      if (!this.serial?.requestPort) throw new Error("当前浏览器不支持 Web Serial，请使用最新版 Chrome 或 Edge");
      return this.serial.requestPort();
    }

    async flash(port, openedPackage, options) {
      if (!this.supported) throw new Error("ESP32-S3 串口烧录组件未加载");
      if (!port) throw new Error("尚未选择升级串口设备");
      validatePackage(openedPackage);
      const settings = options || {};
      const segments = openedPackage.segments.map((segment) => ({
        address: segment.address,
        data: segment.data,
      }));
      const totalBytes = segments.reduce((sum, segment) => sum + segment.data.length, 0);
      const completedBefore = segments.map((_, index) => segments.slice(0, index).reduce((sum, segment) => sum + segment.data.length, 0));
      const terminal = settings.terminal || { clean() {}, write() {}, writeLine() {} };
      const transport = new this.library.Transport(port, false);
      const loader = new this.library.ESPLoader({
        transport,
        baudrate: settings.baudRate || DEFAULT_BAUD_RATE,
        terminal,
        debugLogging: false,
      });
      try {
        const chip = await loader.main(settings.before || "default_reset");
        if (!/ESP32-S3/i.test(chip || "")) throw new Error(`检测到 ${chip || "未知芯片"}，目标必须是 ESP32-S3`);
        await loader.writeFlash({
          fileArray: segments,
          flashMode: "keep",
          flashFreq: "keep",
          flashSize: "keep",
          eraseAll: Boolean(settings.eraseAll),
          compress: settings.compress !== false,
          calculateMD5Hash: this.library.md5,
          reportProgress: (fileIndex, written, total) => {
            if (!settings.onProgress) return;
            const current = total > 0 ? Math.min(written, total) : 0;
            settings.onProgress(Math.round(((completedBefore[fileIndex] + current) / totalBytes) * 100));
          },
        });
        if (settings.reset !== false) await loader.after("hard_reset");
        return { chip, bytesWritten: totalBytes, role: openedPackage.manifest.role };
      } finally {
        try { await transport.disconnect(); } catch (_) {}
      }
    }
  }

  return { DEFAULT_ESP_FLASH_BAUD: DEFAULT_BAUD_RATE, EspSerialFlasher, describeSerialPort };
});
