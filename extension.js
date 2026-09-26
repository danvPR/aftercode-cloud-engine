(function (Scratch) {
  "use strict";

  const DB_ICON_URL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTIxIDEyYzAgMS42Ni00IDMtOSAzcy05LTEuMzQtOS0zIi8+PHBhdGggZD0iTTMgNXY3YzAgMS42NiA0IDMgOSAzczktMS4zNCA5LTMiLz48cGF0aCBkPSJNMjEgNWMwIDEuNjYtNCAzLTkgM3MtOS0xLjM0LTktMyA0LTMgOS0zIDkgMS4zNCA5IDNaIi8+PC9zdmc+";

  const DEFAULT_SERVER = "https://aftercode-cloud-engine.onrender.com";
  let cacheCooldownMs = 2000;
  const HOVER_DELAY = 450; 
  const REQUEST_TIMEOUT_MS = 8000; // Timeout 8s cho toàn bộ request

  let currentServerUrl = DEFAULT_SERVER;
  let lastRequestTime = 0;
  
  let currentProjectId = "default_project";
  let isEmbeddedMode = false;
  let defaultUsername = "Player1";
  
  const localMemoryCache = new Map();
  const localCloudVars = new Map();

  let currentLoadedScore = 0;
  let currentLoadedData = "{}";
  let currentBatchData = "{}";
  let dbStatus = "IDLE";

  function isEmbedded() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  }

  try {
    if (typeof window !== "undefined" && window.location) {
      const searchParams = new URLSearchParams(window.location.search);
      const urlPid = searchParams.get("project") || searchParams.get("projectId");
      if (urlPid) currentProjectId = urlPid.trim();
    }
  } catch (e) {}

  if (typeof window !== "undefined") {
    if (!isEmbedded()) {
      isEmbeddedMode = false;
      dbStatus = "EDITOR_LOCAL_CACHE";
    } else {
      isEmbeddedMode = true;
      dbStatus = "EMBED_CONNECTING";
      window.parent.postMessage({ type: "DANV_CLOUD_HANDSHAKE" }, "*");
    }

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "DANV_CLOUD_INIT" || data.type === "DANV_WOW_INIT") {
        isEmbeddedMode = true;
        if (data.projectId) currentProjectId = String(data.projectId);
        if (data.username) defaultUsername = String(data.username);
        dbStatus = "ONLINE";
      }
    });
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function getLocalKey(user, key = "data") {
    return `DANV_LOCAL_${currentProjectId}_${user}_${key}`;
  }
  function saveToLocal(user, key, val) {
    const fullKey = getLocalKey(user, key);
    localMemoryCache.set(fullKey, val);
    try { if (typeof localStorage !== "undefined") localStorage.setItem(fullKey, String(val)); } catch (e) {}
  }
  function loadFromLocal(user, key, fallback = "") {
    const fullKey = getLocalKey(user, key);
    if (localMemoryCache.has(fullKey)) return localMemoryCache.get(fullKey);
    try {
      if (typeof localStorage !== "undefined") {
        const val = localStorage.getItem(fullKey);
        if (val !== null) { localMemoryCache.set(fullKey, val); return val; }
      }
    } catch (e) {}
    return fallback;
  }

  function getLang() {
    let lang = "";
    if (Scratch.translate && Scratch.translate.language) lang = Scratch.translate.language;
    else if (typeof navigator !== "undefined" && navigator.language) lang = navigator.language;
    return (lang || "").toLowerCase().startsWith("vi") ? "vi" : "en";
  }

  function msg(en, vi) {
    return getLang() === "vi" ? (vi || en) : en;
  }

  function isJsonString(str) {
    try { JSON.parse(str); return true; } catch (e) { return false; }
  }

  function getList(util, listName) {
    if (!util || !util.target) return null;
    const stage = util.target.runtime.getTargetForStage();
    let variable = util.target.lookupVariableByNameAndType(listName, 'list');
    if (!variable && stage) variable = stage.lookupVariableByNameAndType(listName, 'list');
    return variable;
  }

  const BLOCK_META = {
    setCloudVarAndWait: { title: { vi: "Đặt biến Cloud", en: "Set Cloud Var" }, type: "COMMAND", desc: { vi: "Lưu một biến Cloud độc lập theo khóa. Tại Editor chỉ lưu cache tạm.", en: "Saves an independent Cloud variable by key. In Editor, saves to local cache only." }, output: null },
    loadCloudVarAndWait: { title: { vi: "Tải biến Cloud", en: "Load Cloud Var" }, type: "COMMAND", desc: { vi: "Tải giá trị của một biến Cloud độc lập theo khóa.", en: "Downloads an independent Cloud variable by key." }, output: { vi: "Nạp vào bộ đệm biến", en: "Populates variable cache" } },
    getCloudVar: { title: { vi: "Giá trị biến Cloud", en: "Cloud Var Value" }, type: "REPORTER", desc: { vi: "Đọc tức thì giá trị biến Cloud từ bộ đệm.", en: "Returns the cached cloud variable value instantly." }, output: null },
    setServerUrl: { title: { vi: "Cấu hình máy chủ", en: "Set Server URL" }, type: "COMMAND", desc: { vi: "Thiết lập địa chỉ máy chủ API.", en: "Sets the backend API server URL." }, output: null },
    pingServer: { title: { vi: "Kiểm tra kết nối", en: "Ping Server" }, type: "COMMAND", desc: { vi: "Gửi gói tin ping kiểm tra máy chủ.", en: "Sends a ping packet to test server." }, output: { vi: "Cập nhật vào 'trạng thái máy chủ'", en: "Updates 'server status' reporter" } },
    getStatus: { title: { vi: "Trạng thái máy chủ", en: "Server Status" }, type: "REPORTER", desc: { vi: "Lấy tình trạng kết nối gần nhất.", en: "Returns the latest connection status." }, output: { vi: "ONLINE, OFFLINE, SAVING, v.v.", en: "ONLINE, OFFLINE, SAVING, etc." } },
    setCachePolicy: { title: { vi: "Cài đặt Cache", en: "Set Cache Policy" }, type: "COMMAND", desc: { vi: "Giới hạn thời gian giữa các lần gọi mạng để tránh bị spam.", en: "Sets cooldown time between network requests to prevent spam." }, output: null },
    saveDataAndWait: { title: { vi: "Lưu dữ liệu", en: "Save Cloud Data" }, type: "COMMAND", cooldown: "Tùy Cache Policy", desc: { vi: "Lưu điểm và chuỗi dữ liệu JSON.", en: "Saves score and custom JSON data." }, output: null },
    loadDataAndWait: { title: { vi: "Tải 1 tài khoản", en: "Load 1 Account" }, type: "COMMAND", cooldown: "Tùy Cache Policy", desc: { vi: "Tải dữ liệu của tài khoản.", en: "Downloads user score & data." }, output: { vi: "Nạp vào biến dữ liệu tạm", en: "Populates cache variables" } },
    loadBatchAndWait: { title: { vi: "Đọc theo đợt", en: "Read in Batches" }, type: "COMMAND", cooldown: "Tùy Cache Policy", desc: { vi: "Tải nhiều tài khoản cùng lúc từ mảng JSON (tối đa 50).", en: "Downloads multiple users data at once from a JSON array." }, output: { vi: "Nạp vào 'Dữ liệu Batch'", en: "Populates 'Batch Data'" } },
    getLoadedScore: { title: { vi: "Điểm vừa tải", en: "Loaded Score" }, type: "REPORTER", desc: { vi: "Lấy số điểm của tài khoản từ lần tải gần nhất.", en: "Retrieves player score." }, output: null },
    getLoadedData: { title: { vi: "Dữ liệu vừa tải", en: "Loaded Data" }, type: "REPORTER", desc: { vi: "Chuỗi dữ liệu của tài khoản.", en: "Retrieves raw JSON data." }, output: null },
    getBatchData: { title: { vi: "Dữ liệu theo đợt", en: "Batch Data" }, type: "REPORTER", desc: { vi: "Chuỗi JSON chứa nhiều người chơi từ lệnh đọc theo đợt.", en: "JSON string containing multiple players." }, output: null },
    jsonIsValid: { title: { vi: "Kiểm tra loại JSON", en: "Is Valid JSON" }, type: "BOOLEAN", desc: { vi: "Kiểm tra chuỗi có phải là Object {} hoặc Array [] hợp lệ không.", en: "Checks if string is valid Object or Array." }, output: {vi:"Đúng/Sai", en:"True/False"} },
    jsonGetValue: { title: { vi: "Lấy giá trị JSON", en: "Get JSON Value" }, type: "REPORTER", desc: { vi: "Trích xuất giá trị.", en: "Extracts value." }, output: null },
    jsonSetValue: { title: { vi: "Gán giá trị JSON", en: "Set JSON Value" }, type: "REPORTER", desc: { vi: "Thay đổi giá trị trong JSON.", en: "Updates value inside JSON." }, output: null },
    jsonParseList: { title: { vi: "Danh sách thành JSON", en: "List to JSON Array" }, type: "REPORTER", desc: { vi: "Chuyển một List trong Scratch thành một chuỗi mảng JSON [].", en: "Converts Scratch List to JSON Array." }, output: { vi:"Chuỗi mảng JSON", en:"JSON Array String"} },
    jsonReplaceList: { title: { vi: "Thay thế List bằng JSON", en: "Replace List with JSON" }, type: "COMMAND", desc: { vi: "Xóa List và đổ dữ liệu từ Mảng JSON vào List.", en: "Clears List and pushes items from JSON Array." }, output: null }
  };

  function setupTurboWarpTooltip() {
      if (typeof document === "undefined") return;
      let tooltip = document.getElementById("danv-tw-tooltip");
      if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.id = "danv-tw-tooltip";
        Object.assign(tooltip.style, {
          position: "fixed", display: "none", backgroundColor: "rgba(22, 24, 33, 0.94)",
          color: "#ffffff", padding: "12px 14px", borderRadius: "10px", fontSize: "12px",
          fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif', pointerEvents: "none",
          zIndex: "9999999", boxShadow: "0 14px 35px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)",
          border: "1px solid rgba(255, 255, 255, 0.12)", backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)", maxWidth: "285px", lineHeight: "1.45",
          opacity: "0", transform: "translateY(5px)", transition: "opacity 0.2s, transform 0.2s",
          boxSizing: "border-box"
        });
        document.body.appendChild(tooltip);
      }
      let hoverTimer = null; let currentBlockId = null; let isShowing = false;
      function renderTooltipContent(opcode) {
        const meta = BLOCK_META[opcode]; if (!meta) return;
        const lang = getLang(); const title = meta.title[lang] || meta.title.en;
        const desc = meta.desc[lang] || meta.desc.en; const isReporter = (meta.type === "REPORTER" || meta.type === "BOOLEAN");
        const typeLabel = isReporter ? (lang === "vi" ? "BÁO CÁO" : "REPORTER") : (lang === "vi" ? "LỆNH" : "COMMAND");
        const badgeStyle = isReporter ? "background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.35);" : "background: rgba(99, 102, 241, 0.15); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.35);";
        let metaBoxHtml = "";
        if (meta.output || meta.cooldown) {
          metaBoxHtml = `<div style="margin-top: 8px; padding: 7px 9px; border-radius: 6px; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.06); display: flex; flex-direction: column; gap: 4px; font-size: 11px;">
            ${meta.output ? `<div style="display: flex; gap: 6px; align-items: baseline;"><span style="color: #34d399; font-weight: 700; flex-shrink: 0;">⚡ Output:</span><span style="color: #cbd5e1;">${meta.output[lang] || meta.output.en}</span></div>` : ""}
            ${meta.cooldown ? `<div style="display: flex; gap: 6px; align-items: baseline;"><span style="color: #fbbf24; font-weight: 700; flex-shrink: 0;">⏱ Hồi chiêu:</span><span style="color: #cbd5e1;">${meta.cooldown}</span></div>` : ""}
          </div>`;
        }
        tooltip.innerHTML = `<div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px;"><div style="display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 13px;"><span style="display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #00A877; box-shadow: 0 0 8px #00a877;"></span>${title}</div><span style="font-size: 9.5px; font-weight: 700; padding: 2px 6px; border-radius: 999px; ${badgeStyle}">${typeLabel}</span></div><div style="font-size: 11.5px; color: #94a3b8;">${desc}</div>${metaBoxHtml}`;
      }
      function positionTooltip(x, y) {
        const pad = 14; const width = tooltip.offsetWidth || 285; const height = tooltip.offsetHeight || 130;
        let left = x + pad; let top = y + pad;
        if (left + width > window.innerWidth - 12) left = x - width - pad;
        if (top + height > window.innerHeight - 12) top = y - height - pad;
        tooltip.style.left = `${Math.max(10, left)}px`; tooltip.style.top = `${Math.max(10, top)}px`;
      }
      function hideTooltip() {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        currentBlockId = null;
        if (isShowing) {
          tooltip.style.opacity = "0"; tooltip.style.transform = "translateY(5px)"; isShowing = false;
          setTimeout(() => { if (!isShowing) tooltip.style.display = "none"; }, 200);
        }
      }
      document.addEventListener("mousemove", (e) => {
        const blockEl = e.target.closest && e.target.closest(".blocklyDraggable");
        if (!blockEl) { hideTooltip(); return; }
        const id = blockEl.getAttribute("data-id"); const sb = window.ScratchBlocks || window.Blockly;
        let opcode = null;
        if (sb && sb.getMainWorkspace) {
          const ws = sb.getMainWorkspace();
          const block = (ws && ws.getBlockById(id)) || (ws && ws.getFlyout && ws.getFlyout() && ws.getFlyout().getWorkspace() && ws.getFlyout().getWorkspace().getBlockById(id));
          if (block && block.type && block.type.startsWith("danvCloudDB_")) opcode = block.type.replace("danvCloudDB_", "");
        }
        if (!opcode || !BLOCK_META[opcode]) { hideTooltip(); return; }
        if (isShowing && currentBlockId === id) { positionTooltip(e.clientX, e.clientY); return; }
        if (currentBlockId !== id) {
          if (hoverTimer) clearTimeout(hoverTimer); currentBlockId = id;
          hoverTimer = setTimeout(() => {
            renderTooltipContent(opcode); tooltip.style.display = "block"; positionTooltip(e.clientX, e.clientY);
            requestAnimationFrame(() => { tooltip.style.opacity = "1"; tooltip.style.transform = "translateY(0)"; isShowing = true; });
          }, HOVER_DELAY);
        }
      });
      document.addEventListener("mouseleave", hideTooltip);
  }
  setupTurboWarpTooltip();

  class DANVCloudDBExtension {
    getInfo() {
      return {
        id: "danvCloudDB",
        name: msg("DANV Cloud DB", "DANV Cloud DB"),
        color1: "#00684A", color2: "#004B36", color3: "#001E2B",
        blockIconURI: DB_ICON_URL, menuIconURI: DB_ICON_URL,
        blocks: [
          {
            opcode: "openWowPolicy",
            blockType: Scratch.BlockType.BUTTON,
            text: msg("WOW Policy", "Chính sách về WOW")
          },
          {
            opcode: "openDanvHome",
            blockType: Scratch.BlockType.BUTTON,
            text: msg("DANVworkshop Homepage", "Trang chủ DANVworkshop")
          },
          "---",
          {
            opcode: "setServerUrl", blockType: Scratch.BlockType.COMMAND,
            text: msg("set server url [URL]", "cấu hình máy chủ [URL]"),
            arguments: { URL: { type: Scratch.ArgumentType.STRING, defaultValue: DEFAULT_SERVER } }
          },
          { opcode: "pingServer", blockType: Scratch.BlockType.COMMAND, text: msg("ping server and wait", "kiểm tra kết nối và chờ") },
          { opcode: "getStatus", blockType: Scratch.BlockType.REPORTER, text: msg("server status", "trạng thái máy chủ") },
          {
            opcode: "setCachePolicy", blockType: Scratch.BlockType.COMMAND,
            text: msg("set cache policy to [TIME] seconds", "đặt bộ nhớ đệm chống spam [TIME] giây"),
            arguments: { TIME: { type: Scratch.ArgumentType.NUMBER, defaultValue: 2 } }
          },
          "---",
          {
            opcode: "setCloudVarAndWait", blockType: Scratch.BlockType.COMMAND,
            text: msg("☁ set cloud var [KEY] = [VAL] for user [USER] and wait", "☁ đặt biến cloud [KEY] = [VAL] cho tài khoản [USER] và chờ"),
            arguments: {
              KEY: { type: Scratch.ArgumentType.STRING, defaultValue: "coins" },
              VAL: { type: Scratch.ArgumentType.STRING, defaultValue: "100" },
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: "Player1" }
            }
          },
          {
            opcode: "loadCloudVarAndWait", blockType: Scratch.BlockType.COMMAND,
            text: msg("☁ load cloud var [KEY] for user [USER] and wait", "☁ tải biến cloud [KEY] của tài khoản [USER] và chờ"),
            arguments: {
              KEY: { type: Scratch.ArgumentType.STRING, defaultValue: "coins" },
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: "Player1" }
            }
          },
          {
            opcode: "getCloudVar", blockType: Scratch.BlockType.REPORTER,
            text: msg("☁ cloud var [KEY]", "☁ giá trị biến cloud [KEY]"),
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: "coins" } }
          },
          "---",
          {
            opcode: "saveDataAndWait", blockType: Scratch.BlockType.COMMAND,
            text: msg("☁ save: user [USER] | score [SCORE] | data [DATA] and wait", "☁ lưu dữ liệu: tài khoản [USER] | điểm [SCORE] | dữ liệu [DATA] và chờ"),
            arguments: {
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: "Player1" },
              SCORE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 },
              DATA: { type: Scratch.ArgumentType.STRING, defaultValue: '{"level":1}' }
            }
          },
          {
            opcode: "loadDataAndWait", blockType: Scratch.BlockType.COMMAND,
            text: msg("☁ load data for user [USER] and wait", "☁ tải dữ liệu của tài khoản [USER] và chờ"),
            arguments: { USER: { type: Scratch.ArgumentType.STRING, defaultValue: "Player1" } }
          },
          { opcode: "getLoadedScore", blockType: Scratch.BlockType.REPORTER, text: msg("☁ loaded score", "☁ điểm vừa tải") },
          { opcode: "getLoadedData", blockType: Scratch.BlockType.REPORTER, text: msg("☁ loaded data", "☁ dữ liệu vừa tải") },
          {
            opcode: "loadBatchAndWait", blockType: Scratch.BlockType.COMMAND,
            text: msg("📦 read in batches - keys in array [ARRAY] and wait", "📦 đọc theo đợt - các khóa trong mảng JSON [ARRAY] và chờ"),
            arguments: { ARRAY: { type: Scratch.ArgumentType.STRING, defaultValue: '["Player1", "Player2"]' } }
          },
          { opcode: "getBatchData", blockType: Scratch.BlockType.REPORTER, text: msg("📦 batch data (JSON)", "📦 dữ liệu đợt vừa tải (JSON)") },
          "---",
          {
            opcode: "jsonIsValid", blockType: Scratch.BlockType.BOOLEAN,
            text: msg("[JSON] is a valid [TYPE]", "[JSON] là một [TYPE] hợp lệ"),
            arguments: {
              JSON: { type: Scratch.ArgumentType.STRING, defaultValue: '{"a": 1}' },
              TYPE: { type: Scratch.ArgumentType.STRING, menu: "jsonTypes" }
            }
          },
          {
            opcode: "jsonGetValue", blockType: Scratch.BlockType.REPORTER,
            text: msg("get value of [KEY] in [JSON]", "lấy giá trị của [KEY] trong [JSON]"),
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: "level" }, JSON: { type: Scratch.ArgumentType.STRING, defaultValue: '{"level":1}' } }
          },
          {
            opcode: "jsonSetValue", blockType: Scratch.BlockType.REPORTER,
            text: msg("set value [VAL] of key [KEY] in [JSON]", "đặt giá trị [VAL] cho khóa [KEY] trong [JSON]"),
            arguments: { VAL: { type: Scratch.ArgumentType.STRING, defaultValue: "2" }, KEY: { type: Scratch.ArgumentType.STRING, defaultValue: "level" }, JSON: { type: Scratch.ArgumentType.STRING, defaultValue: '{"level":1}' } }
          },
          {
            opcode: "jsonReplaceList", blockType: Scratch.BlockType.COMMAND,
            text: msg("replace List [LIST] with JSON Array [ARRAY]", "thay thế Danh Sách [LIST] bằng Mảng JSON [ARRAY]"),
            arguments: {
              LIST: { type: Scratch.ArgumentType.STRING, menu: "projectLists" },
              ARRAY: { type: Scratch.ArgumentType.STRING, defaultValue: '[1, 2, 3]' }
            }
          },
          {
            opcode: "jsonParseList", blockType: Scratch.BlockType.REPORTER,
            text: msg("parse List [LIST] to JSON array", "chuyển Danh Sách [LIST] thành Mảng JSON"),
            arguments: { LIST: { type: Scratch.ArgumentType.STRING, menu: "projectLists" } }
          }
        ],
        menus: {
          jsonTypes: {
            acceptReporters: true,
            items: [
              { text: "object or array", value: "any" },
              { text: "object {}", value: "object" },
              { text: "array []", value: "array" }
            ]
          },
          projectLists: {
            acceptReporters: true,
            items: 'getProjectLists'
          }
        }
      };
    }

    openWowPolicy() {
      window.open("https://studiodanv.blogspot.com/2026/09/CloudDB.html", "_blank");
    }

    openDanvHome() {
      window.open("https://turbows.pages.dev/", "_blank");
    }

    setServerUrl(args) {
      currentServerUrl = String(args.URL).trim();
      if (currentServerUrl.endsWith("/")) currentServerUrl = currentServerUrl.slice(0, -1);
    }

    setCachePolicy(args) {
      let sec = Number(args.TIME) || 0;
      if (sec < 0) sec = 0;
      cacheCooldownMs = sec * 1000;
    }

    async pingServer() {
      if (!isEmbeddedMode) {
        dbStatus = "EDITOR_LOCAL_CACHE";
        return;
      }
      dbStatus = "PINGING";
      try {
        const res = await fetchWithTimeout(`${currentServerUrl}/ping`);
        dbStatus = res.ok ? "ONLINE" : "ERROR";
      } catch (e) {
        dbStatus = e.name === "AbortError" ? "TIMEOUT" : "OFFLINE";
      }
    }
    getStatus() { return dbStatus; }

    async setCloudVarAndWait(args) {
      const user = String(args.USER || defaultUsername);
      const key = String(args.KEY).trim();
      const val = String(args.VAL);
      localCloudVars.set(key, val);

      if (!isEmbeddedMode) {
        saveToLocal(user, key, val);
        dbStatus = "EDITOR_LOCAL_CACHE";
        return;
      }

      const now = Date.now();
      if (now - lastRequestTime < cacheCooldownMs) { dbStatus = "RATE_LIMITED"; return; }
      lastRequestTime = now; dbStatus = "SAVING_VAR";
      try {
        const res = await fetchWithTimeout(`${currentServerUrl}/api/var/set`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: currentProjectId, username: user, key, value: val })
        });
        const json = await res.json();
        dbStatus = json.success ? "SAVE_VAR_SUCCESS" : "SAVE_VAR_FAILED";
      } catch (e) {
        dbStatus = e.name === "AbortError" ? "TIMEOUT" : "OFFLINE";
      }
    }

    async loadCloudVarAndWait(args) {
      const user = String(args.USER || defaultUsername);
      const key = String(args.KEY).trim();

      if (!isEmbeddedMode) {
        const cachedVal = loadFromLocal(user, key, "");
        localCloudVars.set(key, cachedVal);
        dbStatus = "EDITOR_LOCAL_CACHE";
        return;
      }

      const now = Date.now();
      if (now - lastRequestTime < cacheCooldownMs) { dbStatus = "RATE_LIMITED"; return; }
      lastRequestTime = now; dbStatus = "LOADING_VAR";
      try {
        const res = await fetchWithTimeout(`${currentServerUrl}/api/var/get`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: currentProjectId, username: user, key })
        });
        const json = await res.json();
        if (json.success && json.value !== undefined) {
          localCloudVars.set(key, String(json.value));
          dbStatus = "LOAD_VAR_SUCCESS";
        } else {
          localCloudVars.set(key, "");
          dbStatus = "NOT_FOUND";
        }
      } catch (e) {
        dbStatus = e.name === "AbortError" ? "TIMEOUT" : "OFFLINE";
      }
    }

    getCloudVar(args) {
      const key = String(args.KEY).trim();
      return localCloudVars.has(key) ? localCloudVars.get(key) : "";
    }

    async saveDataAndWait(args) {
      const user = String(args.USER || defaultUsername);
      const score = Number(args.SCORE) || 0;
      const dataStr = String(args.DATA);

      if (!isEmbeddedMode) {
        saveToLocal(user, "score", score);
        saveToLocal(user, "data", dataStr);
        dbStatus = "EDITOR_LOCAL_CACHE";
        return;
      }

      const now = Date.now();
      if (now - lastRequestTime < cacheCooldownMs) { dbStatus = "RATE_LIMITED"; return; }
      lastRequestTime = now; dbStatus = "SAVING";
      try {
        const res = await fetchWithTimeout(`${currentServerUrl}/api/save`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: currentProjectId, username: user, score, saveData: dataStr })
        });
        const json = await res.json();
        dbStatus = json.success ? "SAVE_SUCCESS" : "SAVE_FAILED";
      } catch (e) {
        dbStatus = e.name === "AbortError" ? "TIMEOUT" : "OFFLINE";
      }
    }

    async loadDataAndWait(args) {
      const user = String(args.USER || defaultUsername);

      if (!isEmbeddedMode) {
        currentLoadedScore = Number(loadFromLocal(user, "score", 0)) || 0;
        currentLoadedData = loadFromLocal(user, "data", "{}");
        dbStatus = "EDITOR_LOCAL_CACHE";
        return;
      }

      const now = Date.now();
      if (now - lastRequestTime < cacheCooldownMs) { dbStatus = "RATE_LIMITED"; return; }
      lastRequestTime = now; dbStatus = "LOADING";
      try {
        const res = await fetchWithTimeout(`${currentServerUrl}/api/load/${encodeURIComponent(currentProjectId)}/${encodeURIComponent(user)}`);
        const json = await res.json();
        if (json.success && json.data) {
          currentLoadedScore = json.data.score || 0;
          currentLoadedData = json.data.saveData || "{}";
          dbStatus = "LOAD_SUCCESS";
        } else {
          currentLoadedScore = 0; currentLoadedData = "{}"; dbStatus = "NOT_FOUND";
        }
      } catch (e) {
        currentLoadedScore = 0; currentLoadedData = "{}";
        dbStatus = e.name === "AbortError" ? "TIMEOUT" : "OFFLINE";
      }
    }

    async loadBatchAndWait(args) {
      let keysArray = [];
      try {
        keysArray = JSON.parse(args.ARRAY);
        if (!Array.isArray(keysArray)) throw new Error("Not Array");
        if (keysArray.length > 50) keysArray = keysArray.slice(0, 50);
      } catch (e) {
        dbStatus = "INVALID_BATCH_ARRAY"; return;
      }

      if (!isEmbeddedMode) {
        const result = {};
        keysArray.forEach(u => {
          result[u] = {
            score: Number(loadFromLocal(u, "score", 0)) || 0,
            saveData: loadFromLocal(u, "data", "{}")
          };
        });
        currentBatchData = JSON.stringify(result);
        dbStatus = "EDITOR_LOCAL_CACHE";
        return;
      }

      const now = Date.now();
      if (now - lastRequestTime < cacheCooldownMs) { dbStatus = "RATE_LIMITED"; return; }
      lastRequestTime = now; dbStatus = "LOADING_BATCH";
      try {
        const res = await fetchWithTimeout(`${currentServerUrl}/api/load-batch`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: currentProjectId, usernames: keysArray })
        });
        const json = await res.json();
        if (json.success) {
          currentBatchData = JSON.stringify(json.data);
          dbStatus = "LOAD_BATCH_SUCCESS";
        } else {
          currentBatchData = "{}"; dbStatus = "BATCH_FAILED";
        }
      } catch (e) {
        currentBatchData = "{}";
        dbStatus = e.name === "AbortError" ? "TIMEOUT" : "OFFLINE";
      }
    }

    getLoadedScore() { return currentLoadedScore; }
    getLoadedData() { return currentLoadedData; }
    getBatchData() { return currentBatchData; }

    getProjectLists() {
      if (!Scratch || !Scratch.vm || !Scratch.vm.runtime) return [""];
      const lists = new Set();
      const targets = Scratch.vm.runtime.targets;
      if (targets) {
        for (const target of targets) {
          if (target.variables) {
            for (const varId in target.variables) {
              const variable = target.variables[varId];
              if (variable.type === 'list') {
                lists.add(variable.name);
              }
            }
          }
        }
      }
      const listArr = Array.from(lists);
      return listArr.length > 0 ? listArr : [""];
    }

    jsonIsValid(args) {
      try {
        const parsed = JSON.parse(args.JSON);
        if (args.TYPE === 'object') return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        if (args.TYPE === 'array') return Array.isArray(parsed);
        return parsed !== null && typeof parsed === 'object';
      } catch (e) { return false; }
    }

    jsonGetValue(args) {
      if (!isJsonString(args.JSON)) return "";
      try { const obj = JSON.parse(args.JSON); return obj[args.KEY] !== undefined ? obj[args.KEY] : ""; } 
      catch (e) { return ""; }
    }

    jsonSetValue(args) {
      let obj = {};
      if (isJsonString(args.JSON)) { try { obj = JSON.parse(args.JSON); } catch (e) {} }
      let val = args.VAL;
      if (!isNaN(val) && val.toString().trim() !== "") val = Number(val);
      else if (val === "true") val = true; else if (val === "false") val = false;
      else if (isJsonString(val)) val = JSON.parse(val);
      obj[args.KEY] = val;
      return JSON.stringify(obj);
    }

    jsonReplaceList(args, util) {
      const listVariable = getList(util, args.LIST);
      if (!listVariable) return;
      try {
        const parsedArray = JSON.parse(args.ARRAY);
        if (Array.isArray(parsedArray)) {
          listVariable.value = parsedArray;
        }
      } catch (e) {}
    }

    jsonParseList(args, util) {
      const listVariable = getList(util, args.LIST);
      if (!listVariable) return "[]";
      const arr = listVariable.value.map(item => {
        if (!isNaN(item) && item.toString().trim() !== "") return Number(item);
        if (item === "true") return true;
        if (item === "false") return false;
        return item;
      });
      return JSON.stringify(arr);
    }
  }

  Scratch.extensions.register(new DANVCloudDBExtension());
})(Scratch);