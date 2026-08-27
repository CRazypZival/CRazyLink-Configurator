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
