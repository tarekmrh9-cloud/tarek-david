/**
 * AIZEN V2 — Unified Event Handler (WHITE-V3 + Jarfis merged)
 * Copyright © 2025 SHIGA
 */
"use strict";

const rateLimit = require("../protection/rateLimit");

// ─── Anti-Duplicate Guard (منع معالجة نفس الرسالة مرتين) ───────────────────────
const _processed = new Map();   // messageID → timestamp
const DEDUP_TTL  = 60 * 1000;   // 60 ثانية
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of _processed) {
    if (now - ts > DEDUP_TTL) _processed.delete(k);
  }
}, 30 * 1000);

function isDuplicate(msgID) {
  if (!msgID) return false;
  if (_processed.has(msgID)) return true;
  _processed.set(msgID, Date.now());
  return false;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────
function getRole(senderID) {
  const cfg    = global.GoatBot?.config || {};
  const sid    = String(senderID);
  const supers = [...(cfg.superAdminBot || []), cfg.ownerID].filter(Boolean).map(String);
  const admins = (cfg.adminBot || []).map(String);
  if (supers.includes(sid)) return 3;
  if (admins.includes(sid)) return 2;
  return 0;
}

function isAdmin(senderID) {
  return getRole(senderID) >= 2;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildMessage(api, event) {
  return {
    reply: async (msg, cb) => {
      try {
        const text = typeof msg === "string" ? msg : msg?.body || "";
        const delay = global.utils?.calcHumanTypingDelay?.(text) || 1000;
        await global.utils?.simulateTyping?.(api, event.threadID, delay);
      } catch (_) {}
      return api.sendMessage(msg, event.threadID, cb);
    },
    unsend:  (mid, cb)        => { try { api.unsendMessage(mid || event.messageID, cb); } catch (_) {} },
    react:   (emoji, mid, cb) => { try { api.setMessageReaction(emoji, mid || event.messageID, () => {}, true); } catch (_) {} },
    send:    (msg, tid, cb)   => api.sendMessage(msg, tid || event.threadID, cb),
  };
}

// ─── Anti-Flood (Layer 16 من WHITE-V3) ───────────────────────────────────────────
function checkFlood(tid, sid) {
  const cfg = global.GoatBot?.config?.rateLimit || {};
  const key = `flood:${tid}:${sid}`;
  const r   = rateLimit.check(key, cfg.maxMessagesPerWindow || 8, cfg.windowMs || 6000);
  return r.exceeded;
}

// ─── Anti-Spam (Layer 17) ─────────────────────────────────────────────────────
function checkSpam(sid) {
  const key = `spam:${sid}`;
  return rateLimit.check(key, 20, 30000).exceeded;
}

// ─── Reply handler (onReply callbacks) ─────────────────────────────────────────
async function handleReply(api, event) {
  const replyMap = global.GoatBot?.onReply;
  if (!replyMap?.size) return false;
  const replyMsgID = event.messageReply?.messageID;
  if (!replyMsgID) return false;

  for (const [key, handler] of replyMap) {
    if (handler.messageID === replyMsgID &&
        (!handler.author || String(handler.author) === String(event.senderID))) {
      replyMap.delete(key);
      try {
        await handler.callback({
          api, event, message: buildMessage(api, event),
          args: (event.body || "").trim().split(/\s+/).filter(Boolean),
        });
      } catch (e) { global.log?.error?.("REPLY_CB", e.message); }
      return true;
    }
  }
  return false;
}

// ─── Event handler ─────────────────────────────────────────────────────────────
async function onEventCmds(api, event, commands) {
  if (!event || !api) return;
  global.lastMqttActivity = Date.now();

  const { type, senderID, threadID, body = "", messageID } = event;
  if (!senderID || !threadID) return;

  // تجاهل رسائل البوت لنفسه
  if (String(senderID) === String(global.GoatBot?.botID)) return;

  // منع معالجة نفس الرسالة مرتين
  if (messageID && isDuplicate(messageID)) return;

  // ── تتبع رسائل البشر للـ angel monitoring (قبل فحص الأدمن) ──────────────────
  if ((type === "message" || type === "message_reply") && threadID) {
    if (!global._msgListeners) global._msgListeners = [];
    for (const fn of global._msgListeners) {
      try { fn({ threadID, senderID, ts: Date.now() }); } catch (_) {}
    }
  }

  // Dashboard stats
  try {
    if (typeof global._bufferMsg === "function") global._bufferMsg({ ...event, ts: Date.now() });
    if (typeof global._trackMsg  === "function") global._trackMsg(threadID, senderID, body);
  } catch (_) {}

  // onEvent (group events like join/leave/image)
  if (type !== "message" && type !== "message_reply") {
    const allCmds = commands || global.GoatBot?.commands;
    if (allCmds) {
      for (const [, cmd] of allCmds) {
        if (typeof cmd.onEvent === "function") {
          try { await cmd.onEvent({ api, event, message: buildMessage(api, event) }); } catch (_) {}
        }
      }
    }
    return;
  }

  // Handle reply callbacks
  if (type === "message_reply" || event.messageReply) {
    if (await handleReply(api, event)) return;
  }

  if (type !== "message") return;
  if (!body.trim()) return;

  // DM lock
  if (global.GoatBot?.dmLocked && !event.isGroup) return;

  // ─── نظام الأدمن — البوت يرد على أدمن البوت فقط ──────────────────────────────
  const role = getRole(senderID);
  if (role < 2) {
    // تجاهل أي شخص ليس أدمناً (لا رد، لا رسالة خطأ)
    return;
  }

  // Flood + Spam (للأدمن فقط بعد التحقق)
  if (checkFlood(threadID, senderID)) return;
  if (checkSpam(senderID)) return;

  const prefix = global.GoatBot?.config?.prefix || "/";
  if (!body.trimStart().startsWith(prefix)) return;

  const parts   = body.trimStart().slice(prefix.length).trim().split(/\s+/);
  const cmdName = (parts[0] || "").toLowerCase();
  const args    = parts.slice(1);
  if (!cmdName) return;

  const allCmds = commands || global.GoatBot?.commands;
  const cmd     = allCmds?.get(cmdName);
  if (!cmd) return;

  // Thread-level command control
  try {
    const ctrl = require("../utils/cmdControl");
    if (!ctrl.isEnabled(threadID, cmd.config?.name || cmdName)) return;
  } catch (_) {}

  // Permission check (owner-only commands need role 3)
  const required = cmd.config?.role ?? 2;
  if (role < required) {
    try { await api.sendMessage("⛔ هذا الأمر للمالك فقط.", threadID); } catch (_) {}
    return;
  }

  // Execute — رسالة واحدة فقط
  const ctx = {
    api, event, args, commandName: cmdName,
    message: buildMessage(api, event),
    prefix, role, senderID, threadID,
  };
  try {
    if (typeof cmd.onStart === "function") await cmd.onStart(ctx);
    else if (typeof cmd.run === "function") await cmd.run(ctx);
  } catch (e) {
    global.log?.error?.("CMD", `خطأ في /${cmdName}: ${e.message}`);
    try { await api.sendMessage(`❌ خطأ في الأمر: ${e.message}`, threadID); } catch (_) {}
  }
}

module.exports = onEventCmds;
