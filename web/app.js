/* Pencil source: configurator/UI/configurator.pen · interaction layer */
(function () {
  "use strict";

  const api = window.CRazyLink || {};
  const targets = {
    stm32f103c8: { flashBase: 0x08000000, flashSize: 64 * 1024, targetId: 0 },
  };
  const state = {
    view: "flash",
    files: [],
    device: null,
    info: null,
    flashing: false,
    serialOpen: false,
    pollTimer: null,
    terminalBytes: 0,
    serial: {
      paused: false,
      filter: "all",
      search: "",
      entries: [],
      rxFrames: 0,
      txFrames: 0,
      errorCount: 0,
      openedAt: 0,
      runtimeTimer: null,
      polling: false,
    },
    upgrade: {
      releases: [],
      release: null,
      transport: null,
      usbDevice: null,
      serialPort: null,
      serialProbeState: "idle",
      localInfo: null,
      role: "CRAZYLINK",
      deviceLabel: "",
      loadingReleases: false,
      flashing: false,
    },
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function iconRefresh() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
    }
  }

  function nowLabel() {
    return new Date().toLocaleTimeString([], { hour12: false });
  }

  function logFlash(message, kind) {
    const line = document.createElement("div");
    line.className = "log-line";
    if (kind) line.dataset.kind = kind;
    line.innerHTML = `<span class="log-time">${nowLabel()}</span><span></span>`;
    line.lastElementChild.textContent = message;
    $("#flashLog").append(line);
    $("#flashLog").scrollTop = $("#flashLog").scrollHeight;
  }

  function toast(message, kind) {
    const item = document.createElement("div");
    item.className = "toast";
    item.dataset.kind = kind || "info";
    item.textContent = message;
    $("#toastRegion").append(item);
    window.setTimeout(() => item.remove(), 4200);
  }

  function setConnection(stateName, label) {
    const element = $("#connectionState");
    element.dataset.state = stateName;
    $("#connectionLabel").textContent = label;
    const mobilePort = $("#mobilePortLabel");
    if (mobilePort) mobilePort.textContent = stateName === "connected" ? "已连接" : "未连接";
  }

  function setView(view) {
    state.view = view;
    $$("[data-view]").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      if (button.classList.contains("mobile-tab")) button.setAttribute("aria-selected", String(active));
      if (button.classList.contains("nav-item")) {
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
    });
    $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.viewPanel === view));
    const copy = {
      flash: { title: "固件烧录", subtitle: "" },
      serial: { title: "串口调试", subtitle: "持续监听、发送与参数配置" },
      upgrade: { title: "固件升级", subtitle: "" },
    }[view];
    $("#viewTitle").textContent = copy.title;
    const subtitle = $("#pageSubtitle");
    if (subtitle) {
      subtitle.textContent = copy.subtitle;
      subtitle.hidden = !copy.subtitle;
    }
    $("#standardHeaderActions").hidden = false;
    $("#serialHeaderActions").hidden = true;
    $(".standard-mobile-actions").hidden = view === "upgrade";
    $(".upgrade-mobile-actions").hidden = view !== "upgrade";
    syncUpgradeVariant();
    updateButtons();
    if (view === "upgrade" && state.upgrade.releases.length === 0 && !state.upgrade.loadingReleases) loadFirmwareReleases();
  }

  function updateDeviceInfo(info) {
    state.info = info || null;
    if (!info) {
      $("#deviceName").textContent = "设备未连接";
      $("#deviceSerial").textContent = "USB 功能接口";
      $("#linkMetric").textContent = "未连接";
      $("#modeMetric").textContent = "—";
      $("#jobMetric").textContent = "无任务";
      const linkState = $("#terminalLinkState");
      if (linkState) linkState.textContent = "未连接";
      setSerialStatus("未监听");
      return;
    }
    const modeNames = { 0: "独立", 1: "离线", 2: "远程主机", 3: "远程设备" };
    const modeName = modeNames[info.mode] || "未知模式";
    const modeLabel = info.mode === 2 ? "Host" : info.mode === 3 ? "Device" : "";
    $("#deviceName").textContent = modeLabel ? `CRazyLink_${modeLabel}` : "CRazyLink";
    $("#deviceSerial").textContent = info.serialNumber || "USB 已授权";
    $("#linkMetric").textContent = info.peerConnected ? "在线" : (info.mode <= 1 ? "本地" : "等待对端");
    $("#modeMetric").textContent = modeName;
    $("#jobMetric").textContent = info.jobStored ? api.formatBytes(info.jobSize || 0) : "无";
    const linkState = $("#terminalLinkState");
    if (linkState) linkState.textContent = info.peerConnected ? "TX ↔ RX" : (info.mode <= 1 ? "本地 UART" : "等待对端");
    const serialLabel = info.peerConnected ? "USB 功能接口 · TX ↔ RX" : (info.mode <= 1 ? "USB 功能接口 · 本地 UART" : "USB 功能接口 · 等待对端");
    $("#serialPortLabel").textContent = serialLabel;
    const mobilePort = $("#mobilePortLabel");
    if (mobilePort) mobilePort.textContent = "已连接";
    $$(".mode-option").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.mode) === info.mode));
  }

  function updateButtons() {
    const connected = Boolean(state.device);
    $("#connectButton").querySelector("span").textContent = state.view === "upgrade" ? "重新选择" : (connected ? "断开设备" : "重新选择");
    $("#mobileConnectButton").setAttribute("aria-label", connected ? "断开设备" : "连接设备");
    $("#flashButton").disabled = !connected || state.files.length === 0 || state.flashing;
    $("#clearFilesButton").disabled = state.files.length === 0 || state.flashing;
    $("#exportFirmwareButton").disabled = state.files.length === 0 || state.flashing;
    $("#serialOpenButton").disabled = !connected || state.flashing;
    $("#serialSendButton").disabled = !connected || !state.serialOpen;
    $("#serialCloseHeaderButton").disabled = !state.serialOpen;
    $("#exportLogButton").disabled = state.serial.entries.length === 0;
    $("#pauseListeningButton").disabled = !state.serialOpen;
    $("#pauseListeningButton").querySelector("svg")?.setAttribute("data-lucide", state.serial.paused ? "play" : "pause");
    $("#serialOpenButton").querySelector("span").textContent = state.serialOpen ? "关闭串口" : "打开串口";
    $("#serialOpenButton").querySelector("svg")?.setAttribute("data-lucide", state.serialOpen ? "radio" : "radio-tower");
    const upgradeReady = Boolean(
      state.upgrade.transport && state.upgrade.release && state.upgrade.role && !state.upgrade.flashing,
    );
    $("#upgradeFlashButton").disabled = !upgradeReady;
    $("#upgradeDeviceButton").disabled = state.upgrade.flashing;
    $("#upgradeReleaseSelect").disabled = state.upgrade.flashing || state.upgrade.loadingReleases;
    const refreshReleasesButton = $("#refreshReleasesButton");
    if (refreshReleasesButton) refreshReleasesButton.disabled = state.upgrade.loadingReleases || state.upgrade.flashing;
    $("#saveRuntimeModeButton").disabled = state.upgrade.transport !== "usb" || !state.device || state.upgrade.flashing;
    const blankFlashButton = $("#blankFlashButton");
    if (blankFlashButton) blankFlashButton.disabled = !upgradeReady;
    iconRefresh();
  }

  function updateFirmwareSummary() {
    if (!state.files.length) {
      $("#mergeMessage").textContent = "等待添加固件";
      $("#mergeSize").textContent = "—";
      $("#taskFileSummary").textContent = "0 个";
      $("#taskAddressSummary").textContent = "—";
      $("#taskSizeSummary").textContent = "—";
      return;
    }
    let summary;
    try {
      summary = api.summarizeFirmware(state.files);
      $("#mergeMessage").textContent = `${state.files.length} 个文件将按地址合并，地址范围无冲突`;
      $("#taskAddressSummary").textContent = `${api.formatAddress(summary.base)} – ${api.formatAddress(summary.end)}`;
    } catch (error) {
      $("#mergeMessage").textContent = error.message || "固件地址存在冲突";
      $("#taskAddressSummary").textContent = "地址冲突";
    }
    const size = api.formatBytes(summary ? summary.bytes : 0);
    $("#mergeSize").textContent = size;
    $("#taskFileSummary").textContent = `${state.files.length} 个`;
    $("#taskSizeSummary").textContent = size;
  }

  function renderFiles() {
    const list = $("#fileList");
    list.replaceChildren();
    $("#fileCount").textContent = `${state.files.length} / 3`;
    if (state.files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "尚未添加固件";
      list.append(empty);
      updateFirmwareSummary();
      iconRefresh();
      updateButtons();
      return;
    }
    state.files.forEach((file, index) => {
      const item = document.createElement("div");
      item.className = "file-item";
      const kind = file.kind || "BIN";
      const size = api.formatBytes(api.firmwareSize(file));
      const range = api.formatFirmwareRange(file);
      const addressControl = kind === "BIN"
        ? `<label class="file-address-label"><span class="file-address-caption">起始地址</span><input class="file-address" data-index="${index}" value="${api.formatAddress(file.segments[0].address)}" inputmode="text"></label>`
        : `<div class="file-address-label"><span class="file-address-caption">地址范围</span><span class="file-address-value" title="${range}">${range}</span></div>`;
      item.innerHTML = `<div class="file-icon-box"><i data-lucide="file-code-2"></i></div><div class="file-item-info"><div class="file-item-name"></div><div class="file-item-meta"><span class="file-kind">${kind}</span><span>·</span><span>${size}</span></div></div>${addressControl}<button class="file-remove" data-index="${index}" type="button" aria-label="移除 ${file.name}" title="移除文件"><i data-lucide="x"></i></button>`;
      item.querySelector(".file-item-name").textContent = file.name;
      list.append(item);
    });
    list.querySelectorAll(".file-address").forEach((input) => input.addEventListener("change", (event) => {
      try {
        state.files[Number(event.target.dataset.index)].address = api.parseAddress(event.target.value);
        event.target.value = api.formatAddress(state.files[Number(event.target.dataset.index)].address);
      } catch (error) {
        toast(error.message, "error");
        event.target.value = api.formatAddress(state.files[Number(event.target.dataset.index)].address);
      }
    }));
    list.querySelectorAll(".file-remove").forEach((button) => button.addEventListener("click", () => {
      state.files.splice(Number(button.dataset.index), 1);
      renderFiles();
    }));
    updateFirmwareSummary();
    iconRefresh();
    updateButtons();
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (state.files.length + files.length > 3) {
      toast("最多只能添加三个固件文件", "error");
      return;
    }
    let added = 0;
    for (const file of files) {
      try {
        const parsed = api.parseFirmwareFile(file.name, new Uint8Array(await file.arrayBuffer()));
        if (parsed.kind === "BIN") {
          const previous = state.files[state.files.length - 1];
          const address = previous ? api.summarizeFirmware([previous]).end : 0x08000000;
          parsed.segments[0].address = address;
        }
        api.summarizeFirmware([parsed]);
        state.files.push(parsed);
        added += 1;
      } catch (error) {
        toast(error.message || `${file.name} 解析失败`, "error");
      }
    }
    renderFiles();
    if (added) logFlash(`已添加 ${added} 个固件文件。`);
  }

  function selectedTarget() {
    return targets[$("#targetSelect").value] || targets.stm32f103c8;
  }

  function setFlashStatus(text, chip, percent) {
    $("#flashStatusText").textContent = text;
    $("#flashStatusChip").textContent = chip;
    $("#flashStatusChip").dataset.state = percent >= 100 ? "success" : (percent > 0 ? "active" : "idle");
    $("#progressLabel").textContent = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
    $("#progressBar").style.setProperty("--progress", String(Math.max(0, Math.min(100, percent)) / 100));
  }

  async function connectDevice() {
    if (state.device) {
      await disconnectDevice();
      return;
    }
    if (!api.CrazylinkUsbManager) {
      toast("浏览器不支持 WebUSB，请使用最新版 Chrome 或 Edge", "error");
      return;
    }
    try {
      setConnection("busy", "等待设备授权…");
      const manager = app.manager;
      const device = await manager.requestDevice();
      state.device = device;
      updateDeviceInfo(device.info || await device.getDeviceInfo());
      await adoptUpgradeUsbDevice(device);
      setConnection("connected", "设备已连接");
      logFlash("已连接 CRazyLink 功能接口。", "success");
      toast("设备连接成功", "success");
    } catch (error) {
      state.device = null;
      updateDeviceInfo(null);
      setConnection("error", error.message || "设备连接失败");
      toast(error.message || "设备连接失败", "error");
    }
    updateButtons();
  }

  async function disconnectDevice() {
    stopSerialPolling();
    stopSerialRuntime();
    if (state.device) {
      try { if (state.serialOpen) await state.device.closeUart(); } catch (_) {}
      try { await state.device.disconnect(); } catch (_) {}
    }
    state.device = null;
    state.info = null;
    state.serialOpen = false;
    state.serial.paused = false;
    state.serial.openedAt = 0;
    $("#serialPortLabel").textContent = "USB 功能接口";
    setSerialStatus("未监听");
    if (state.upgrade.transport === "usb") {
      state.upgrade.transport = null;
      state.upgrade.usbDevice = null;
      state.upgrade.localInfo = null;
      state.upgrade.role = "CRAZYLINK";
      state.upgrade.deviceLabel = "";
      updateUpgradeUi();
    }
    updateDeviceInfo(null);
    setConnection("disconnected", "未连接设备");
    updateButtons();
  }

  async function refreshDevice() {
    if (!state.device) return;
    try {
      updateDeviceInfo(await state.device.getDeviceInfo());
      toast("设备状态已刷新", "success");
    } catch (error) { toast(error.message, "error"); }
  }

  async function flashFirmware() {
    if (!state.device || state.files.length === 0 || state.flashing) return;
    const target = selectedTarget();
    try {
      const merged = api.mergeFirmware(state.files, target);
      state.flashing = true;
      updateButtons();
      setConnection("busy", "烧录中…");
      setFlashStatus("正在上传固件到 RX", "上传中", 0);
      logFlash(`合并完成：${api.formatBytes(merged.image.length)}，CRC 0x${merged.crc.toString(16).padStart(8, "0")}`);
      await state.device.uploadJob({
        targetId: target.targetId,
        erase: $("#eraseSelect").value,
        swdKHz: Number($("#speedSelect").value),
        base: merged.base,
        image: merged.image,
        crc: merged.crc,
        verify: $("#verifyCheck").checked,
        reset: $("#resetCheck").checked,
        note: $("#jobNote").value,
      }, (percent) => setFlashStatus("正在上传固件到 RX", "上传中", percent * .35));
      setFlashStatus("RX 已接收，开始 SWD 烧录", "烧录中", 36);
      logFlash("任务已校验并写入 RX 存储。", "success");
      await state.device.startFlash();
      await state.device.waitForFlash((status) => {
        setFlashStatus(status.message || "正在写入目标 MCU", status.state === api.FlashState.SUCCESS ? "完成" : "烧录中", 36 + status.progress * .64);
      }, 120000);
      setFlashStatus("烧录成功，目标已复位", "完成", 100);
      logFlash("SWD 烧录、校验和复位全部完成。", "success");
      setConnection("connected", "设备已连接");
      await refreshDevice();
    } catch (error) {
      setFlashStatus(error.message || "烧录失败", "错误", 0);
      $("#flashStatusChip").dataset.state = "error";
      logFlash(error.message || "烧录失败", "error");
      setConnection("error", "烧录失败");
      toast(error.message || "烧录失败", "error");
    } finally {
      state.flashing = false;
      updateButtons();
    }
  }

  function parseHex(value) {
    const clean = value.replace(/0x/gi, "").replace(/[\s,;:-]+/g, "");
    if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) throw new Error("HEX 内容必须是偶数位十六进制");
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }

  function formatRuntime(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
  }

  function updateSerialTraffic() {
    const serialTraffic = $("#serialTraffic");
    if (serialTraffic) {
      serialTraffic.textContent = "接收 " + state.serial.rxFrames + " 帧 · 发送 " +
        state.serial.txFrames + " 帧 · 错误 " + state.serial.errorCount;
    }
  }

  function updateSerialRuntime() {
    const runtime = $("#serialRuntime");
    if (!runtime) return;
    const elapsed = state.serial.openedAt ? Date.now() - state.serial.openedAt : 0;
    runtime.textContent = "持续时间 " + formatRuntime(elapsed);
  }

  function setSerialStatus(message, stateName) {
    const statusMessage = $("#serialStatusMessage");
    if (statusMessage) statusMessage.textContent = message;
    const line = $(".serial-status-line");
    if (line) line.dataset.state = stateName || (state.serialOpen ? "active" : "idle");
    const indicator = $(".serial-status-indicator");
    if (indicator) indicator.dataset.state = stateName || (state.serialOpen ? "active" : "idle");
  }

  function renderTerminalLog() {
    const output = $("#terminalOutput");
    if (!output) return;
    const shouldScroll = $("#autoScrollCheck")?.checked;
    output.replaceChildren();
    const search = state.serial.search.trim().toLowerCase();
    const visible = state.serial.entries.filter((entry) => {
      if (state.serial.filter !== "all" && entry.direction !== state.serial.filter) return false;
      return !search || entry.payload.toLowerCase().includes(search);
    });
    if (!visible.length) {
      const placeholder = document.createElement("span");
      placeholder.className = "terminal-placeholder";
      placeholder.textContent = state.serial.entries.length ? "没有匹配的日志" : "等待目标数据…";
      output.append(placeholder);
      return;
    }
    for (const entry of visible) {
      const line = document.createElement("div");
      line.className = "terminal-log-entry";
      line.dataset.direction = entry.direction;
      if (entry.kind) line.dataset.kind = entry.kind;
      const timestamp = document.createElement("span");
      timestamp.className = "terminal-log-time";
      timestamp.textContent = entry.timestamp;
      const direction = document.createElement("span");
      direction.className = "terminal-log-direction";
      direction.textContent = entry.direction;
      const payload = document.createElement("span");
      payload.className = "terminal-log-payload";
      payload.textContent = entry.bytes
        ? ($("#hexDisplayCheck")?.checked
          ? Array.from(entry.bytes, (value) => value.toString(16).padStart(2, "0")).join(" ")
          : new TextDecoder().decode(entry.bytes))
        : entry.payload;
      line.append(timestamp, direction, payload);
      output.append(line);
    }
    if (shouldScroll) output.scrollTop = output.scrollHeight;
  }

  function appendTerminalEntry(direction, value, kind) {
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : null;
    const payload = bytes ? new TextDecoder().decode(bytes) : String(value || "");
    if (!payload && !bytes?.length) return;
    state.serial.entries.push({ timestamp: nowLabel(), direction, payload, bytes, kind: kind || "" });
    if (state.serial.entries.length > 2000) state.serial.entries.splice(0, state.serial.entries.length - 2000);
    if (direction === "RX") {
      state.serial.rxFrames += 1;
      state.terminalBytes += bytes?.length || 0;
    } else if (direction === "TX") {
      state.serial.txFrames += 1;
    }
    updateSerialTraffic();
    renderTerminalLog();
  }

  function recordSerialError(error) {
    state.serial.errorCount += 1;
    updateSerialTraffic();
    appendTerminalEntry("SYS", error?.message || String(error || "串口错误"), "error");
  }

  function stopSerialRuntime() {
    if (state.serial.runtimeTimer) window.clearInterval(state.serial.runtimeTimer);
    state.serial.runtimeTimer = null;
    updateSerialRuntime();
  }

  function startSerialRuntime() {
    stopSerialRuntime();
    state.serial.runtimeTimer = window.setInterval(updateSerialRuntime, 1000);
    updateSerialRuntime();
  }

  function stopSerialPolling() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function startSerialPolling() {
    stopSerialPolling();
    if (state.serial.paused) return;
    const poll = async () => {
      if (state.serial.polling || !state.device || !state.serialOpen || state.serial.paused) return;
      state.serial.polling = true;
      try {
        // A WebUSB response carries 47 UART bytes. Drain several responses per
        // tick so the browser can keep up with the target UART at high baud.
        for (let count = 0; count < 64; count += 1) {
          if (!state.device || !state.serialOpen || state.serial.paused) break;
          const bytes = await state.device.readUart();
          if (!bytes?.length) break;
          appendTerminalEntry("RX", bytes);
        }
      } catch (error) {
        stopSerialPolling();
        state.serialOpen = false;
        stopSerialRuntime();
        setSerialStatus("监听失败", "error");
        recordSerialError(error);
        updateButtons();
        toast(error.message || "串口读取失败", "error");
      } finally {
        state.serial.polling = false;
      }
    };
    state.pollTimer = window.setInterval(poll, 25);
    poll();
  }

  async function toggleSerial() {
    if (!state.device) return;
    if (state.serialOpen) {
      stopSerialPolling();
      try { await state.device.closeUart(); } catch (error) { toast(error.message, "error"); }
      state.serialOpen = false;
      state.serial.paused = false;
      stopSerialRuntime();
      $("#terminalStatus").textContent = "串口已关闭";
      setSerialStatus("未监听");
      appendTerminalEntry("SYS", "串口已关闭");
    } else {
      try {
        await state.device.openUart({ baudRate: Number($("#baudSelect").value), dataBits: Number($("#dataBitsSelect").value), parity: $("#paritySelect").value, stopBits: Number($("#stopBitsSelect").value) });
        state.serialOpen = true;
        state.serial.paused = false;
        state.serial.openedAt = Date.now();
        const parity = { none: "N", odd: "O", even: "E" }[$("#paritySelect").value] || "N";
        $("#serialPortLabel").textContent = "USB 功能接口 · " + $("#baudSelect").value + " / " +
          $("#dataBitsSelect").value + parity + $("#stopBitsSelect").value;
        setSerialStatus("正在监听", "active");
        appendTerminalEntry("SYS", "串口已打开 · " + $("#baudSelect").value + " / " +
          $("#dataBitsSelect").value + parity + $("#stopBitsSelect").value);
        startSerialRuntime();
        $("#terminalStatus").textContent = `${$("#baudSelect").value} / ${$("#dataBitsSelect").value}${$("#paritySelect").value[0].toUpperCase()}${$("#stopBitsSelect").value}`;
        startSerialPolling();
        toast("目标 UART 已打开", "success");
      } catch (error) {
        recordSerialError(error);
        toast(error.message, "error");
      }
    }
    updateButtons();
  }

  async function sendSerial() {
    if (!state.device || !state.serialOpen) return;
    const value = $("#terminalInput").value;
    if (!value) return;
    try {
      const hex = $("#hexSendCheck").checked;
      let bytes = hex ? parseHex(value) : new TextEncoder().encode(value);
      if (!hex) {
        const endings = { CRLF: "\r\n", LF: "\n", CR: "\r" };
        const ending = endings[$("#lineEndingSelect").value] || "";
        if (ending) bytes = new TextEncoder().encode(value + ending);
      }
      await state.device.writeUart(bytes);
      appendTerminalEntry("TX", bytes);
      $("#terminalInput").value = "";
    } catch (error) {
      recordSerialError(error);
      toast(error.message, "error");
    }
  }

  function toggleSerialPause() {
    if (!state.serialOpen) return;
    state.serial.paused = !state.serial.paused;
    if (state.serial.paused) {
      stopSerialPolling();
      setSerialStatus("已暂停", "paused");
      $("#pauseListeningButton").setAttribute("aria-label", "恢复监听");
      $("#pauseListeningButton").setAttribute("title", "恢复监听");
      $("#pauseListeningButton").querySelector("svg")?.setAttribute("data-lucide", "play");
      appendTerminalEntry("SYS", "监听已暂停");
    } else {
      setSerialStatus("正在监听", "active");
      $("#pauseListeningButton").setAttribute("aria-label", "暂停监听");
      $("#pauseListeningButton").setAttribute("title", "暂停监听");
      $("#pauseListeningButton").querySelector("svg")?.setAttribute("data-lucide", "pause");
      appendTerminalEntry("SYS", "监听已恢复");
      startSerialPolling();
    }
    iconRefresh();
  }

  function exportTerminalLog() {
    if (!state.serial.entries.length) return;
    const body = state.serial.entries.map((entry) =>
      "[" + entry.timestamp + "] " + entry.direction + " " + entry.payload).join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "crazylink-serial-" + new Date().toISOString().replace(/[:.]/g, "-") + ".log";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportMergedFirmware() {
    if (!state.files.length) return;
    try {
      const merged = api.mergeFirmware(state.files, selectedTarget());
      const url = URL.createObjectURL(new Blob([merged.image], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "crazylink-merged-" + api.formatAddress(merged.base).slice(2) + ".bin";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast("合并 BIN 已导出", "success");
    } catch (error) {
      toast(error.message || "固件合并失败", "error");
    }
  }

  async function setMode(event) {
    if (!state.device || state.flashing) return;
    try {
      const mode = Number(event.currentTarget.dataset.mode);
      updateDeviceInfo(await state.device.setMode(mode));
      const labels = { 0: "独立", 1: "离线", 2: "远程主机", 3: "远程设备" };
      toast(`已切换至${labels[mode] || "未知"}模式`, "success");
    }
    catch (error) { toast(error.message, "error"); }
  }

  function shortUpgradeDeviceLabel() {
    return state.upgrade.deviceLabel || "当前设备";
  }

  function syncUpgradeVariant() {
    const blankMode = state.view === "upgrade" && state.upgrade.transport === "serial";
    const downloadModeRequired = state.view === "upgrade" && state.upgrade.serialProbeState === "missing";
    const view = $("#upgradeView");
    const blankCard = $("#blankFlashCard");
    const promptCard = $("#downloadModePromptCard");
    if (!view || !blankCard || !promptCard) return;
    view.classList.toggle("is-blank-flash", blankMode);
    view.classList.toggle("is-download-mode-required", downloadModeRequired);
    blankCard.hidden = !blankMode;
    promptCard.hidden = !downloadModeRequired;
    if (state.view !== "upgrade") return;

    $("#viewTitle").textContent = blankMode ? "制作 CRazyLink" : "固件升级";
    const subtitle = $("#pageSubtitle");
    subtitle.textContent = "";
    subtitle.hidden = true;
    const upgradeNav = $(".nav-item[data-view=\"upgrade\"]");
    const flashNav = $(".nav-item[data-view=\"flash\"]");
    if (upgradeNav && flashNav) {
      upgradeNav.classList.toggle("is-active", !blankMode);
      flashNav.classList.toggle("is-active", blankMode);
      upgradeNav.toggleAttribute("aria-current", !blankMode);
      flashNav.toggleAttribute("aria-current", blankMode);
    }
  }

  function setUpgradeStatus(text, kind, progress) {
    const line = $(".upgrade-status-line");
    line.dataset.state = kind || "idle";
    $("#upgradeStatusText").textContent = window.innerWidth <= 640 && text === "发布列表已同步，设备可用" ? "设备可用" : text;
    $("#upgradeProgressLabel").textContent = Number.isFinite(progress) ? `${Math.round(progress)}%` : "";
  }

  function updateUpgradeUi() {
    const upgrade = state.upgrade;
    $("#upgradeDeviceValue").textContent = upgrade.deviceLabel || "选择升级接口";
    $(".upgrade-select-wrap").classList.toggle("has-value", Boolean(upgrade.release));
    if (upgrade.transport === "usb" && upgrade.localInfo) {
      $("#upgradeDetectionLabel").textContent = `CRazyLink · v${upgrade.localInfo.firmwareVersion}`;
    } else if (upgrade.transport === "serial") {
      $("#upgradeDetectionLabel").textContent = "ESP32-S3 Download Mode";
    } else {
      $("#upgradeDetectionLabel").textContent = "自动识别设备类型";
    }
    if (upgrade.localInfo && Number.isInteger(upgrade.localInfo.mode)) {
      $("#runtimeModeSelect").value = String(upgrade.localInfo.mode);
    } else if (state.info && Number.isInteger(state.info.mode)) {
      $("#runtimeModeSelect").value = String(state.info.mode);
    }

    let helper = "选择版本后更新 CRazyLink";
    if (upgrade.release && !upgrade.transport) helper = "连接升级设备后可开始刷写";
    else if (upgrade.release && upgrade.transport) helper = `${upgrade.release.tag} · CRazyLink 已就绪`;
    $("#upgradeFlashHelper").textContent = helper;
    const upgradeAction = $("#upgradeFlashButton")?.querySelector("span");
    if (upgradeAction) upgradeAction.textContent = upgrade.transport === "serial" ? "制作 CRazyLink" : "更新 CRazyLink";
    const blankReleaseSelect = $("#blankReleaseSelect");
    if (blankReleaseSelect) blankReleaseSelect.value = upgrade.release?.tag || "";
    const blankDownloadStatus = $("#blankDownloadStatus");
    if (blankDownloadStatus) {
      blankDownloadStatus.dataset.state = upgrade.transport === "serial" ? "ready" : "idle";
      blankDownloadStatus.querySelector("span").textContent = upgrade.transport === "serial" ? "Download Mode 已就绪" : "等待 Download Mode";
    }
    syncUpgradeVariant();
    updateButtons();
  }

  async function loadFirmwareReleases(notify) {
    if (!api.listFirmwareReleases || state.upgrade.loadingReleases) return;
    state.upgrade.loadingReleases = true;
    setUpgradeStatus("正在同步发布列表", "busy");
    updateButtons();
    try {
      const selectedTag = state.upgrade.release?.tag || "";
      state.upgrade.releases = await api.listFirmwareReleases();
      const selects = [$("#upgradeReleaseSelect"), $("#blankReleaseSelect")].filter(Boolean);
      for (const select of selects) {
        select.replaceChildren(new Option(select.id === "blankReleaseSelect" ? "选择 CRazyLink TAG" : "选择发布 TAG", ""));
        for (const release of state.upgrade.releases) {
          const suffix = release.prerelease ? " · prerelease" : "";
          select.append(new Option(`${release.tag}${suffix}`, release.tag));
        }
      }
      const matched = state.upgrade.releases.find((release) => release.tag === selectedTag) || null;
      state.upgrade.release = matched;
      for (const select of selects) select.value = matched?.tag || "";
      if (state.upgrade.releases.length) {
        setUpgradeStatus("发布列表已同步，设备可用", "success");
        if (notify) toast("发布列表已刷新", "success");
      } else {
        setUpgradeStatus("未找到可用的 CRazyLink 固件发布", "warning");
      }
    } catch (error) {
      state.upgrade.releases = [];
      state.upgrade.release = null;
      [$("#upgradeReleaseSelect"), $("#blankReleaseSelect")].filter(Boolean).forEach((select) => {
        select.replaceChildren(new Option("发布列表加载失败", ""));
      });
      setUpgradeStatus(error.message || "发布列表加载失败", "error");
      if (notify) toast(error.message || "发布列表加载失败", "error");
    } finally {
      state.upgrade.loadingReleases = false;
      updateUpgradeUi();
    }
  }

  async function adoptUpgradeUsbDevice(connection) {
    const localInfo = connection.localInfo || await connection.getLocalDeviceInfo();
    if (!localInfo.otaSupported) throw new Error("当前 CRazyLink 固件不支持 USB OTA，请先通过 UART0 完整烧录");
    state.upgrade.transport = "usb";
    state.upgrade.usbDevice = connection;
    state.upgrade.serialPort = null;
    state.upgrade.serialProbeState = "idle";
    state.upgrade.localInfo = localInfo;
    state.upgrade.role = "CRAZYLINK";
    state.upgrade.deviceLabel = `${localInfo.productName} · ${localInfo.serialNumber}`;
    state.device = connection;
    updateDeviceInfo(connection.info);
    setConnection("connected", "设备已连接");
    setUpgradeStatus("已识别 CRazyLink 设备", "success");
    updateUpgradeUi();
  }

  async function selectUpgradeUsb() {
    $("#upgradeDeviceDialog").close();
    try {
      setUpgradeStatus("等待 CRazyLink USB 授权", "busy");
      const connection = state.device || await app.manager.requestDevice();
      await adoptUpgradeUsbDevice(connection);
      toast("CRazyLink USB 已连接", "success");
    } catch (error) {
      setUpgradeStatus(error.message || "CRazyLink USB 连接失败", "error");
      toast(error.message || "CRazyLink USB 连接失败", "error");
    }
  }

  async function selectUpgradeSerial() {
    $("#upgradeDeviceDialog").close();
    let selectedPort = null;
    try {
      if (!app.espFlasher?.supported) throw new Error("当前浏览器不支持 Web Serial 或 ESP32-S3 烧录组件未加载");
      setUpgradeStatus("等待串口设备授权", "busy");
      selectedPort = await app.espFlasher.requestPort();
      setUpgradeStatus("正在检测 ESP32-S3 Download Mode", "busy");
      const detected = await app.espFlasher.probe(selectedPort);
      state.upgrade.transport = "serial";
      state.upgrade.serialPort = selectedPort;
      state.upgrade.serialProbeState = "ready";
      state.upgrade.usbDevice = null;
      state.upgrade.localInfo = null;
      state.upgrade.role = "CRAZYLINK";
      state.upgrade.deviceLabel = `${api.describeSerialPort(selectedPort)} · ${detected.chip}`;
      $("#deviceName").textContent = "ESP32-S3 升级设备";
      $("#deviceSerial").textContent = state.upgrade.deviceLabel;
      setConnection("connected", state.upgrade.deviceLabel);
      setUpgradeStatus("ESP32-S3 Download Mode 已就绪", "success");
      updateUpgradeUi();
    } catch (error) {
      if (selectedPort) {
        state.upgrade.transport = null;
        state.upgrade.serialPort = selectedPort;
        state.upgrade.serialProbeState = "missing";
        state.upgrade.usbDevice = null;
        state.upgrade.localInfo = null;
        state.upgrade.role = "CRAZYLINK";
        state.upgrade.deviceLabel = api.describeSerialPort(selectedPort);
        $("#deviceName").textContent = "ESP32-S3 升级设备";
        $("#deviceSerial").textContent = state.upgrade.deviceLabel;
        setConnection("error", state.upgrade.deviceLabel);
        setUpgradeStatus("请让 ESP32-S3 进入 Download Mode", "warning");
        updateUpgradeUi();
        toast("Download Mode 未检测到 · 请先进入下载模式", "error");
        return;
      }
      setUpgradeStatus(error.message || "串口设备选择失败", "error");
      toast(error.message || "串口设备选择失败", "error");
    }
  }

  function selectUpgradeRole(event) {
    if (event.currentTarget.disabled || state.upgrade.flashing || state.upgrade.transport !== "serial") return;
    state.upgrade.role = "CRAZYLINK";
    updateUpgradeUi();
  }

  function selectUpgradeRelease(event) {
    state.upgrade.release = state.upgrade.releases.find((release) => release.tag === event.target.value) || null;
    updateUpgradeUi();
  }

  async function flashUpgrade() {
    const upgrade = state.upgrade;
    if (!upgrade.transport || !upgrade.release || upgrade.flashing) return;
    upgrade.flashing = true;
    updateButtons();
    try {
      setUpgradeStatus(`正在下载并校验 ${upgrade.release.tag}`, "busy", 0);
      const opened = await api.downloadReleasePackage(upgrade.release);
      if (upgrade.localInfo && opened.manifest.flashSize > upgrade.localInfo.flashSize) {
        throw new Error(`固件需要 ${api.formatBytes(opened.manifest.flashSize)} Flash，当前设备容量不足`);
      }
      if (upgrade.transport === "usb") {
        const application = opened.segments.find((segment) => segment.kind === "application") ||
          opened.segments.find((segment) => segment.address === 0x10000);
        if (!application) throw new Error("CRL 固件包缺少 application 分段");
        await upgrade.usbDevice.uploadOta(application.data, (progress) => {
          setUpgradeStatus("正在通过 CRazyLink USB 更新当前设备", "busy", progress);
        });
      } else {
        await app.espFlasher.flash(upgrade.serialPort, opened, {
          baudRate: Number($("#upgradeBaudSelect").value),
          eraseAll: $("#upgradeEraseSelect").value === "chip",
          verify: $("#upgradeVerifyCheck").checked,
          reset: $("#upgradeResetCheck").checked,
          onProgress: (progress) => setUpgradeStatus("正在完整烧录 ESP32-S3 CRazyLink", "busy", progress),
        });
      }
      setUpgradeStatus("CRazyLink 固件升级完成", "success", 100);
      toast("CRazyLink 固件升级完成", "success");
    } catch (error) {
      setUpgradeStatus(error.message || "固件升级失败", "error");
      toast(error.message || "固件升级失败", "error");
    } finally {
      upgrade.flashing = false;
      updateUpgradeUi();
    }
  }

  function toggleUpgradeAdvanced() {
    const panel = $("#upgradeAdvancedPanel");
    const expanded = panel.hidden;
    panel.hidden = !expanded;
    $("#upgradeAdvancedButton").setAttribute("aria-expanded", String(expanded));
  }

  function chooseConnection() {
    if (state.view === "upgrade") {
      $("#upgradeDeviceDialog").showModal();
      return;
    }
    connectDevice();
  }

  function toggleRuntimeMode() {
    const panel = $("#runtimeModePanel");
    const expanded = panel.hidden;
    panel.hidden = !expanded;
    $("#runtimeModeDisclosure").setAttribute("aria-expanded", String(expanded));
  }

  async function saveRuntimeMode() {
    if (state.upgrade.transport !== "usb" || !state.device || state.upgrade.flashing) return;
    try {
      const mode = Number($("#runtimeModeSelect").value);
      updateDeviceInfo(await state.device.setMode(mode));
      toast("运行模式已保存，设备将重启", "success");
    } catch (error) {
      toast(error.message || "运行模式保存失败", "error");
    }
  }

  function bind() {
    $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
    $("#connectButton").addEventListener("click", chooseConnection);
    $("#mobileConnectButton").addEventListener("click", chooseConnection);
    $("#refreshDeviceButton").addEventListener("click", refreshDevice);
    $("#firmwareInput").addEventListener("change", (event) => addFiles(event.target.files));
    $("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#dropZone").classList.add("is-dragging"); });
    $("#dropZone").addEventListener("dragleave", () => $("#dropZone").classList.remove("is-dragging"));
    $("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#dropZone").classList.remove("is-dragging"); addFiles(event.dataTransfer.files); });
    $("#clearFilesButton").addEventListener("click", () => { state.files = []; renderFiles(); setFlashStatus("等待固件文件", "待机", 0); });
    $("#flashButton").addEventListener("click", flashFirmware);
    $$(".mode-option").forEach((button) => button.addEventListener("click", setMode));
    $("#serialOpenButton").addEventListener("click", toggleSerial);
    $("#serialCloseHeaderButton").addEventListener("click", () => { if (state.serialOpen) toggleSerial(); });
    $("#serialSendButton").addEventListener("click", sendSerial);
    $("#terminalInput").addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendSerial(); });
    $("#terminalInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        sendSerial();
      }
    });
    $("#terminalSearch").addEventListener("input", (event) => {
      state.serial.search = event.target.value;
      renderTerminalLog();
    });
    $$(".terminal-filter").forEach((button) => button.addEventListener("click", () => {
      state.serial.filter = button.dataset.terminalFilter || "all";
      $$(".terminal-filter").forEach((item) => item.classList.toggle("is-active", item === button));
      renderTerminalLog();
    }));
    $("#autoScrollCheck").addEventListener("change", () => renderTerminalLog());
    const hexDisplayCheck = $("#hexDisplayCheck");
    if (hexDisplayCheck) hexDisplayCheck.addEventListener("change", renderTerminalLog);
    $("#pauseListeningButton").addEventListener("click", toggleSerialPause);
    $("#exportLogButton").addEventListener("click", exportTerminalLog);
    $("#clearTerminalButton").addEventListener("click", () => {
      state.serial.entries = [];
      state.serial.rxFrames = 0;
      state.serial.txFrames = 0;
      state.serial.errorCount = 0;
      state.terminalBytes = 0;
      updateSerialTraffic();
      renderTerminalLog();
    });
    $("#exportFirmwareButton").addEventListener("click", exportMergedFirmware);
    const aboutButton = $("#aboutButton");
    if (aboutButton) aboutButton.addEventListener("click", () => $("#helpDialog").showModal());
    $("#closeHelpButton").addEventListener("click", () => $("#helpDialog").close());
    $("#helpDialog").addEventListener("click", (event) => { if (event.target === $("#helpDialog")) $("#helpDialog").close(); });
    $("#upgradeDeviceButton").addEventListener("click", () => $("#upgradeDeviceDialog").showModal());
    $("#closeUpgradeDeviceDialog").addEventListener("click", () => $("#upgradeDeviceDialog").close());
    $("#upgradeDeviceDialog").addEventListener("click", (event) => { if (event.target === $("#upgradeDeviceDialog")) $("#upgradeDeviceDialog").close(); });
    $("#upgradeUsbChoice").addEventListener("click", selectUpgradeUsb);
    $("#upgradeSerialChoice").addEventListener("click", selectUpgradeSerial);
    $("#upgradeReleaseSelect").addEventListener("change", selectUpgradeRelease);
    $("#blankReleaseSelect").addEventListener("change", selectUpgradeRelease);
    $("#upgradeAdvancedButton").addEventListener("click", toggleUpgradeAdvanced);
    $("#runtimeModeDisclosure").addEventListener("click", toggleRuntimeMode);
    $("#saveRuntimeModeButton").addEventListener("click", saveRuntimeMode);
    $("#upgradeFlashButton").addEventListener("click", flashUpgrade);
    $("#blankFlashButton").addEventListener("click", flashUpgrade);
    const refreshReleasesButton = $("#refreshReleasesButton");
    if (refreshReleasesButton) refreshReleasesButton.addEventListener("click", () => loadFirmwareReleases(true));
    $("#mobileUpgradeDeviceButton").addEventListener("click", () => $("#upgradeDeviceDialog").showModal());
    [$("#releaseSourceButton"), $("#mobileReleaseSourceButton")].filter(Boolean).forEach((button) => button.addEventListener("click", () => {
      window.open("https://github.com/CRazypZival/CRazyLink-Configurator/releases", "_blank", "noopener,noreferrer");
    }));
  }

  const app = {
    manager: api.CrazylinkUsbManager ? new api.CrazylinkUsbManager() : null,
    espFlasher: api.EspSerialFlasher ? new api.EspSerialFlasher() : null,
  };

  async function boot() {
    bind();
    const requestedView = new URLSearchParams(window.location.search).get("view");
    if (["flash", "serial", "upgrade"].includes(requestedView)) setView(requestedView);
    renderFiles();
    updateButtons();
    updateUpgradeUi();
    iconRefresh();
    if (!app.manager || !app.manager.supported) {
      setConnection("error", "浏览器不支持 WebUSB");
    } else {
      app.manager.addEventListener("disconnected", () => {
        if (state.upgrade.usbDevice) {
          state.upgrade.transport = null;
          state.upgrade.usbDevice = null;
          state.upgrade.localInfo = null;
          state.upgrade.role = "CRAZYLINK";
          state.upgrade.deviceLabel = "";
          setUpgradeStatus("CRazyLink USB 已断开", "warning");
          updateUpgradeUi();
        }
        if (state.device) disconnectDevice();
      });
      try {
        const authorized = await app.manager.connectAuthorized();
        if (authorized) {
          state.device = authorized;
          updateDeviceInfo(authorized.info || await authorized.getDeviceInfo());
          setConnection("connected", "设备已连接");
          await adoptUpgradeUsbDevice(authorized);
          updateButtons();
        }
      } catch (error) { setConnection("error", "设备授权已失效"); }
    }
  }

  window.CRazyLinkApp = { state, connectDevice, disconnectDevice, flashFirmware, refreshDevice, flashUpgrade, loadFirmwareReleases };
  boot();
}());
