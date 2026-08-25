(function (root, factory) {
  const api = factory(root.CRazyLink || (typeof require === "function" ? require("./protocol.js") : {}));
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CRazyLink = Object.assign(root.CRazyLink || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (protocol) {
  "use strict";

  function parseAddress(value) {
    if (typeof value === "number") {
      if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return value >>> 0;
      throw new RangeError("地址必须位于 0x00000000–0xFFFFFFFF");
    }
    const text = String(value || "").trim();
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) throw new TypeError("地址格式无效");
    const parsed = Number.parseInt(text, text.toLowerCase().startsWith("0x") ? 16 : 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
      throw new RangeError("地址必须位于 0x00000000–0xFFFFFFFF");
    }
    return parsed >>> 0;
  }

  function formatAddress(value) {
    return `0x${parseAddress(value).toString(16).toUpperCase().padStart(8, "0")}`;
  }

  function mergeFirmware(entries, target) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("请至少添加一个固件");
    if (entries.length > 3) throw new Error("最多只能合并三个固件");

    const normalized = entries.map((entry, index) => {
      const data = protocol.asBytes(entry.data);
      if (data.length === 0) throw new Error(`${entry.name || `固件 ${index + 1}`} 内容为空`);
      const address = parseAddress(entry.address == null && index === 0 ? 0x08000000 : entry.address);
      const end = address + data.length;
      if (!Number.isSafeInteger(end) || end > 0x100000000) throw new Error("固件地址范围溢出");
      return { name: entry.name || `firmware-${index + 1}.bin`, address, end, data };
    }).sort((left, right) => left.address - right.address);

    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index].address < normalized[index - 1].end) {
        throw new Error(`${normalized[index - 1].name} 与 ${normalized[index].name} 地址重叠`);
      }
    }

    const base = normalized[0].address;
    const end = normalized[normalized.length - 1].end;
    if (target) {
      const flashBase = parseAddress(target.flashBase);
      const flashEnd = flashBase + Number(target.flashSize);
      if (base < flashBase || end > flashEnd) throw new Error("固件超出所选 MCU 的 Flash 范围");
    }

    const image = new Uint8Array(end - base);
    image.fill(0xff);
    for (const entry of normalized) image.set(entry.data, entry.address - base);
    return {
      base,
      end,
      image,
      crc: protocol.crc32(image),
      entries: normalized,
    };
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return { parseAddress, formatAddress, mergeFirmware, formatBytes };
});
