/**
 * AIZEN V2 — Dashboard Server (Express + Socket.io)
 * Copyright © 2025 SHIGA
 * Features: Password auth, Live logs, Hot-reload config, Command editor
 */
"use strict";

const express    = require("express");
const http       = require("http");
const socketio   = require("socket.io");
const path       = require("path");
const fs         = require("fs-extra");
const bodyParser = require("body-parser");
const chalk      = require("chalk");
const crypto     = require("crypto");
const os         = require("os");

const ROOT         = path.join(__dirname, "../../");
const ACCOUNT_PATH = path.join(ROOT, "account.txt");
const CONFIG_PATH  = path.join(ROOT, "config.json");
const CMDS_DIR     = path.join(ROOT, "src/commands");

let _io      = null;
let _server  = null;
let _logBuf  = [];          // circular log buffer (last 500 lines)
const MAX_LOG_BUF = 500;

const stats = {
  totalMessages: 0,
  totalCommands: 0,
  activeThreads: new Set(),
  activeUsers:   new Set(),
  msgLog:        [],
};

const _threadMsgs    = new Map();
const _threadLastMsg = new Map();

function _addBotMsg(threadID, body, attachments) {
  const tid = String(threadID || "");
  if (!tid) return;
  if (!_threadMsgs.has(tid)) _threadMsgs.set(tid, []);
  const msgs = _threadMsgs.get(tid);
  const botID = String(global.GoatBot?.botID || "bot");
  const msgObj = {
    messageID: null,
    body: body || "",
    senderID: botID,
    senderName: global.GoatBot?.config?.botName || "AIZEN",
    ts: Date.now(),
    attachments: attachments || [],
    isFromBot: true,
  };
  msgs.push(msgObj);
  if (msgs.length > 300) msgs.shift();
  _threadLastMsg.set(tid, { body: body || "", ts: Date.now(), senderID: botID, isFromBot: true });
  if (_io) _io.emit("messenger-msg", { ...msgObj, tid });
}
global._addBotMsg = _addBotMsg;

// ── Token store (simple, in-memory) ──────────────────────────────────────────
const _tokens = new Map();   // token → expiry
function genToken() {
  const tok = crypto.randomBytes(24).toString("hex");
  _tokens.set(tok, Date.now() + 8 * 3600 * 1000);  // 8 hours
  return tok;
}
function validToken(tok) {
  const exp = _tokens.get(tok);
  if (!exp) return false;
  if (Date.now() > exp) { _tokens.delete(tok); return false; }
  return true;
}
function getDashPwd() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return cfg.dashboard?.password || "david2025";
  } catch (_) { return "david2025"; }
}

// ── Live log interceptor ──────────────────────────────────────────────────────
function interceptLogs() {
  const origWrite = process.stdout.write.bind(process.stdout);
  const errWrite  = process.stderr.write.bind(process.stderr);
  const push = (data) => {
    const line = String(data).replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!line) return;
    if (_logBuf.length >= MAX_LOG_BUF) _logBuf.shift();
    _logBuf.push({ ts: Date.now(), line });
    if (_io) _io.emit("log-line", { ts: Date.now(), line });
  };
  process.stdout.write = function(chunk, ...args) { push(chunk); return origWrite(chunk, ...args); };
  process.stderr.write = function(chunk, ...args) { push(chunk); return errWrite(chunk, ...args); };
}

function getIO()  { return _io; }

function _bufferMsg(event) {
  stats.totalMessages++;
  const tid = event.threadID ? String(event.threadID) : null;
  if (tid) stats.activeThreads.add(tid);
  if (event.senderID) stats.activeUsers.add(String(event.senderID));
  if (stats.msgLog.length >= 60) stats.msgLog.shift();
  stats.msgLog.push({ body: (event.body || "").slice(0, 100), ts: Date.now(), tid: event.threadID, sid: event.senderID });

  if (tid && (event.body || (event.attachments && event.attachments.length))) {
    if (!_threadMsgs.has(tid)) _threadMsgs.set(tid, []);
    const msgs = _threadMsgs.get(tid);
    const msgObj = {
      messageID: event.messageID || null,
      body: event.body || "",
      senderID: String(event.senderID || ""),
      senderName: event.senderName || "",
      ts: Date.now(),
      attachments: (event.attachments || []).map(a => ({ type: a.type, url: a.url, filename: a.filename })),
      isFromBot: false,
    };
    msgs.push(msgObj);
    if (msgs.length > 300) msgs.shift();
    _threadLastMsg.set(tid, { body: event.body || "", ts: Date.now(), senderID: event.senderID, isFromBot: false });
    if (_io) _io.emit("messenger-msg", { ...msgObj, tid });
  }

  if (_io) _io.emit("stats-update", getStats());
}
function _trackMsg(tid, uid, body) {
  const px = global.GoatBot?.config?.prefix || "/";
  if (body?.trimStart().startsWith(px)) stats.totalCommands++;
}
global._bufferMsg = _bufferMsg;
global._trackMsg  = _trackMsg;

function getStats() {
  const upMs = Date.now() - (global.GoatBot?.startTime || Date.now());
  const mem  = process.memoryUsage();
  return {
    uptime:        upMs,
    totalMessages: stats.totalMessages,
    totalCommands: stats.totalCommands,
    activeThreads: stats.activeThreads.size,
    activeUsers:   stats.activeUsers.size,
    commands:      global.GoatBot?.commands?.size || 0,
    botID:         global.GoatBot?.botID  || null,
    botName:       global.GoatBot?.config?.botName || "AIZEN V2",
    memMB:         +(mem.heapUsed / 1048576).toFixed(1),
    prefix:        global.GoatBot?.config?.prefix || "/",
    protection:    20,
    online:        !!global.GoatBot?.fcaApi && !!global.GoatBot?.botID,
  };
}

// ── Auth middleware ─────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const tok = req.headers["x-david-token"] || req.query.token;
  if (tok && validToken(tok)) return next();
  res.status(401).json({ ok: false, error: "Unauthorized" });
}

