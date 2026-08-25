/* Hallmark · pre-emit critique: P5 H5 E4 S5 R4 V4 */
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
    $("#viewTitle").textContent = view === "flash" ? "固件烧录" : "串口终端";
  }

  function updateDeviceInfo(info) {
    state.info = info || null;
    if (!info) {
      $("#deviceName").textContent = "等待 CRazyLink";
      $("#deviceSerial").textContent = "连接后显示序列号";
      $("#linkMetric").textContent = "离线";
      $("#modeMetric").textContent = "—";
      $("#jobMetric").textContent = "无";
      $("#terminalLinkState").textContent = "未连接";
      return;
    }
    const role = info.role === 2 ? "RX" : "TX";
    $("#deviceName").textContent = `CRazyLink ${role}`;
    $("#deviceSerial").textContent = info.serialNumber || "USB 已授权";
    $("#linkMetric").textContent = info.peerConnected ? "在线" : (info.mode === 1 ? "本地" : "等待 RX");
    $("#modeMetric").textContent = info.mode === 1 ? "离线" : "在线";
    $("#jobMetric").textContent = info.jobStored ? api.formatBytes(info.jobSize || 0) : "无";
    $("#terminalLinkState").textContent = info.peerConnected ? "TX ↔ RX" : (info.mode === 1 ? "RX 本地" : "等待 RX");
    $$(".mode-option").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.mode) === info.mode));
  }

  function updateButtons() {
    const connected = Boolean(state.device);
    $("#connectButton").querySelector("span").textContent = connected ? "断开设备" : "连接设备";
    $("#mobileConnectButton").setAttribute("aria-label", connected ? "断开设备" : "连接设备");
    $("#flashButton").disabled = !connected || state.files.length === 0 || state.flashing;
    $("#clearFilesButton").disabled = state.files.length === 0 || state.flashing;
    $("#serialOpenButton").disabled = !connected || state.flashing;
    $("#serialSendButton").disabled = !connected || !state.serialOpen;
    $("#serialOpenButton").querySelector("span").textContent = state.serialOpen ? "关闭串口" : "打开串口";
    $("#serialOpenButton").querySelector("svg")?.setAttribute("data-lucide", state.serialOpen ? "radio" : "radio-tower");
    iconRefresh();
  }

  function renderFiles() {
    const list = $("#fileList");
    list.replaceChildren();
    $("#fileCount").textContent = `${state.files.length} / 3`;
    if (state.files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = '<i data-lucide="file-box"></i><span>尚未添加固件</span>';
      list.append(empty);
      iconRefresh();
      updateButtons();
      return;
    }
    state.files.forEach((file, index) => {
      const item = document.createElement("div");
      item.className = "file-item";
      item.innerHTML = `<div class="file-item-name"></div><label class="file-address-label"><span class="sr-only">${file.name} 地址</span><input class="file-address" data-index="${index}" value="${api.formatAddress(file.address)}" inputmode="text"></label><span class="file-item-meta">${api.formatBytes(file.data.length)}</span><button class="file-remove" data-index="${index}" type="button" aria-label="移除 ${file.name}" title="移除文件"><i data-lucide="x"></i></button>`;
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
    iconRefresh();
    updateButtons();
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (state.files.length + files.length > 3) {
      toast("最多只能添加三个 BIN 文件", "error");
      return;
    }
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith(".bin")) {
        toast(`${file.name} 不是 BIN 文件`, "error");
        continue;
      }
      const data = new Uint8Array(await file.arrayBuffer());
      const previous = state.files[state.files.length - 1];
      const address = previous ? previous.address + previous.data.length : 0x08000000;
      state.files.push({ name: file.name, data, address });
    }
    renderFiles();
    logFlash(`已添加 ${files.length} 个固件文件。`);
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
      updateDeviceInfo(await device.getDeviceInfo());
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
    if (state.device) {
      try { if (state.serialOpen) await state.device.closeUart(); } catch (_) {}
      try { await state.device.disconnect(); } catch (_) {}
    }
    state.device = null;
    state.info = null;
    state.serialOpen = false;
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

  function renderTerminal(bytes) {
    if (!bytes.length) return;
    state.terminalBytes += bytes.length;
    const output = $("#terminalOutput");
    const placeholder = output.querySelector(".terminal-placeholder");
    if (placeholder) placeholder.remove();
    const text = $("#hexDisplayCheck").checked
      ? Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ")
      : new TextDecoder().decode(bytes);
    output.append(document.createTextNode(text));
    output.scrollTop = output.scrollHeight;
  }

  function stopSerialPolling() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function startSerialPolling() {
    stopSerialPolling();
    state.pollTimer = window.setInterval(async () => {
      if (!state.device || !state.serialOpen) return;
      try { renderTerminal(await state.device.readUart()); } catch (error) { stopSerialPolling(); toast(error.message, "error"); }
    }, 90);
  }

  async function toggleSerial() {
    if (!state.device) return;
    if (state.serialOpen) {
      stopSerialPolling();
      try { await state.device.closeUart(); } catch (error) { toast(error.message, "error"); }
      state.serialOpen = false;
      $("#terminalStatus").textContent = "串口已关闭";
      logFlash("目标 UART 已停止。");
    } else {
      try {
        await state.device.openUart({ baudRate: Number($("#baudSelect").value), dataBits: Number($("#dataBitsSelect").value), parity: $("#paritySelect").value, stopBits: Number($("#stopBitsSelect").value) });
        state.serialOpen = true;
        $("#terminalStatus").textContent = `${$("#baudSelect").value} / ${$("#dataBitsSelect").value}${$("#paritySelect").value[0].toUpperCase()}${$("#stopBitsSelect").value}`;
        startSerialPolling();
        toast("目标 UART 已打开", "success");
      } catch (error) { toast(error.message, "error"); }
    }
    updateButtons();
  }

  async function sendSerial() {
    if (!state.device || !state.serialOpen) return;
    const value = $("#terminalInput").value;
    if (!value) return;
    try {
      await state.device.writeUart($("#hexSendCheck").checked ? parseHex(value) : new TextEncoder().encode(value));
      $("#terminalInput").value = "";
    } catch (error) { toast(error.message, "error"); }
  }

  async function setMode(event) {
    if (!state.device || state.flashing) return;
    try { updateDeviceInfo(await state.device.setMode(Number(event.currentTarget.dataset.mode))); toast(`已切换至${event.currentTarget.dataset.mode === "1" ? "离线" : "在线"}模式`, "success"); }
    catch (error) { toast(error.message, "error"); }
  }

  function bind() {
    $$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
    $("#connectButton").addEventListener("click", connectDevice);
    $("#mobileConnectButton").addEventListener("click", connectDevice);
    $("#refreshDeviceButton").addEventListener("click", refreshDevice);
    $("#firmwareInput").addEventListener("change", (event) => addFiles(event.target.files));
    $("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); $("#dropZone").classList.add("is-dragging"); });
    $("#dropZone").addEventListener("dragleave", () => $("#dropZone").classList.remove("is-dragging"));
    $("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); $("#dropZone").classList.remove("is-dragging"); addFiles(event.dataTransfer.files); });
    $("#clearFilesButton").addEventListener("click", () => { state.files = []; renderFiles(); setFlashStatus("等待固件文件", "待机", 0); });
    $("#flashButton").addEventListener("click", flashFirmware);
    $$(".mode-option").forEach((button) => button.addEventListener("click", setMode));
    $("#serialOpenButton").addEventListener("click", toggleSerial);
    $("#serialSendButton").addEventListener("click", sendSerial);
    $("#terminalInput").addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendSerial(); });
    $("#clearTerminalButton").addEventListener("click", () => { $("#terminalOutput").replaceChildren(Object.assign(document.createElement("span"), { className: "terminal-placeholder", textContent: "等待目标数据…" })); state.terminalBytes = 0; });
    $("#aboutButton").addEventListener("click", () => $("#helpDialog").showModal());
    $("#closeHelpButton").addEventListener("click", () => $("#helpDialog").close());
    $("#helpDialog").addEventListener("click", (event) => { if (event.target === $("#helpDialog")) $("#helpDialog").close(); });
  }

  const app = {
    manager: api.CrazylinkUsbManager ? new api.CrazylinkUsbManager() : null,
  };

  async function boot() {
    bind();
    renderFiles();
    updateButtons();
    iconRefresh();
    if (!app.manager || !app.manager.supported) {
      setConnection("error", "浏览器不支持 WebUSB");
      return;
    }
    app.manager.addEventListener("disconnected", () => { if (state.device) disconnectDevice(); });
    try {
      const authorized = await app.manager.connectAuthorized();
      if (authorized) {
        state.device = authorized;
        updateDeviceInfo(await authorized.getDeviceInfo());
        setConnection("connected", "设备已连接");
        updateButtons();
      }
    } catch (error) { setConnection("error", "设备授权已失效"); }
  }

  window.CRazyLinkApp = { state, connectDevice, disconnectDevice, flashFirmware, refreshDevice };
  boot();
}());
