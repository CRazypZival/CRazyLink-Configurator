(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CRazyLinkUi = Object.assign(root.CRazyLinkUi || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function upgradeVariant(upgrade) {
    const state = upgrade || {};
    if (state.transport === "usb") return "crazylink";
    if (state.transport === "serial" && state.serialProbeState === "ready") return "blank";
    if (state.serialProbeState === "unsupported") return "unsupported";
    if (state.serialProbeState === "missing") return "download-required";
    return "disconnected";
  }

  return { upgradeVariant };
});
