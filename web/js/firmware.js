(function (root, factory) {
  const api = factory(root.CRazyLink || (typeof require === "function" ? require("./protocol.js") : {}));
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CRazyLink = Object.assign(root.CRazyLink || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function (protocol) {
  "use strict";

  const ADDRESS_LIMIT = 0x100000000;
  const DEFAULT_FLASH_ADDRESS = 0x08000000;

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

  function asBytes(value) {
    return protocol.asBytes(value);
  }

  function coalesceSegments(segments) {
    const sorted = segments.slice().sort((left, right) => left.address - right.address);
    const result = [];
    for (const segment of sorted) {
      const data = asBytes(segment.data);
      if (data.length === 0) continue;
      if (result.length && result[result.length - 1].address + result[result.length - 1].data.length === segment.address) {
        const previous = result[result.length - 1];
        const merged = new Uint8Array(previous.data.length + data.length);
        merged.set(previous.data);
        merged.set(data, previous.data.length);
        previous.data = merged;
      } else {
        result.push({ address: segment.address, data });
      }
    }
    return result;
  }

  function parseIntelHex(value) {
    const text = typeof value === "string" ? value : new TextDecoder("ascii", { fatal: false }).decode(asBytes(value));
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error("HEX 文件为空");

    let addressBase = 0;
    let sawEof = false;
    const segments = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line.startsWith(":")) throw new Error(`HEX 第 ${lineIndex + 1} 行缺少冒号`);
      const encoded = line.slice(1);
      if (encoded.length < 10 || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encoded)) {
        throw new Error(`HEX 第 ${lineIndex + 1} 行格式无效`);
      }
      const record = new Uint8Array(encoded.length / 2);
      for (let index = 0; index < record.length; index += 1) {
        record[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
      }
      const length = record[0];
      if (record.length !== length + 5) throw new Error(`HEX 第 ${lineIndex + 1} 行长度不匹配`);
      let checksum = 0;
      for (const byte of record) checksum = (checksum + byte) & 0xff;
      if (checksum !== 0) throw new Error(`HEX 第 ${lineIndex + 1} 行校验和错误`);
      const address = (record[1] << 8) | record[2];
      const type = record[3];
      if (sawEof) throw new Error(`HEX 第 ${lineIndex + 1} 行出现在 EOF 之后`);
      if (type === 0x00) {
        const absolute = addressBase + address;
        if (absolute + length > ADDRESS_LIMIT) throw new Error(`HEX 第 ${lineIndex + 1} 行地址溢出`);
        if (length !== 0) segments.push({ address: absolute, data: record.slice(4, 4 + length) });
      } else if (type === 0x01) {
        if (length !== 0 || address !== 0) throw new Error(`HEX 第 ${lineIndex + 1} 行 EOF 记录无效`);
        sawEof = true;
      } else if (type === 0x02) {
        if (length !== 2) throw new Error(`HEX 第 ${lineIndex + 1} 行段地址记录无效`);
        addressBase = (((record[4] << 8) | record[5]) << 4) >>> 0;
      } else if (type === 0x04) {
        if (length !== 2) throw new Error(`HEX 第 ${lineIndex + 1} 行线性地址记录无效`);
        addressBase = (((record[4] << 8) | record[5]) << 16) >>> 0;
      } else if (type === 0x03 || type === 0x05) {
        if (length !== 4) throw new Error(`HEX 第 ${lineIndex + 1} 行入口地址记录无效`);
      } else {
        throw new Error(`HEX 第 ${lineIndex + 1} 行不支持记录类型 0x${type.toString(16).padStart(2, "0")}`);
      }
    }
    if (!sawEof) throw new Error("HEX 文件缺少 EOF 记录");
    const result = coalesceSegments(segments);
    if (!result.length) throw new Error("HEX 文件没有可烧录数据");
    return result;
  }

  function parseElf(value) {
    const bytes = asBytes(value);
    if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
      throw new Error("ELF 文件头无效");
    }
    const elfClass = bytes[4];
    if (bytes[5] !== 1) throw new Error("仅支持小端 ELF 文件");
    if (elfClass !== 1 && elfClass !== 2) throw new Error("仅支持 ELF32 或 ELF64 文件");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const read16 = (offset) => view.getUint16(offset, true);
    const read32 = (offset) => view.getUint32(offset, true);
    const read64 = (offset) => {
      const value64 = view.getBigUint64(offset, true);
      if (value64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ELF 地址或偏移超出浏览器安全范围");
      return Number(value64);
    };
    let programOffset;
    let programEntrySize;
    let programCount;
    if (elfClass === 1) {
      programOffset = read32(28);
      programEntrySize = read16(42);
      programCount = read16(44);
    } else {
      if (bytes.length < 64) throw new Error("ELF64 文件头不完整");
      programOffset = read64(32);
      programEntrySize = read16(54);
      programCount = read16(56);
    }
    const minimumEntrySize = elfClass === 1 ? 32 : 56;
    if (programEntrySize < minimumEntrySize || programCount === 0 ||
        programOffset > bytes.length || programOffset + programEntrySize * programCount > bytes.length) {
      throw new Error("ELF 程序段表无效");
    }

    const segments = [];
    for (let index = 0; index < programCount; index += 1) {
      const offset = programOffset + index * programEntrySize;
      const type = read32(offset);
      if (type !== 1) continue;
      let fileOffset;
      let virtualAddress;
      let physicalAddress;
      let fileSize;
      let memorySize;
      if (elfClass === 1) {
        fileOffset = read32(offset + 4);
        virtualAddress = read32(offset + 8);
        physicalAddress = read32(offset + 12);
        fileSize = read32(offset + 16);
        memorySize = read32(offset + 20);
      } else {
        fileOffset = read64(offset + 8);
        virtualAddress = read64(offset + 16);
        physicalAddress = read64(offset + 24);
        fileSize = read64(offset + 32);
        memorySize = read64(offset + 40);
      }
      if (fileSize === 0) continue;
      if (fileSize > memorySize || fileOffset > bytes.length || fileOffset + fileSize > bytes.length) {
        throw new Error(`ELF 程序段 ${index} 范围无效`);
      }
      const address = physicalAddress || virtualAddress;
      if (address + fileSize > ADDRESS_LIMIT) throw new Error(`ELF 程序段 ${index} 地址溢出`);
      segments.push({ address, data: bytes.slice(fileOffset, fileOffset + fileSize) });
    }
    const result = coalesceSegments(segments);
    if (!result.length) throw new Error("ELF 文件没有可烧录的 PT_LOAD 段");
    return result;
  }

  function parseFirmwareFile(name, value) {
    const lowerName = String(name || "").toLowerCase();
    if (lowerName.endsWith(".hex") || lowerName.endsWith(".ihx")) {
      return { name, kind: "HEX", segments: parseIntelHex(value) };
    }
    if (lowerName.endsWith(".elf") || lowerName.endsWith(".axf")) {
      return { name, kind: "ELF", segments: parseElf(value) };
    }
    if (!lowerName.endsWith(".bin")) throw new Error(`${name || "文件"} 不是 BIN、HEX 或 ELF 文件`);
    const data = asBytes(value);
    if (data.length === 0) throw new Error(`${name || "固件"} 内容为空`);
    return { name, kind: "BIN", segments: [{ data }] };
  }

  function normalizeEntry(entry, index) {
    const rawSegments = Array.isArray(entry.segments) ? entry.segments : [{ address: entry.address, data: entry.data }];
    if (!rawSegments.length) throw new Error(`${entry.name || `固件 ${index + 1}`} 内容为空`);
    return rawSegments.map((segment, segmentIndex) => {
      const data = asBytes(segment.data);
      if (data.length === 0) throw new Error(`${entry.name || `固件 ${index + 1}`} 段 ${segmentIndex + 1} 内容为空`);
      const defaultAddress = index === 0 && segmentIndex === 0 ? DEFAULT_FLASH_ADDRESS : undefined;
      const address = parseAddress(segment.address == null ? defaultAddress : segment.address);
      const end = address + data.length;
      if (!Number.isSafeInteger(end) || end > ADDRESS_LIMIT) throw new Error("固件地址范围溢出");
      return { name: entry.name || `firmware-${index + 1}`, address, end, data };
    });
  }

  function summarizeFirmware(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { bytes: 0, base: 0, end: 0, segments: [] };
    const segments = entries.flatMap((entry, index) => normalizeEntry(entry, index))
      .sort((left, right) => left.address - right.address);
    for (let index = 1; index < segments.length; index += 1) {
      if (segments[index].address < segments[index - 1].end) {
        throw new Error(`${segments[index - 1].name} 与 ${segments[index].name} 地址重叠`);
      }
    }
    return {
      bytes: segments.reduce((total, segment) => total + segment.data.length, 0),
      base: segments[0].address,
      end: segments[segments.length - 1].end,
      segments,
    };
  }

  function mergeFirmware(entries, target) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("请至少添加一个固件");
    if (entries.length > 3) throw new Error("最多只能合并三个固件文件");
    const summary = summarizeFirmware(entries);
    const { base, end, segments } = summary;
    if (target) {
      const flashBase = parseAddress(target.flashBase);
      const flashEnd = flashBase + Number(target.flashSize);
      if (base < flashBase || end > flashEnd) throw new Error("固件超出所选 MCU 的 Flash 范围");
    }
    const image = new Uint8Array(end - base);
    image.fill(0xff);
    for (const segment of segments) image.set(segment.data, segment.address - base);
    return { base, end, image, crc: protocol.crc32(image), entries: segments };
  }

  function formatFirmwareRange(entry) {
    const summary = summarizeFirmware([entry]);
    const end = summary.end === ADDRESS_LIMIT ? "0x100000000" : formatAddress(summary.end);
    return `${formatAddress(summary.base)} – ${end}`;
  }

  function firmwareSize(entry) {
    return summarizeFirmware([entry]).bytes;
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return {
    parseAddress,
    formatAddress,
    parseIntelHex,
    parseElf,
    parseFirmwareFile,
    summarizeFirmware,
    formatFirmwareRange,
    firmwareSize,
    mergeFirmware,
    formatBytes,
  };
});