// ── Dashboard server ──────────────────────────────────────────────────────────
function startDashboard(port = 5000) {
  const app   = express();
  _server     = http.createServer(app);
  _io         = socketio(_server, { cors: { origin: "*" } });

  app.use(bodyParser.json({ limit: "5mb" }));
  app.use(bodyParser.urlencoded({ extended: true, limit: "5mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  // ── Health check (Railway / Render / Heroku) ─────────────────────────────────
  app.get("/health", (_, res) => res.json({ ok: true, status: "running", ts: Date.now() }));
  app.get("/ping",   (_, res) => res.send("pong"));

  // ── CORS & headers ──────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  // ── Auth ────────────────────────────────────────────────────────────────────
  app.post("/api/login", (req, res) => {
    const { password } = req.body;
    if (password === getDashPwd()) {
      const tok = genToken();
      res.json({ ok: true, token: tok });
    } else {
      res.json({ ok: false, error: "كلمة السر خاطئة" });
    }
  });
  app.post("/api/logout", auth, (req, res) => {
    const tok = req.headers["x-david-token"] || req.query.token;
    _tokens.delete(tok);
    res.json({ ok: true });
  });
  app.get("/api/auth-check", auth, (_, res) => res.json({ ok: true }));

  // ── Stats ───────────────────────────────────────────────────────────────────
  app.get("/api/stats",  auth, (_, res) => res.json(getStats()));
  app.get("/api/status", auth, (_, res) => {
    const online = !!global.GoatBot?.fcaApi && !!global.GoatBot?.botID;
    res.json({ ok: true, online, botID: global.GoatBot?.botID || null, botName: global.GoatBot?.config?.botName || "AIZEN V2" });
  });

  // ── Config ──────────────────────────────────────────────────────────────────
  app.get("/api/config", auth, (_, res) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (cfg.facebookAccount) cfg.facebookAccount.password = "";
      res.json({ ok: true, config: cfg });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post("/api/config", auth, (req, res) => {
    try {
      const old = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      const updated = Object.assign({}, old, req.body);
      global._selfWriteConfig = true;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
      setTimeout(() => { global._selfWriteConfig = false; }, 3000);
      // Hot-apply immediately
      if (global.GoatBot) global.GoatBot.config = updated;
      global.config = updated;
      global.commandPrefix = updated.prefix || "/";
      if (_io) _io.emit("config-reloaded", { ts: Date.now() });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Cookies ─────────────────────────────────────────────────────────────────
  app.post("/api/cookies", auth, (req, res) => {
    const raw = req.body?.cookies;
    if (!raw) return res.json({ ok: false, error: "لا توجد بيانات" });
    try {
      const DjamelFCA = require("../../shiga-fca");
      const parsed    = DjamelFCA.parseCookieInput(raw);
      const cookies   = parsed.cookies;
      if (!cookies.length) return res.json({ ok: false, error: "صيغة الكوكيز غير معروفة" });
      if (!DjamelFCA.hasMandatory(cookies)) return res.json({ ok: false, error: "كوكيز ناقصة (c_user أو xs مفقود)" });
      global._selfWrite = true;
      fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(cookies, null, 2));
      setTimeout(() => { global._selfWrite = false; }, 6000);
      res.json({ ok: true, count: cookies.length });
      setTimeout(() => { try { global.startBot?.(); } catch (_) {} }, 1500);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Cookie Manager — Status / Current / Refresh / Logs ──────────────────────
  app.get("/api/cookies/status", auth, (_, res) => {
    try {
      const cm = require("../../src/utils/cookieManager");
      res.json({ ok: true, ...cm.getStatus() });
    } catch(e) { res.json({ ok: false, error: e.message }); }
  });

  app.get("/api/cookies/current", auth, (_, res) => {
    try {
      const cm = require("../../src/utils/cookieManager");
      res.json({ ok: true, cookies: cm.getCurrentCookies() });
    } catch(e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/cookies/refresh", auth, async (req, res) => {
    try {
      const cm  = require("../../src/utils/cookieManager");
      const api = global.GoatBot?.fcaApi || global.api || null;
      const r   = await cm.refreshNow(api);
      res.json({ ok: r.ok, ...r });
    } catch(e) { res.json({ ok: false, error: e.message }); }
  });

  app.get("/api/cookies/logs", auth, (_, res) => {
    try {
      const cm = require("../../src/utils/cookieManager");
      res.json({ ok: true, logs: cm.getLogs() });
    } catch(e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Admins Management ────────────────────────────────────────────────────────
  app.get("/api/admins", auth, (_, res) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      res.json({
        ok: true,
        adminBot:      cfg.adminBot      || [],
        superAdminBot: cfg.superAdminBot || [],
        ownerID:       cfg.ownerID       || "",
      });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/admins", auth, (req, res) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      const { adminBot, superAdminBot, ownerID } = req.body;

      if (Array.isArray(adminBot))      cfg.adminBot      = adminBot.map(Number).filter(Boolean);
      if (Array.isArray(superAdminBot)) cfg.superAdminBot = superAdminBot.map(Number).filter(Boolean);
      if (ownerID !== undefined)        cfg.ownerID       = String(ownerID).trim();

      global._selfWriteConfig = true;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      setTimeout(() => { global._selfWriteConfig = false; }, 3000);

      if (global.GoatBot) global.GoatBot.config = cfg;
      global.config  = cfg;
      if (_io) _io.emit("config-reloaded", { ts: Date.now() });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Bot Control ──────────────────────────────────────────────────────────────
  app.post("/api/control", auth, (req, res) => {
    const { action } = req.body;
    if (action === "restart") {
      res.json({ ok: true });
      setTimeout(() => { try { global.startBot?.(); } catch (_) {} }, 400);
    } else if (action === "stop") {
      res.json({ ok: true });
      setTimeout(() => process.exit(0), 400);
    } else {
      res.json({ ok: false, error: "action غير معروف" });
    }
  });

  // ── Commands list ────────────────────────────────────────────────────────────
  app.get("/api/commands", auth, (_, res) => {
    const list = [];
    for (const [name, cmd] of (global.GoatBot?.commands || new Map())) {
      if (cmd?.config?.name?.toLowerCase() === name) {
        list.push({
          name:        cmd.config.name,
          aliases:     cmd.config.aliases || [],
          category:    cmd.config.category  || "other",
          role:        cmd.config.role       ?? 2,
          description: cmd.config.description || "",
          version:     cmd.config.version    || "1.0",
        });
      }
    }
    res.json({ ok: true, commands: list });
  });

  // ── Command source (editor) ──────────────────────────────────────────────────
  app.get("/api/commands/:name/source", auth, (req, res) => {
    const name = req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const file = path.join(CMDS_DIR, `${name}.js`);
    if (!fs.existsSync(file)) return res.json({ ok: false, error: "الأمر غير موجود" });
    try {
      const code = fs.readFileSync(file, "utf8");
      res.json({ ok: true, name, code });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/commands/:name/source", auth, (req, res) => {
    const name = req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const { code } = req.body;
    if (!code) return res.json({ ok: false, error: "الكود فارغ" });
    const file = path.join(CMDS_DIR, `${name}.js`);
    try {
      // Syntax check
      new Function(code);
    } catch (syntaxErr) {
      return res.json({ ok: false, error: "خطأ في الكود: " + syntaxErr.message });
    }
    try {
      fs.writeFileSync(file, code, "utf8");
      // Hot-reload
      const absPath = require.resolve(file);
      delete require.cache[absPath];
      const cmd = require(file);
      if (cmd?.config?.name) {
        const n = cmd.config.name.toLowerCase();
        global.GoatBot.commands.set(n, cmd);
        if (cmd.config.aliases) {
          for (const a of cmd.config.aliases) {
            if (a) global.GoatBot.commands.set(String(a).toLowerCase(), cmd);
          }
        }
        if (_io) _io.emit("command-updated", { name: n });
        res.json({ ok: true, message: `✅ تم تحديث /${n} بدون إعادة تشغيل` });
      } else {
        res.json({ ok: false, error: "config.name مفقود في الأمر" });
      }
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Thread command control ──────────────────────────────────────────────────
  app.get("/api/thread-commands", auth, (_, res) => {
    try {
      const ctrl = require("../utils/cmdControl");
      ctrl.reload();
      res.json({ ok: true, data: ctrl.getAll() });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.get("/api/thread-commands/:tid", auth, (req, res) => {
    try {
      const ctrl = require("../utils/cmdControl");
      res.json({ ok: true, config: ctrl.getThreadConfig(req.params.tid) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/thread-commands/:tid", auth, (req, res) => {
    try {
      const ctrl = require("../utils/cmdControl");
      const { mode, commands: cmds } = req.body;
      if (!["blacklist","whitelist"].includes(mode)) return res.json({ ok: false, error: "mode يجب أن يكون blacklist أو whitelist" });
      ctrl.setThreadConfig(req.params.tid, { mode, commands: Array.isArray(cmds) ? cmds : [] });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.delete("/api/thread-commands/:tid", auth, (req, res) => {
    try {
      const ctrl = require("../utils/cmdControl");
      ctrl.resetThread(req.params.tid);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Threads list (known threads from bot) ───────────────────────────────────
  app.get("/api/threads", auth, (_, res) => {
    try {
      const threads = [];
      const allData = global.GoatBot?.allThreadData || {};
      for (const [tid, data] of Object.entries(allData)) {
        threads.push({ tid, name: data?.threadName || data?.name || `غروب ${tid}`, type: data?.isGroup ? "group" : "dm" });
      }
      const ctrl = require("../utils/cmdControl");
      const ctrlTids = ctrl.getAllThreads();
      for (const tid of ctrlTids) {
        if (!threads.find(t => t.tid === tid)) threads.push({ tid, name: `غروب ${tid}`, type: "group" });
      }
      res.json({ ok: true, threads });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Command quick-update (rename / aliases / description) ───────────────────
  app.post("/api/commands/:name/update-meta", auth, (req, res) => {
    const nameParam = req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const { newName, aliases, description, role, guide } = req.body;
    const file = path.join(CMDS_DIR, `${nameParam}.js`);
    if (!fs.existsSync(file)) return res.json({ ok: false, error: "الأمر غير موجود" });
    try {
      let code = fs.readFileSync(file, "utf8");
      if (newName && newName !== nameParam) {
        code = code.replace(/name:\s*["']([^"']+)["']/, `name: "${newName}"`);
      }
      if (Array.isArray(aliases)) {
        code = code.replace(/aliases:\s*\[([^\]]*)\]/, `aliases: ${JSON.stringify(aliases)}`);
      }
      if (description) {
        code = code.replace(/description:\s*["']([^"']*)["']/, `description: "${description.replace(/"/g,'\\"')}"`);
      }
      if (role !== undefined) {
        code = code.replace(/role:\s*\d/, `role: ${parseInt(role) || 2}`);
      }
      if (guide) {
        code = code.replace(/guide:\s*\{[^}]*\}/, `guide: { en: "${guide.replace(/"/g,'\\"').replace(/\n/g,'\\n')}" }`);
      }
      fs.writeFileSync(file, code, "utf8");
      const absPath = require.resolve(file);
      delete require.cache[absPath];
      const cmd = require(file);
      const finalName = (cmd?.config?.name || nameParam).toLowerCase();
      if (global.GoatBot?.commands) {
        if (newName && newName !== nameParam) global.GoatBot.commands.delete(nameParam);
        global.GoatBot.commands.set(finalName, cmd);
        if (cmd.config.aliases) for (const a of cmd.config.aliases||[]) if (a) global.GoatBot.commands.set(String(a).toLowerCase(), cmd);
      }
      if (_io) _io.emit("command-updated", { name: finalName });
      res.json({ ok: true, name: finalName, message: `✅ تم تحديث /${finalName}` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Messages log ─────────────────────────────────────────────────────────────
  app.get("/api/messages", auth, (_, res) => {
    res.json({ ok: true, messages: [...stats.msgLog].reverse().slice(0, 30) });
  });

  // ── Live logs ────────────────────────────────────────────────────────────────
  app.get("/api/logs", auth, (_, res) => {
    res.json({ ok: true, logs: _logBuf.slice(-200) });
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  _io.on("connection", socket => {
    const tok = socket.handshake.query?.token;
    if (!validToken(tok)) { socket.disconnect(); return; }

    socket.emit("stats-update", getStats());
    socket.emit("bot-status", {
      status:  global.GoatBot?.fcaApi ? "online" : "offline",
      uid:     global.GoatBot?.botID  || null,
      botName: global.GoatBot?.config?.botName || "AIZEN V2",
    });
    // Send last 100 log lines
    socket.emit("log-history", _logBuf.slice(-100));

    socket.on("ping-bot", () => socket.emit("pong-bot", { ts: Date.now() }));
  });

  // ── Messenger: thread list ──────────────────────────────────────────────────
  app.get("/api/messenger/threads", auth, (_, res) => {
    try {
      const allData = global.GoatBot?.allThreadData || {};
      const threads = [];
      for (const [tid, data] of Object.entries(allData)) {
        const last = _threadLastMsg.get(String(tid));
        threads.push({
          tid: String(tid),
          name: data?.threadName || data?.name || `غروب ${tid}`,
          type: data?.isGroup ? "group" : "dm",
          memberCount: data?.participantIDs?.length || 0,
          lastBody: last?.body || "",
          lastTs: last?.ts || 0,
          lastIsFromBot: last?.isFromBot || false,
        });
      }
      // Also include threads we have messages for but not in allThreadData
      for (const [tid, msgs] of _threadMsgs.entries()) {
        if (!allData[tid] && msgs.length) {
          const last = _threadLastMsg.get(tid);
          threads.push({ tid, name: `غروب ${tid}`, type: "group", memberCount: 0, lastBody: last?.body || "", lastTs: last?.ts || 0 });
        }
      }
      threads.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
      res.json({ ok: true, threads });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Messenger: messages for a thread ────────────────────────────────────────
  app.get("/api/messenger/thread/:tid/messages", auth, (req, res) => {
    const tid = req.params.tid;
    const msgs = _threadMsgs.get(tid) || [];
    res.json({ ok: true, messages: msgs.slice(-100) });
  });

  // ── Messenger: thread info ──────────────────────────────────────────────────
  function _getThreadInfoHandler(req, res) {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const tid = req.params.tid;
    const fn  = api.getThreadInfo || api.getThreadInfoByID;
    if (!fn) return res.json({ ok: false, error: "getThreadInfo غير مدعوم" });
    fn.call(api, tid, (err, info) => {
      if (err) return res.json({ ok: false, error: err.message });
      res.json({ ok: true, info });
    });
  }
  app.get("/api/messenger/thread/:tid/info", auth, _getThreadInfoHandler);
  app.get("/api/messenger/thread-info/:tid",   auth, _getThreadInfoHandler);

  // ── Messenger: send file with optional caption ───────────────────────────────
  app.post("/api/messenger/send-with-caption", auth, async (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID, data, mimetype, filename, caption } = req.body;
    if (!threadID || !data) return res.json({ ok: false, error: "threadID و data مطلوبان" });
    const tmpPath = path.join(os.tmpdir(), `david-${Date.now()}-${filename || "file"}`);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(data, "base64"));
      const stream = fs.createReadStream(tmpPath);
      stream.path = filename || tmpPath;
      const msg = caption ? { body: String(caption), attachment: stream } : { attachment: stream };
      api.sendMessage(msg, String(threadID), (err, info) => {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        if (err) return res.json({ ok: false, error: err.message });
        _addBotMsg(threadID, caption || `[ملف: ${filename || "file"}]`);
        res.json({ ok: true, messageID: info?.messageID });
      });
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Messenger: send text message ─────────────────────────────────────────────
  app.post("/api/messenger/send", auth, (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID, body, silent } = req.body;
    if (!threadID || !body) return res.json({ ok: false, error: "threadID و body مطلوبان" });
    const msg = { body: String(body) };
    if (silent) msg.noNotif = true;
    api.sendMessage(msg, String(threadID), (err, info) => {
      if (err) return res.json({ ok: false, error: err.message });
      _addBotMsg(threadID, body);
      res.json({ ok: true, messageID: info?.messageID });
    });
  });

  // ── Messenger: send file (base64) ────────────────────────────────────────────
  app.post("/api/messenger/send-file", auth, async (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID, data, mimetype, filename } = req.body;
    if (!threadID || !data) return res.json({ ok: false, error: "threadID و data مطلوبان" });
    const tmpPath = path.join(os.tmpdir(), `david-${Date.now()}-${filename || "file"}`);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(data, "base64"));
      const stream = fs.createReadStream(tmpPath);
      stream.path = filename || tmpPath;
      api.sendMessage({ attachment: stream }, String(threadID), (err, info) => {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        if (err) return res.json({ ok: false, error: err.message });
        _addBotMsg(threadID, `[ملف: ${filename || "file"}]`);
        res.json({ ok: true, messageID: info?.messageID });
      });
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Messenger: set thread title ──────────────────────────────────────────────
  app.post("/api/messenger/set-title", auth, (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID, title } = req.body;
    if (!threadID || !title) return res.json({ ok: false, error: "threadID و title مطلوبان" });
    api.setTitle(String(title), String(threadID), (err) => {
      if (err) return res.json({ ok: false, error: err.message });
      const allData = global.GoatBot?.allThreadData || {};
      if (allData[threadID]) allData[threadID].threadName = title;
      res.json({ ok: true });
    });
  });

  // ── Messenger: set nickname ──────────────────────────────────────────────────
  app.post("/api/messenger/set-nick", auth, (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID, userID, nickname } = req.body;
    if (!threadID || !userID) return res.json({ ok: false, error: "threadID و userID مطلوبان" });
    api.changeNickname(String(nickname || ""), String(threadID), String(userID), (err) => {
      if (err) return res.json({ ok: false, error: err.message });
      res.json({ ok: true });
    });
  });

  // ── Messenger: change bot nickname in ALL known threads ──────────────────────
  app.post("/api/messenger/set-bot-nick-all", auth, async (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { nickname } = req.body;
    if (typeof nickname === "undefined") return res.json({ ok: false, error: "nickname مطلوب" });
    let botID;
    try { botID = api.getCurrentUserID(); } catch (_) { botID = null; }
    if (!botID) return res.json({ ok: false, error: "تعذر الحصول على ID البوت" });
    const threads = [..._threadMsgs.keys()];
    if (!threads.length) return res.json({ ok: false, error: "لا توجد غروبات مسجلة بعد" });
    let success = 0, failed = 0;
    for (const tid of threads) {
      try {
        await new Promise((resolve) => {
          api.changeNickname(String(nickname), String(tid), String(botID), (err) => {
            if (err) failed++; else success++;
            resolve();
          });
        });
        await new Promise(r => setTimeout(r, 200)); // small delay to avoid rate limit
      } catch (_) { failed++; }
    }
    res.json({ ok: true, total: threads.length, success, failed });
  });

  // ── Messenger: set thread image (base64) ─────────────────────────────────────
  app.post("/api/messenger/set-image", auth, async (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID, data, filename } = req.body;
    if (!threadID || !data) return res.json({ ok: false, error: "threadID و data مطلوبان" });
    const tmpPath = path.join(os.tmpdir(), `david-img-${Date.now()}.jpg`);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(data, "base64"));
      const stream = fs.createReadStream(tmpPath);
      const fn = api.changeGroupImage || api.setGroupImage;
      if (!fn) return res.json({ ok: false, error: "changeGroupImage غير مدعوم" });
      fn.call(api, stream, String(threadID), (err) => {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        if (err) return res.json({ ok: false, error: err.message });
        res.json({ ok: true });
      });
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Messenger: kick member ──────────────────────────────────────────────────
  app.post("/api/messenger/kick", auth, (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID, userID } = req.body;
    if (!threadID || !userID) return res.json({ ok: false, error: "threadID و userID مطلوبان" });
    api.removeUserFromGroup(String(userID), String(threadID), (err) => {
      if (err) return res.json({ ok: false, error: err.message });
      res.json({ ok: true });
    });
  });

  // ── Messenger: add member ──────────────────────────────────────────────────
  app.post("/api/messenger/add-member", auth, (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID, userID } = req.body;
    if (!threadID || !userID) return res.json({ ok: false, error: "threadID و userID مطلوبان" });
    api.addUserToGroup(String(userID), String(threadID), (err) => {
      if (err) return res.json({ ok: false, error: err.message });
      res.json({ ok: true });
    });
  });

  // ── Messenger: pending message requests ──────────────────────────────────────
  app.get("/api/messenger/requests", auth, (_, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    try {
      if (typeof api.getThreadList === "function") {
        api.getThreadList(30, null, ["PENDING"], (err, threads) => {
          if (err) return res.json({ ok: false, error: err.message });
          const reqs = (threads || []).map(t => ({
            tid:         String(t.threadID || t.id || ""),
            name:        t.name || t.threadName || `طلب ${t.threadID || ""}`,
            snippet:     t.snippet || t.lastMessage || "",
            ts:          t.timestamp || t.lastMessageTimestamp || 0,
            imageSrc:    t.imageSrc  || t.image || null,
            participantCount: (t.participantIDs || []).length
          }));
          res.json({ ok: true, requests: reqs });
        });
      } else {
        res.json({ ok: false, error: "getThreadList غير مدعوم في هذه النسخة" });
      }
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Messenger: accept pending request ────────────────────────────────────────
  app.post("/api/messenger/accept-request", auth, (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID } = req.body;
    if (!threadID) return res.json({ ok: false, error: "threadID مطلوب" });
    // قبول الطلب عبر إرسال رسالة فارغة
    api.sendMessage({ body: "" }, String(threadID), (err) => {
      if (err) {
        // محاولة بديلة
        api.sendMessage("", String(threadID), (err2) => {
          if (err2) return res.json({ ok: false, error: err2.message });
          res.json({ ok: true });
        });
        return;
      }
      res.json({ ok: true });
    });
  });

  // ── Messenger: ignore/delete pending request ─────────────────────────────────
  app.post("/api/messenger/ignore-request", auth, (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const { threadID } = req.body;
    if (!threadID) return res.json({ ok: false, error: "threadID مطلوب" });
    if (typeof api.deleteThread === "function") {
      api.deleteThread(String(threadID), (err) => {
        if (err) return res.json({ ok: false, error: err.message });
        res.json({ ok: true });
      });
    } else {
      res.json({ ok: false, error: "deleteThread غير مدعوم" });
    }
  });

  // ── File Browser ─────────────────────────────────────────────────────────────
  const ALLOWED_EXTS = new Set([".js",".json",".txt",".md",".html",".css",".env",".toml",".yml",".yaml"]);
  const SKIP_DIRS    = new Set(["node_modules",".git","android","mobile",".cache","dist","build"]);

  function buildTree(dir, maxDepth = 4, depth = 0) {
    if (depth > maxDepth) return [];
    const items = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") && depth === 0 && e.name !== ".github") continue;
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          const children = buildTree(path.join(dir, e.name), maxDepth, depth + 1);
          items.push({ name: e.name, type: "dir", path: path.relative(ROOT, path.join(dir, e.name)), children });
        } else {
          const ext = path.extname(e.name).toLowerCase();
          if (!ALLOWED_EXTS.has(ext)) continue;
          items.push({ name: e.name, type: "file", path: path.relative(ROOT, path.join(dir, e.name)), ext });
        }
      }
    } catch (_) {}
    return items.sort((a,b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  app.get("/api/files/tree", auth, (_, res) => {
    try {
      const tree = buildTree(ROOT);
      res.json({ ok: true, tree });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.get("/api/files/read", auth, (req, res) => {
    try {
      const rel = req.query.path || "";
      if (!rel || rel.includes("..")) return res.json({ ok: false, error: "مسار غير صالح" });
      const full = path.join(ROOT, rel);
      if (!full.startsWith(ROOT)) return res.json({ ok: false, error: "مسار خارج النطاق" });
      const ext = path.extname(full).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) return res.json({ ok: false, error: "نوع ملف غير مسموح" });
      if (!fs.existsSync(full)) return res.json({ ok: false, error: "الملف غير موجود" });
      const stat = fs.statSync(full);
      if (stat.size > 512 * 1024) return res.json({ ok: false, error: "الملف كبير جداً (>512KB)" });
      const content = fs.readFileSync(full, "utf8");
      res.json({ ok: true, content, path: rel, size: stat.size });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/files/write", auth, (req, res) => {
    try {
      const { path: rel, content } = req.body;
      if (!rel || rel.includes("..")) return res.json({ ok: false, error: "مسار غير صالح" });
      const full = path.join(ROOT, rel);
      if (!full.startsWith(ROOT)) return res.json({ ok: false, error: "مسار خارج النطاق" });
      const ext = path.extname(full).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) return res.json({ ok: false, error: "نوع ملف غير مسموح" });
      fs.ensureDirSync(path.dirname(full));
      fs.writeFileSync(full, content || "", "utf8");
      // Hot-reload if command file
      if (full.startsWith(CMDS_DIR) && ext === ".js") {
        try {
          const absPath = require.resolve(full);
          delete require.cache[absPath];
          const cmd = require(full);
          if (cmd?.config?.name) {
            const n = cmd.config.name.toLowerCase();
            if (global.GoatBot?.commands) {
              global.GoatBot.commands.set(n, cmd);
              if (cmd.config.aliases) for (const a of cmd.config.aliases||[]) if (a) global.GoatBot.commands.set(String(a).toLowerCase(), cmd);
            }
            if (_io) _io.emit("command-updated", { name: n });
          }
        } catch (_) {}
      }
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/files/new", auth, (req, res) => {
    try {
      const { path: rel, isDir } = req.body;
      if (!rel || rel.includes("..")) return res.json({ ok: false, error: "مسار غير صالح" });
      const full = path.join(ROOT, rel);
      if (!full.startsWith(ROOT)) return res.json({ ok: false, error: "مسار خارج النطاق" });
      if (isDir) { fs.ensureDirSync(full); }
      else { fs.ensureDirSync(path.dirname(full)); fs.writeFileSync(full, "", "utf8"); }
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.delete("/api/files/delete", auth, (req, res) => {
    try {
      const rel = req.query.path || "";
      if (!rel || rel.includes("..")) return res.json({ ok: false, error: "مسار غير صالح" });
      const full = path.join(ROOT, rel);
      if (!full.startsWith(ROOT)) return res.json({ ok: false, error: "مسار خارج النطاق" });
      if (!fs.existsSync(full)) return res.json({ ok: false, error: "الملف غير موجود" });
      fs.removeSync(full);
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── AI Multi-Provider (Anthropic → Groq → Pollinations.ai free) ──────────────

  function _getAIProvider() {
    if (process.env.ANTHROPIC_API_KEY) return "anthropic";
    if (process.env.GROQ_API_KEY) return "groq";
    return "free";
  }

  async function _callAI(systemPrompt, userMsg, history = [], maxTokens = 2000) {
    const provider = _getAIProvider();
    const msgs = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-8)) {
        if (h.role && h.content) msgs.push({ role: h.role, content: String(h.content) });
      }
    }
    msgs.push({ role: "user", content: userMsg });

    if (provider === "anthropic") {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: maxTokens,
        messages: msgs,
        system: systemPrompt,
      });
      return { text: resp.content[0]?.text || "", provider: "anthropic" };
    }

    if (provider === "groq") {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: systemPrompt }, ...msgs],
          max_tokens: maxTokens,
          temperature: 0.7
        })
      });
      if (!r.ok) throw new Error(`Groq: ${r.status} ${await r.text()}`);
      const data = await r.json();
      return { text: data.choices[0]?.message?.content || "", provider: "groq" };
    }

    // Free fallback: Pollinations.ai — no API key required
    const polBody = JSON.stringify({
      model: "openai-large",
      messages: [{ role: "system", content: systemPrompt }, ...msgs],
      stream: false,
      private: true,
      seed: Math.floor(Math.random() * 99999)
    });
    const polHeaders = { "Content-Type": "application/json" };
    let r = await fetch("https://text.pollinations.ai/", { method: "POST", headers: polHeaders, body: polBody });
    if (r.status === 429) {
      // Rate limited — wait 4 seconds and retry once
      await new Promise(res => setTimeout(res, 4000));
      r = await fetch("https://text.pollinations.ai/", { method: "POST", headers: polHeaders, body: polBody });
    }
    if (r.status === 429) throw new Error("rate_limit");
    if (!r.ok) throw new Error(`Pollinations: ${r.status}`);
    const text = await r.text();
    return { text: text.trim(), provider: "free" };
  }

  app.get("/api/ai/provider", auth, (req, res) => {
    const p = _getAIProvider();
    const names = { anthropic: "Claude (Anthropic)", groq: "Llama 3.3 (Groq Free)", free: "GPT-4o (Pollinations — مجاني بدون key)" };
    res.json({ ok: true, provider: p, name: names[p] });
  });

  app.post("/api/ai/generate", auth, async (req, res) => {
    try {
      const { description, contextFiles } = req.body;
      if (!description) return res.json({ ok: false, error: "الوصف مطلوب" });

      // قراءة ملفات السياق
      let contextContent = "";
      if (Array.isArray(contextFiles) && contextFiles.length) {
        for (const rel of contextFiles.slice(0, 5)) {
          try {
            const full = path.join(ROOT, rel);
            if (full.startsWith(ROOT) && fs.existsSync(full)) {
              const content = fs.readFileSync(full, "utf8");
              contextContent += `\n\n// === الملف: ${rel} ===\n${content.slice(0, 3000)}`;
            }
          } catch (_) {}
        }
      }

      const exampleCmd = path.join(CMDS_DIR, "uptime.js");
      let exampleContent = "";
      try { exampleContent = fs.readFileSync(exampleCmd, "utf8"); } catch (_) {}

      const systemPrompt = `أنت مطور بوت فيسبوك ماسنجر خبير بـ AIZEN V2 Engine. مهمتك كتابة أوامر Node.js للبوت.

بنية الأمر الأساسية:
\`\`\`js
"use strict";
module.exports = {
  config: {
    name: "اسم_الأمر",
    aliases: [],
    version: "1.0",
    author: "SHIGA",
    countDown: 5,
    role: 0,
    category: "fun",
    description: "وصف مختصر",
    guide: { en: "{pn} [نص]" }
  },
  onStart: async function({ api, event, args, message, prefix }) {
    // message.reply("رسالة") لإرسال ردّ
    // api.sendMessage("نص", event.threadID) لإرسال رسالة
    // message.react("✅", event.messageID) لإضافة ردّ فعل
  }
};
\`\`\`

مثال حقيقي:\n${exampleContent}\n${contextContent ? `\nسياق إضافي:${contextContent}` : ""}`;

      const result = await _callAI(
        systemPrompt,
        `اكتب أمر AIZEN V2 بالمواصفات التالية:\n\n${description}\n\nاكتب فقط كود JavaScript بدون أي شرح. ابدأ بـ "use strict";`,
        [],
        2000
      );

      let code = result.text;
      const match = code.match(/```(?:javascript|js)?\n?([\s\S]+?)```/);
      if (match) code = match[1].trim();

      res.json({ ok: true, code, provider: result.provider });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/ai/chat", auth, async (req, res) => {
    try {
      const { message: userMsg, history } = req.body;
      if (!userMsg) return res.json({ ok: false, error: "الرسالة مطلوبة" });
      const result = await _callAI(
        "أنت مساعد ذكي خبير في بوتات فيسبوك ماسنجر ونظام AIZEN V2. أجب باختصار ووضوح باللغة العربية.",
        userMsg, history || [], 1000
      );
      res.json({ ok: true, reply: result.text, provider: result.provider });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/ai/save-command", auth, (req, res) => {
    try {
      const { name, code } = req.body;
      if (!name || !code) return res.json({ ok: false, error: "name و code مطلوبان" });
      const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g,"");
      if (!safeName) return res.json({ ok: false, error: "اسم غير صالح" });
      const file = path.join(CMDS_DIR, `${safeName}.js`);
      fs.writeFileSync(file, code, "utf8");
      try {
        delete require.cache[require.resolve(file)];
        const cmd = require(file);
        if (cmd?.config?.name && global.GoatBot?.commands) {
          const n = cmd.config.name.toLowerCase();
          global.GoatBot.commands.set(n, cmd);
          if (cmd.config.aliases) for (const a of cmd.config.aliases||[]) if (a) global.GoatBot.commands.set(String(a).toLowerCase(), cmd);
          if (_io) _io.emit("command-updated", { name: n });
        }
      } catch (_) {}
      res.json({ ok: true, message: `✅ تم حفظ الأمر /${safeName}` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── GitHub API ────────────────────────────────────────────────────────────────
  app.get("/api/github/repo-info", auth, async (req, res) => {
    try {
      const { token, repo } = req.query;
      if (!repo) return res.json({ ok: false, error: "repo مطلوب" });
      const headers = { "User-Agent": "AIZEN-V2-Bot", Accept: "application/vnd.github.v3+json" };
      if (token) headers["Authorization"] = `token ${token}`;
      const r = await fetch(`https://api.github.com/repos/${repo}`, { headers });
      if (!r.ok) return res.json({ ok: false, error: `GitHub API: ${r.status} ${r.statusText}` });
      const info = await r.json();
      res.json({ ok: true, info });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── ENV vars (save AI keys to .env file) ─────────────────────────────────────
  app.post("/api/env/set", auth, (req, res) => {
    try {
      const { pairs } = req.body;
      if (!pairs || typeof pairs !== "object") return res.json({ ok: false, error: "pairs مطلوب" });
      const allowed = ["GROQ_API_KEY","ANTHROPIC_API_KEY","OPENROUTER_API_KEY"];
      const envPath = path.join(ROOT, ".env");
      let content = "";
      try { content = fs.readFileSync(envPath, "utf8"); } catch(_) {}
      const lines = content.split("\n");
      for (const [key, val] of Object.entries(pairs)) {
        if (!allowed.includes(key)) continue;
        if (!val) continue;
        // set in memory immediately
        process.env[key] = val;
        // update or add in .env file
        const idx = lines.findIndex(l => l.startsWith(key + "="));
        const line = `${key}=${val}`;
        if (idx >= 0) lines[idx] = line;
        else lines.push(line);
      }
      fs.writeFileSync(envPath, lines.filter(Boolean).join("\n") + "\n", "utf8");
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/github/push", auth, async (req, res) => {
    const log = [];
    const L = (msg, type="info") => { log.push({ msg, type }); };
    try {
      const { token, repo = "castrolmocro/divid-apk", scope = "bot", message = "🤖 AIZEN V2 - Auto Update" } = req.body;
      if (!token) return res.json({ ok: false, error: "GitHub Token مطلوب", log });
      const ghHeaders = {
        "Authorization": `token ${token}`,
        "User-Agent": "AIZEN-V2-Bot",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      };
      L("🔑 التحقق من المستخدم…", "info");
      const userRes = await fetch("https://api.github.com/user", { headers: ghHeaders });
      if (!userRes.ok) return res.json({ ok: false, error: "توكن GitHub غير صالح", log });
      const user = await userRes.json();
      L(`✅ مسجل الدخول كـ: ${user.login}`, "ok");

      L(`📡 جلب معلومات الريبو: ${repo}…`, "info");
      const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
      if (!repoRes.ok) return res.json({ ok: false, error: `الريبو غير موجود أو لا صلاحية: ${repoRes.status}`, log });
      const repoInfo = await repoRes.json();
      const defaultBranch = repoInfo.default_branch || "main";
      L(`📂 الفرع الافتراضي: ${defaultBranch}`, "info");

      const refRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${defaultBranch}`, { headers: ghHeaders });
      let latestSha = null;
      let baseTreeSha = null;
      if (refRes.ok) {
        const refData = await refRes.json();
        latestSha = refData.object?.sha;
        if (latestSha) {
          const commitRes = await fetch(`https://api.github.com/repos/${repo}/git/commits/${latestSha}`, { headers: ghHeaders });
          if (commitRes.ok) { const cd = await commitRes.json(); baseTreeSha = cd.tree?.sha; }
        }
      }
      L(latestSha ? `🔗 آخر Commit: ${latestSha.slice(0,7)}` : "🆕 ريبو جديد (فارغ)", "info");

      // Collect files to push
      const filesToPush = [];
      const skipPatterns = [".git","node_modules",".env","account.txt","*.log","tmp","*.tmp",".DS_Store","coverage","dist/"];
      const shouldSkip = (p) => skipPatterns.some(s => {
        if (s.endsWith("/")) return p.startsWith(s);
        if (s.startsWith("*.")) return p.endsWith(s.slice(1));
        return p === s || p.includes("/" + s + "/") || p.includes("/" + s);
      });

      const collectFiles = (dir, base="") => {
        try {
          const entries = fs.readdirSync(dir);
          for (const e of entries) {
            const full = path.join(dir, e);
            const rel  = base ? base + "/" + e : e;
            if (shouldSkip(rel) || shouldSkip(e)) continue;
            const stat = fs.statSync(full);
            if (stat.isDirectory()) { collectFiles(full, rel); }
            else if (stat.size < 500000) { filesToPush.push({ path: rel, fullPath: full }); }
          }
        } catch (_) {}
      };

      if (scope === "bot") {
        ["src","David.js","index.js","package.json","config.json","manifest.json"].forEach(f => {
          const full = path.join(ROOT, f);
          if (!fs.existsSync(full)) return;
          if (fs.statSync(full).isDirectory()) collectFiles(full, f);
          else filesToPush.push({ path: f, fullPath: full });
        });
      } else if (scope === "apk") {
        collectFiles(path.join(ROOT, "app"), "app");
      } else {
        collectFiles(ROOT);
      }

      L(`📦 ${filesToPush.length} ملف سيتم رفعه…`, "info");
      if (!filesToPush.length) return res.json({ ok: false, error: "لا توجد ملفات للرفع", log });

      // Create blobs
      L("🔨 إنشاء blobs…", "info");
      const treeItems = [];
      let processed = 0;
      for (const f of filesToPush) {
        try {
          const content = fs.readFileSync(f.fullPath);
          const b64 = content.toString("base64");
          const blobRes = await fetch(`https://api.github.com/repos/${repo}/git/blobs`, {
            method: "POST", headers: ghHeaders,
            body: JSON.stringify({ content: b64, encoding: "base64" })
          });
          if (blobRes.ok) {
            const blob = await blobRes.json();
            treeItems.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
            processed++;
            if (processed % 20 === 0) L(`📤 ${processed}/${filesToPush.length} ملف…`, "info");
          }
        } catch (_) {}
      }
      L(`✅ تم إنشاء ${treeItems.length} blob`, "ok");

      // Create tree
      L("🌳 إنشاء tree…", "info");
      const treeBody = { tree: treeItems };
      if (baseTreeSha) treeBody.base_tree = baseTreeSha;
      const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
        method: "POST", headers: ghHeaders, body: JSON.stringify(treeBody)
      });
      if (!treeRes.ok) return res.json({ ok: false, error: "فشل إنشاء tree: " + (await treeRes.text()), log });
      const tree = await treeRes.json();

      // Create commit
      L("📝 إنشاء commit…", "info");
      const commitBody = { message, tree: tree.sha, parents: latestSha ? [latestSha] : [] };
      const commitRes2 = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
        method: "POST", headers: ghHeaders, body: JSON.stringify(commitBody)
      });
      if (!commitRes2.ok) return res.json({ ok: false, error: "فشل إنشاء commit: " + (await commitRes2.text()), log });
      const newCommit = await commitRes2.json();

      // Update ref
      L("🔄 تحديث الفرع…", "info");
      const updateBody = { sha: newCommit.sha, force: false };
      let refUpdateRes;
      if (latestSha) {
        refUpdateRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${defaultBranch}`, {
          method: "PATCH", headers: ghHeaders, body: JSON.stringify(updateBody)
        });
      } else {
        refUpdateRes = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
          method: "POST", headers: ghHeaders,
          body: JSON.stringify({ ref: `refs/heads/${defaultBranch}`, sha: newCommit.sha })
        });
      }
      if (!refUpdateRes.ok) {
        const errText = await refUpdateRes.text();
        if (errText.includes("not a fast forward")) {
          const forceRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${defaultBranch}`, {
            method: "PATCH", headers: ghHeaders, body: JSON.stringify({ sha: newCommit.sha, force: true })
          });
          if (!forceRes.ok) return res.json({ ok: false, error: "فشل تحديث الفرع (force)", log });
          L("⚠️ تم الرفع بالقوة (force push)", "warn");
        } else {
          return res.json({ ok: false, error: "فشل تحديث الفرع: " + errText, log });
        }
      }

      L(`🎉 تم الرفع! SHA: ${newCommit.sha.slice(0,7)} — ${treeItems.length} ملف`, "ok");
      res.json({ ok: true, sha: newCommit.sha, files: treeItems.length, log });
    } catch (e) {
      L("❌ خطأ: " + e.message, "err");
      res.json({ ok: false, error: e.message, log });
    }
  });

  // ── Railway API ───────────────────────────────────────────────────────────────
  app.get("/api/railway/status", auth, async (req, res) => {
    try {
      const { token, projectId } = req.query;
      if (!token || !projectId) return res.json({ ok: false, error: "token و projectId مطلوبان" });
      const query = `query { deployments(input: { projectId: "${projectId}" }, first: 1) { edges { node { id status createdAt url } } } }`;
      const r = await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });
      if (!r.ok) return res.json({ ok: false, error: `Railway API: ${r.status}` });
      const data = await r.json();
      if (data.errors) return res.json({ ok: false, error: data.errors[0]?.message || "Railway API error" });
      const dep = data.data?.deployments?.edges?.[0]?.node;
      if (!dep) return res.json({ ok: false, error: "لا يوجد deployments لهذا المشروع" });
      res.json({ ok: true, status: { status: dep.status, deploymentId: dep.id, url: dep.url, createdAt: dep.createdAt } });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.post("/api/railway/deploy", auth, async (req, res) => {
    try {
      const { token, projectId } = req.body;
      if (!token || !projectId) return res.json({ ok: false, error: "token و projectId مطلوبان" });
      const query = `mutation { deploymentTrigger(input: { projectId: "${projectId}" }) { id } }`;
      const r = await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });
      if (!r.ok) return res.json({ ok: false, error: `Railway API: ${r.status}` });
      const data = await r.json();
      if (data.errors) return res.json({ ok: false, error: data.errors[0]?.message });
      res.json({ ok: true, message: "✅ تم تشغيل الـ Deploy" });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Catch-all SPA ─────────────────────────────────────────────────────────────
  app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

  setInterval(() => { if (_io) _io.emit("stats-update", getStats()); }, 5000);

  return new Promise((resolve, reject) => {
    _server.listen(port, "0.0.0.0", () => {
      console.log();
      console.log(chalk.cyan("  ╔══════════════════════════════════════════╗"));
      console.log(chalk.cyan(`  ║  🌐 Dashboard: http://0.0.0.0:${port}       ║`));
      console.log(chalk.cyan("  ╚══════════════════════════════════════════╝"));
      console.log();
      resolve({ app, server: _server, io: _io });
    });
    _server.on("error", reject);
  });
}

module.exports = { startDashboard, getIO, interceptLogs };
