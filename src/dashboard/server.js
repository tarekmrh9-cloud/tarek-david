/**
 * DAVID V1 — Dashboard Server (Express + Socket.io)
 * Copyright © 2025 DJAMEL
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
    senderName: global.GoatBot?.config?.botName || "DAVID",
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
    botName:       global.GoatBot?.config?.botName || "DAVID V1",
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
    res.json({ ok: true, online, botID: global.GoatBot?.botID || null, botName: global.GoatBot?.config?.botName || "DAVID V1" });
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
      const DjamelFCA = require("../../Djamel-fca");
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
      botName: global.GoatBot?.config?.botName || "DAVID V1",
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
  app.get("/api/messenger/thread/:tid/info", auth, (req, res) => {
    const api = global.GoatBot?.fcaApi;
    if (!api) return res.json({ ok: false, error: "البوت غير متصل" });
    const tid = req.params.tid;
    const fn  = api.getThreadInfo || api.getThreadInfoByID;
    if (!fn) return res.json({ ok: false, error: "getThreadInfo غير مدعوم" });
    fn.call(api, tid, (err, info) => {
      if (err) return res.json({ ok: false, error: err.message });
      res.json({ ok: true, info });
    });
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
