(function (Scratch) {
  "use strict";

  const DB_ICON_URL = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTIxIDEyYzAgMS42Ni00IDMtOSAzcy05LTEuMzQtOS0zIi8+PHBhdGggZD0iTTMgNXY3YzAgMS42NiA0IDMgOSAzczktMS4zNCA5LTMiLz48cGF0aCBkPSJNMjEgNWMwIDEuNjYtNCAzLTkgM3MtOS0xLjM0LTktMyA0LTMgOS0zIDkgMS4zNCA5IDNaIi8+PC9zdmc+";

  const DEFAULT_SERVER = "https://aftercode-cloud-engine.onrender.com";
  const COOLDOWN_MS = 2000;

  let currentServerUrl = DEFAULT_SERVER;
  let lastRequestTime = 0;
  
  let currentLoadedScore = 0;
  let currentLoadedData = "{}";
  let dbStatus = "IDLE";

  if (Scratch.translate && Scratch.translate.setup) {
    Scratch.translate.setup({
      vi: {
        "db.name": "DANV Cloud DB",
        "db.setServer": "cấu hình máy chủ [URL]",
        "db.ping": "kiểm tra kết nối máy chủ và chờ",
        "db.getStatus": "trạng thái máy chủ",
        "db.save": "☁ lưu dữ liệu: tài khoản [USER] | điểm [SCORE] | dữ liệu [DATA] và chờ",
        "db.load": "☁ tải dữ liệu của tài khoản [USER] và chờ",
        "db.getScore": "☁ điểm vừa tải",
        "db.getData": "☁ dữ liệu vừa tải",
        "db.jsonGet": "lấy giá trị của khóa [KEY] trong [JSON]",
        "db.jsonSet": "đặt giá trị [VAL] cho khóa [KEY] trong [JSON]",
        "db.jsonParse": "chuyển [TEXT] thành JSON hợp lệ",
      }
    });
  }

  function msg(id, en, vi) {
    const lang = ((Scratch.translate && Scratch.translate.language) || navigator.language || "").toLowerCase();
    if (lang.startsWith("vi") && vi) return vi;
    return Scratch.translate ? Scratch.translate(id) : en;
  }

  function isJsonString(str) {
    try {
      JSON.parse(str);
      return true;
    } catch (e) {
      return false;
    }
  }

  class DANVCloudDBExtension {
    getInfo() {
      return {
        id: "danvCloudDB",
        name: msg("db.name", "DANV Cloud DB", "DANV Cloud DB"),
        color1: "#00684A",
        color2: "#004B36",
        color3: "#001E2B",
        blockIconURI: DB_ICON_URL,
        menuIconURI: DB_ICON_URL,
        blocks: [
          {
            opcode: "setServerUrl",
            blockType: Scratch.BlockType.COMMAND,
            text: msg("db.setServer", "set server url [URL]", "cấu hình máy chủ [URL]"),
            arguments: {
              URL: { type: Scratch.ArgumentType.STRING, defaultValue: DEFAULT_SERVER }
            }
          },
          {
            opcode: "pingServer",
            blockType: Scratch.BlockType.COMMAND,
            text: msg("db.ping", "ping server and wait", "kiểm tra kết nối máy chủ và chờ")
          },
          {
            opcode: "getStatus",
            blockType: Scratch.BlockType.REPORTER,
            text: msg("db.getStatus", "server status", "trạng thái máy chủ"),
            disableMonitor: false
          },
          "---",
          {
            opcode: "saveDataAndWait",
            blockType: Scratch.BlockType.COMMAND,
            text: msg("db.save", "☁ save: user [USER] | score [SCORE] | data [DATA] and wait", "☁ lưu dữ liệu: tài khoản [USER] | điểm [SCORE] | dữ liệu [DATA] và chờ"),
            arguments: {
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: "Player1" },
              SCORE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 100 },
              DATA: { type: Scratch.ArgumentType.STRING, defaultValue: '{"level":1}' }
            }
          },
          {
            opcode: "loadDataAndWait",
            blockType: Scratch.BlockType.COMMAND,
            text: msg("db.load", "☁ load data for user [USER] and wait", "☁ tải dữ liệu của tài khoản [USER] và chờ"),
            arguments: {
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: "Player1" }
            }
          },
          {
            opcode: "getLoadedScore",
            blockType: Scratch.BlockType.REPORTER,
            text: msg("db.getScore", "☁ loaded score", "☁ điểm vừa tải")
          },
          {
            opcode: "getLoadedData",
            blockType: Scratch.BlockType.REPORTER,
            text: msg("db.getData", "☁ loaded data", "☁ dữ liệu vừa tải")
          },
          "---",
          {
            opcode: "jsonGetValue",
            blockType: Scratch.BlockType.REPORTER,
            text: msg("db.jsonGet", "get value of [KEY] in [JSON]", "lấy giá trị của khóa [KEY] trong [JSON]"),
            arguments: {
              KEY: { type: Scratch.ArgumentType.STRING, defaultValue: "level" },
              JSON: { type: Scratch.ArgumentType.STRING, defaultValue: '{"level":1, "gold":50}' }
            }
          },
          {
            opcode: "jsonSetValue",
            blockType: Scratch.BlockType.REPORTER,
            text: msg("db.jsonSet", "set value [VAL] for [KEY] in [JSON]", "đặt giá trị [VAL] cho khóa [KEY] trong [JSON]"),
            arguments: {
              VAL: { type: Scratch.ArgumentType.STRING, defaultValue: "2" },
              KEY: { type: Scratch.ArgumentType.STRING, defaultValue: "level" },
              JSON: { type: Scratch.ArgumentType.STRING, defaultValue: '{"level":1, "gold":50}' }
            }
          },
          {
            opcode: "jsonParse",
            blockType: Scratch.BlockType.REPORTER,
            text: msg("db.jsonParse", "parse [TEXT] to valid JSON", "chuyển [TEXT] thành JSON hợp lệ"),
            arguments: {
              TEXT: { type: Scratch.ArgumentType.STRING, defaultValue: "level 1, gold 50" }
            }
          }
        ]
      };
    }

    setServerUrl(args) {
      currentServerUrl = String(args.URL).trim();
      if (currentServerUrl.endsWith("/")) {
        currentServerUrl = currentServerUrl.slice(0, -1);
      }
    }

    async pingServer() {
      dbStatus = "PINGING";
      try {
        const res = await fetch(`${currentServerUrl}/ping`);
        if (res.ok) dbStatus = "ONLINE";
        else dbStatus = "ERROR";
      } catch (e) {
        dbStatus = "OFFLINE";
      }
    }

    getStatus() {
      return dbStatus;
    }

    async saveDataAndWait(args) {
      const now = Date.now();
      if (now - lastRequestTime < COOLDOWN_MS) {
        dbStatus = "RATE_LIMITED";
        return;
      }
      lastRequestTime = now;
      dbStatus = "SAVING";

      try {
        const res = await fetch(`${currentServerUrl}/api/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: String(args.USER),
            score: Number(args.SCORE) || 0,
            saveData: String(args.DATA)
          })
        });
        const json = await res.json();
        dbStatus = json.success ? "SAVE_SUCCESS" : "SAVE_FAILED";
      } catch (e) {
        dbStatus = "OFFLINE";
      }
    }

    async loadDataAndWait(args) {
      const now = Date.now();
      if (now - lastRequestTime < COOLDOWN_MS) {
        dbStatus = "RATE_LIMITED";
        return;
      }
      lastRequestTime = now;
      dbStatus = "LOADING";

      try {
        const res = await fetch(`${currentServerUrl}/api/load/${encodeURIComponent(args.USER)}`);
        const json = await res.json();

        if (json.success && json.data) {
          currentLoadedScore = json.data.score || 0;
          currentLoadedData = json.data.saveData || "";
          dbStatus = "LOAD_SUCCESS";
        } else {
          currentLoadedScore = 0;
          currentLoadedData = "{}";
          dbStatus = "NOT_FOUND";
        }
      } catch (e) {
        currentLoadedScore = 0;
        currentLoadedData = "{}";
        dbStatus = "OFFLINE";
      }
    }

    getLoadedScore() {
      return currentLoadedScore;
    }

    getLoadedData() {
      return currentLoadedData;
    }

    jsonGetValue(args) {
      if (!isJsonString(args.JSON)) return "";
      try {
        const obj = JSON.parse(args.JSON);
        return obj[args.KEY] !== undefined ? obj[args.KEY] : "";
      } catch (e) {
        return "";
      }
    }

    jsonSetValue(args) {
      let obj = {};
      if (isJsonString(args.JSON)) {
        try { obj = JSON.parse(args.JSON); } catch (e) {}
      }
      
      let val = args.VAL;
      if (!isNaN(val) && val.trim() !== "") val = Number(val);
      else if (val === "true") val = true;
      else if (val === "false") val = false;
      else if (isJsonString(val)) val = JSON.parse(val);

      obj[args.KEY] = val;
      return JSON.stringify(obj);
    }

    jsonParse(args) {
      if (isJsonString(args.TEXT)) return args.TEXT;
      return JSON.stringify({ rawText: String(args.TEXT) });
    }
  }

  Scratch.extensions.register(new DANVCloudDBExtension());
})(Scratch);