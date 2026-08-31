const test = require("node:test");
const assert = require("node:assert/strict");

const release = require("../js/release.js");

test("CRL parser rejects invalid magic and unsupported versions", () => {
  assert.throws(() => release.parseCrlPackage(new Uint8Array(10)), /不完整/);
  const bytes = new Uint8Array(24 + 64);
  bytes.set([0x43, 0x52, 0x4c, 0x31, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint16(8, 2, true);
  new DataView(bytes.buffer).setUint16(20, 64, true);
  assert.throws(() => release.parseCrlPackage(bytes), /版本/);
});

test("release list ignores drafts and releases without a manifest", async () => {
  const responses = new Map([
    [release.RELEASES_API, [
      { tag_name: "v2", draft: true, assets: [] },
      { tag_name: "v1", draft: false, prerelease: false, published_at: "now", assets: [{ name: "manifest.json", browser_download_url: "manifest" }] },
      { tag_name: "v0", draft: false, assets: [] },
    ]],
    ["manifest", { packages: [{ role: "CRAZYLINK", file: "crazylink.crl" }] }],
  ]);
  const fetchImpl = async (url) => ({ ok: true, json: async () => responses.get(url) });
  const result = await release.listFirmwareReleases(fetchImpl);
  assert.equal(result.length, 1);
  assert.equal(result[0].tag, "v1");
});

test("an empty GitHub release list is a valid result", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  assert.deepEqual(await release.listFirmwareReleases(fetchImpl), []);
});

test("same-origin release index avoids GitHub asset CORS redirects", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url === release.RELEASE_INDEX_URL) {
      return {
        ok: true,
        json: async () => [{
          tag: "v1.1.2",
          prerelease: false,
          publishedAt: "now",
          manifestUrl: "releases/v1.1.2/manifest.json",
          packageUrl: "releases/v1.1.2/CRazyLink_v1.1.2.crl",
        }],
      };
    }
    if (url === "releases/v1.1.2/manifest.json") {
      return {
        ok: true,
        json: async () => ({ packages: [{ role: "CRAZYLINK", file: "CRazyLink_v1.1.2.crl" }] }),
      };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const result = await release.listFirmwareReleases(fetchImpl);
  assert.equal(result[0].tag, "v1.1.2");
  assert.equal(result[0].packageUrl, "releases/v1.1.2/CRazyLink_v1.1.2.crl");
  assert.deepEqual(requests, [release.RELEASE_INDEX_URL, "releases/v1.1.2/manifest.json"]);
});

test("a broken release manifest does not block valid releases", async () => {
  const releases = [
    { tag_name: "v2", draft: false, assets: [{ name: "manifest.json", browser_download_url: "broken" }] },
    { tag_name: "v1", draft: false, assets: [{ name: "manifest.json", browser_download_url: "valid" }] },
  ];
  const fetchImpl = async (url) => {
    if (url === release.RELEASES_API) return { ok: true, json: async () => releases };
    if (url === "broken") return { ok: false, status: 404, json: async () => null };
    return { ok: true, json: async () => ({ packages: [{ role: "CRAZYLINK", file: "crazylink.crl" }] }) };
  };
  const result = await release.listFirmwareReleases(fetchImpl);
  assert.deepEqual(result.map((item) => item.tag), ["v1"]);
});

test("CRL manifest validation rejects unsafe address and payload layouts", () => {
  const base = {
    flashSize: 0x100,
    segments: [{
      name: "application",
      kind: "application",
      address: 0,
      offset: 0,
      length: 2,
      sha256: "0".repeat(64),
    }],
  };
  assert.equal(release.validateManifest(base), 2);
  assert.throws(() => release.validateManifest({
    ...base,
    segments: [{ ...base.segments[0], address: 0xff }],
  }), /超出 Flash/);
  assert.throws(() => release.validateManifest({
    ...base,
    segments: [
      base.segments[0],
      { ...base.segments[0], name: "overlap", offset: 2, address: 1 },
    ],
  }), /重叠/);
});
