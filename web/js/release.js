(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CRazyLink = Object.assign(root.CRazyLink || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HEADER_SIZE = 24;
  const SIGNATURE_SIZE = 64;
  const ADDRESS_LIMIT = 0x100000000;
  const MAGIC = Uint8Array.of(0x43, 0x52, 0x4c, 0x31, 0x0d, 0x0a, 0x1a, 0x0a);
  const RELEASES_API = "https://api.github.com/repos/CRazypZival/CRazyLink-Configurator/releases?per_page=30";
  const RELEASES_PAGE = "https://github.com/CRazypZival/CRazyLink-Configurator/releases";
  const RELEASE_INDEX_URL = "releases/index.json";
  const UNIVERSAL_ROLE = "CRAZYLINK";
  const TRUSTED_RELEASE_KEY = Object.freeze({
    kty: "EC",
    x: "6zBJhirHwJMymFr2K9V6FPwuRS5CuIYL_eR-lcrkVXc",
    y: "-hAJy8ITo7KJndp59djtoXFMckaIGmsTknhrF97w2DY",
    crv: "P-256",
  });

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("固件包必须是二进制数据");
  }

  function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function fnv1a(bytes, seed) {
    let hash = seed === undefined ? 0x811c9dc5 : seed >>> 0;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash || 0x6d2b79f5;
  }

  function xorshift32(state) {
    let value = state >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  }

  function decodeBase64(value) {
    if (typeof atob === "function") return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return Uint8Array.from(Buffer.from(value, "base64"));
  }

  function chunkSeed(nonce, index) {
    return fnv1a(concat([nonce, Uint8Array.of(index & 0xff, (index >>> 8) & 0xff, (index >>> 16) & 0xff, (index >>> 24) & 0xff)]));
  }

  function transformChunk(chunk, nonce, originalIndex) {
    const output = new Uint8Array(chunk.length);
    let state = chunkSeed(nonce, originalIndex);
    for (let index = 0; index < chunk.length; index += 1) {
      if ((index & 3) === 0) state = xorshift32(state);
      output[index] = chunk[index] ^ ((state >>> ((index & 3) * 8)) & 0xff);
    }
    return output;
  }

  function parseCrlPackage(value) {
    const bytes = asBytes(value);
    if (bytes.length < HEADER_SIZE + SIGNATURE_SIZE) throw new Error("CRL 固件包不完整");
    for (let index = 0; index < MAGIC.length; index += 1) {
      if (bytes[index] !== MAGIC[index]) throw new Error("CRL 固件包魔数无效");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const formatVersion = view.getUint16(8, true);
    const manifestLength = view.getUint32(12, true);
    const payloadLength = view.getUint32(16, true);
    const signatureLength = view.getUint16(20, true);
    if (formatVersion !== 1 || signatureLength !== SIGNATURE_SIZE) throw new Error("CRL 固件包版本不受支持");
    const signedLength = HEADER_SIZE + manifestLength + payloadLength;
    if (manifestLength > bytes.length - HEADER_SIZE - signatureLength ||
        payloadLength > bytes.length - HEADER_SIZE - manifestLength - signatureLength ||
        signedLength + signatureLength !== bytes.length) {
      throw new Error("CRL 固件包长度无效");
    }
    let manifest;
    try {
      manifest = JSON.parse(new TextDecoder().decode(bytes.slice(HEADER_SIZE, HEADER_SIZE + manifestLength)));
    } catch (_) {
      throw new Error("CRL 固件清单无效");
    }
    if (manifest.format !== "CRL1" || manifest.chip !== "ESP32-S3" ||
        ![UNIVERSAL_ROLE, "TX", "RX"].includes(manifest.role) || !Array.isArray(manifest.segments)) {
      throw new Error("CRL 固件清单字段无效");
    }
    validateManifest(manifest);
    return {
      bytes,
      manifest,
      payload: bytes.slice(HEADER_SIZE + manifestLength, signedLength),
      signedBytes: bytes.slice(0, signedLength),
      signature: bytes.slice(signedLength),
    };
  }

  function validateManifest(manifest) {
    if (!Number.isSafeInteger(manifest.flashSize) || manifest.flashSize <= 0 ||
        manifest.flashSize > ADDRESS_LIMIT || manifest.segments.length === 0) {
      throw new Error("CRL 固件 Flash 清单无效");
    }

    let expectedOffset = 0;
    const ranges = [];
    for (const entry of manifest.segments) {
      if (typeof entry.name !== "string" || typeof entry.kind !== "string" ||
          typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256) ||
          !Number.isSafeInteger(entry.address) || entry.address < 0 ||
          !Number.isSafeInteger(entry.offset) || entry.offset !== expectedOffset ||
          !Number.isSafeInteger(entry.length) || entry.length <= 0) {
        throw new Error(`CRL 固件分段清单无效：${entry.name || "unknown"}`);
      }
      const end = entry.address + entry.length;
      if (!Number.isSafeInteger(end) || end > manifest.flashSize) {
        throw new Error(`CRL 固件分段超出 Flash：${entry.name}`);
      }
      ranges.push({ address: entry.address, end, name: entry.name });
      expectedOffset += entry.length;
      if (!Number.isSafeInteger(expectedOffset)) throw new Error("CRL 固件分段总长度无效");
    }
    ranges.sort((left, right) => left.address - right.address);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index].address < ranges[index - 1].end) {
        throw new Error(`CRL 固件分段重叠：${ranges[index].name}`);
      }
    }
    return expectedOffset;
  }

  async function sha256Hex(value, cryptoImpl) {
    const cryptoApi = cryptoImpl || globalThis.crypto;
    if (!cryptoApi?.subtle) throw new Error("浏览器不支持固件 SHA-256 校验");
    const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", asBytes(value)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function verifyCrlSignature(parsed, publicKey, cryptoImpl) {
    const cryptoApi = cryptoImpl || globalThis.crypto;
    if (!cryptoApi?.subtle) throw new Error("浏览器不支持固件签名校验");
    const key = await cryptoApi.subtle.importKey(
      "jwk",
      publicKey || TRUSTED_RELEASE_KEY,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await cryptoApi.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      parsed.signature,
      parsed.signedBytes,
    );
    if (!valid) throw new Error("CRL 固件签名无效");
    return true;
  }

  function restorePayload(parsed) {
    const transform = parsed.manifest.transform || {};
    if (transform.name !== "chunk-interleave-xor-v1" || !Number.isSafeInteger(transform.chunkSize) ||
        transform.chunkSize < 64 || transform.chunkSize > 65536 ||
        !Number.isSafeInteger(transform.plainLength) || transform.plainLength <= 0 ||
        !Array.isArray(transform.order)) {
      throw new Error("CRL 固件变换参数无效");
    }
    if (transform.plainLength !== parsed.payload.length) {
      throw new Error("CRL 固件载荷长度无效");
    }
    const chunkCount = Math.ceil(transform.plainLength / transform.chunkSize);
    if (transform.order.length !== chunkCount || new Set(transform.order).size !== chunkCount) {
      throw new Error("CRL 固件分块顺序无效");
    }
    let nonce;
    try {
      nonce = decodeBase64(transform.nonce);
    } catch (_) {
      throw new Error("CRL 固件随机数无效");
    }
    if (nonce.length < 8 || nonce.length > 64) throw new Error("CRL 固件随机数长度无效");
    const plain = new Uint8Array(transform.plainLength);
    let payloadOffset = 0;
    for (const originalIndex of transform.order) {
      if (!Number.isInteger(originalIndex) || originalIndex < 0 || originalIndex >= chunkCount) {
        throw new Error("CRL 固件分块索引无效");
      }
      const plainOffset = originalIndex * transform.chunkSize;
      const length = Math.min(transform.chunkSize, transform.plainLength - plainOffset);
      if (payloadOffset + length > parsed.payload.length) throw new Error("CRL 固件分块长度无效");
      plain.set(transformChunk(parsed.payload.slice(payloadOffset, payloadOffset + length), nonce, originalIndex), plainOffset);
      payloadOffset += length;
    }
    if (payloadOffset !== parsed.payload.length) throw new Error("CRL 固件载荷存在多余数据");
    return plain;
  }

  async function openCrlPackage(value, options) {
    const settings = options || {};
    const parsed = parseCrlPackage(value);
    await verifyCrlSignature(parsed, settings.publicKey, settings.crypto);
    if (settings.role && parsed.manifest.role !== settings.role &&
        parsed.manifest.role !== UNIVERSAL_ROLE && settings.role !== UNIVERSAL_ROLE) {
      throw new Error(`固件目标为 ${parsed.manifest.role}，不能烧录到 ${settings.role}`);
    }
    const plain = restorePayload(parsed);
    const expectedPlainLength = validateManifest(parsed.manifest);
    if (expectedPlainLength !== plain.length) throw new Error("CRL 固件分段总长度不匹配");
    const segments = [];
    for (const entry of parsed.manifest.segments) {
      if (!Number.isInteger(entry.offset) || !Number.isInteger(entry.length) ||
          entry.offset < 0 || entry.length <= 0 || entry.offset + entry.length > plain.length) {
        throw new Error(`CRL 固件分段无效：${entry.name || "unknown"}`);
      }
      const data = plain.slice(entry.offset, entry.offset + entry.length);
      if (await sha256Hex(data, settings.crypto) !== entry.sha256) {
        throw new Error(`CRL 固件分段校验失败：${entry.name}`);
      }
      segments.push({ ...entry, data });
    }
    return { manifest: parsed.manifest, segments };
  }

  async function fetchJson(url, fetchImpl) {
    let response;
    try {
      response = await (fetchImpl || fetch)(url, {
        cache: "no-store",
        headers: { Accept: "application/vnd.github+json" },
      });
    } catch (error) {
      const wrapped = new Error("无法连接 GitHub Releases，请检查网络或稍后重试");
      wrapped.cause = error;
      throw wrapped;
    }
    if (!response.ok) {
      const suffix = response.status === 403 ? "（GitHub API 可能被限流）" : `：HTTP ${response.status}`;
      const error = new Error(`GitHub Releases 请求失败${suffix}`);
      error.status = response.status;
      throw error;
    }
    const value = await response.json();
    if (value == null) throw new Error("GitHub Releases 返回为空");
    return value;
  }

  async function listFirmwareReleases(fetchImpl) {
    try {
      const staticReleases = await fetchJson(RELEASE_INDEX_URL, fetchImpl);
      if (!Array.isArray(staticReleases)) throw new Error("静态发布索引格式无效");
      const results = [];
      for (const release of staticReleases) {
        if (!release || !release.tag || !release.manifestUrl) continue;
        let manifest;
        try {
          manifest = await fetchJson(release.manifestUrl, fetchImpl);
        } catch (_) {
          continue;
        }
        if (!manifest || !Array.isArray(manifest.packages)) continue;
        results.push({
          tag: release.tag,
          prerelease: Boolean(release.prerelease),
          publishedAt: release.publishedAt || null,
          manifest,
          packageUrl: release.packageUrl || null,
        });
      }
      return results;
    } catch (_) {
      // Local/offline builds do not contain the Pages release index. Fall back to GitHub Releases.
    }

    const releases = await fetchJson(RELEASES_API, fetchImpl);
    if (!Array.isArray(releases)) throw new Error("GitHub Releases 返回格式无效");
    const results = [];
    for (const release of releases) {
      if (release.draft) continue;
      const manifestAsset = (release.assets || []).find((asset) => asset.name === "manifest.json");
      if (!manifestAsset) continue;
      let manifest;
      try {
        manifest = await fetchJson(manifestAsset.browser_download_url, fetchImpl);
      } catch (_) {
        continue;
      }
      if (!manifest || !Array.isArray(manifest.packages)) continue;
      results.push({ tag: release.tag_name, prerelease: Boolean(release.prerelease), publishedAt: release.published_at, manifest, packageUrl: null });
    }
    return results;
  }

  async function downloadReleasePackage(release, roleOrFetch, fetchImpl) {
    const requestedRole = typeof roleOrFetch === "string" ? roleOrFetch : UNIVERSAL_ROLE;
    const fetcher = typeof roleOrFetch === "function" ? roleOrFetch : (fetchImpl || fetch);
    const packages = release?.manifest?.packages || [];
    const entry = packages.find((item) => item.role === UNIVERSAL_ROLE) ||
      packages.find((item) => item.role === requestedRole) ||
      (packages.length === 1 ? packages[0] : null);
    if (!entry) throw new Error("发布版本不包含 CRazyLink 固件");
    const packageUrl = release?.packageUrl ||
      `https://github.com/CRazypZival/CRazyLink-Configurator/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(entry.file)}`;
    const response = await fetcher(packageUrl);
    if (!response.ok) throw new Error(`固件下载失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (await sha256Hex(bytes) !== entry.sha256) throw new Error("下载固件与 Release 校验值不一致");
    return openCrlPackage(bytes, { role: UNIVERSAL_ROLE });
  }

  return {
    TRUSTED_RELEASE_KEY,
    UNIVERSAL_ROLE,
    RELEASES_API,
    RELEASES_PAGE,
    RELEASE_INDEX_URL,
    parseCrlPackage,
    verifyCrlSignature,
    openCrlPackage,
    listFirmwareReleases,
    downloadReleasePackage,
    restorePayload,
    validateManifest,
    sha256Hex,
  };
});
