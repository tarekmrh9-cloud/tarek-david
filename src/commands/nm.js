/**
 * AIZEN V2 — /nm v3 — قفل اسم الغروب
 * Copyright © 2025 SHIGA
 * ✦ يراقب عبر onEvent ويعيد الاسم فوراً عند تغييره
 * ✦ /nm [اسم] — تفعيل القفل
 * ✦ /nm off — إيقاف القفل
 * ✦ /nm time [min] [max] — ضبط التجديد الدوري
 * ✦ /nm status — الحالة
 */
"use strict";
const fs   = require("fs-extra");
const path = require("path");

const DATA = path.join(process.cwd(), "database/data/nmData.json");

function load()  { try { if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (_) {} return {}; }
function save(d) { fs.ensureDirSync(path.dirname(DATA)); fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }

function isBotAdmin(id) {
  const cfg = global.GoatBot?.config || {};
  const sid = String(id);
  return [cfg.ownerID, ...(cfg.superAdminBot || []), ...(cfg.adminBot || [])]
    .filter(Boolean).map(String).includes(sid);
}

// ── Global state ──────────────────────────────────────────────────────────────
if (!global._nmLocks)     global._nmLocks     = {}; // tid → { active, name, minDelay, maxDelay }
if (!global._nmTimers)    global._nmTimers    = {}; // tid → setTimeout handle
if (!global._nmRestoring) global._nmRestoring = {}; // tid → true (منع التكرار)

// ── استعادة من الملف ──────────────────────────────────────────────────────────
function restoreAll(api) {
  if (global._nmRestored) return;
  global._nmRestored = true;
  const d = load();
  for (const [tid, lock] of Object.entries(d)) {
    if (lock.active && lock.name) {
      global._nmLocks[tid] = lock;
      startTimer(api, tid);
    }
  }
}

// ── التجديد الدوري ────────────────────────────────────────────────────────────
function stopTimer(tid) {
  clearTimeout(global._nmTimers[tid]);
  delete global._nmTimers[tid];
}

function startTimer(api, tid) {
  stopTimer(tid);
  const lock = global._nmLocks[tid];
  if (!lock?.active || !lock?.name) return;

  const ms = rand(lock.minDelay ?? 5, lock.maxDelay ?? 5) * 1000;
  global._nmTimers[tid] = setTimeout(async () => {
    const cur = global._nmLocks[tid];
    if (!cur?.active || !cur?.name) return;
    // استخدم دائماً أحدث API بعد إعادة التشغيل
    const liveApi = global.GoatBot?.fcaApi || api;
    if (!liveApi) return;
    try { await liveApi.setTitle(cur.name, tid); } catch (_) {}
    startTimer(liveApi, tid);
  }, ms);
}

// ── Module ────────────────────────────────────────────────────────────────────
module.exports = {
  config: {
    name: "nm", aliases: ["namemute", "غلق", "lockname"], version: "3.0", author: "SHIGA",
    countDown: 3, role: 2, category: "management",
    description: "قفل اسم الغروب ومنع تغييره",
    guide: {
      en: "{pn} [اسم] — تفعيل القفل\n" +
          "{pn} off — إيقاف القفل\n" +
          "{pn} time [min] [max] — ضبط التجديد الدوري بالثوانٍ\n" +
          "{pn} status — الحالة"
    }
  },

  onStart: async function({ api, event, args, message }) {
    const tid = String(event.threadID);
    restoreAll(api);
    const sub = (args[0] || "").toLowerCase();

    // ── status ────────────────────────────────────────────────────────────────
    if (sub === "status") {
      const lock = global._nmLocks[tid];
      if (!lock?.active) return message.reply("💤 قفل الاسم غير مفعل.");
      return message.reply(
        `🔒 قفل الاسم نشط\n` +
        `📝 الاسم: "${lock.name}"\n` +
        `⏱ تجديد كل: ${lock.minDelay}–${lock.maxDelay}s\n` +
        `👁 يراقب ويعيد الاسم فوراً عند تغييره`
      );
    }

    // ── off ───────────────────────────────────────────────────────────────────
    if (sub === "off" || sub === "فك" || sub === "unm" || sub === "stop") {
      stopTimer(tid);
      if (global._nmLocks[tid]) global._nmLocks[tid].active = false;
      const d = load(); if (d[tid]) { d[tid].active = false; save(d); }
      return message.reply("✅ تم فك قفل اسم الغروب.");
    }

    // ── time [min] [max] ──────────────────────────────────────────────────────
    if (sub === "time") {
      const minDelay = parseInt(args[1]) || 30;
      const maxDelay = Math.max(parseInt(args[2]) || minDelay, minDelay);
      if (!global._nmLocks[tid]) global._nmLocks[tid] = { active: false, name: "", minDelay, maxDelay };
      else { global._nmLocks[tid].minDelay = minDelay; global._nmLocks[tid].maxDelay = maxDelay; }
      const d = load(); if (!d[tid]) d[tid] = {}; d[tid].minDelay = minDelay; d[tid].maxDelay = maxDelay; save(d);
      if (global._nmLocks[tid].active) startTimer(api, tid);
      return message.reply(`✅ تم ضبط وقت التجديد: ${minDelay}–${maxDelay} ثانية`);
    }

    // ── [name] — تفعيل القفل ──────────────────────────────────────────────────
    const name = args.join(" ").trim();
    if (!name) return message.reply("❌ اكتب اسم الغروب.\nمثال: /nm DAVID GROUP");

    const existing = global._nmLocks[tid] || {};
    global._nmLocks[tid] = {
      active: true,
      name,
      minDelay: existing.minDelay ?? 5,
      maxDelay: existing.maxDelay ?? 5
    };

    const d = load(); d[tid] = global._nmLocks[tid]; save(d);

    // تطبيق فوري
    try { await api.setTitle(name, tid); } catch (_) {}
    startTimer(api, tid);

    message.reply(
      `🔒 تم تفعيل قفل الاسم\n` +
      `📝 "${name}"\n` +
      `⏱ تجديد كل ${global._nmLocks[tid].minDelay}–${global._nmLocks[tid].maxDelay}s\n` +
      `👁 يعيد الاسم فوراً عند أي تغيير`
    );
  },

  // ── onEvent: مراقبة تغييرات اسم الغروب ───────────────────────────────────────
  onEvent: async function({ api, event }) {
    if (event.logMessageType !== "log:thread-name") return;
    const tid  = String(event.threadID);
    const lock = global._nmLocks[tid];
    if (!lock?.active || !lock?.name) return;

    // أدمن البوت مسموح له
    const changer = String(event.author || event.senderID || "");
    if (isBotAdmin(changer)) return;

    // هل الاسم الجديد مختلف؟
    const newName = event.logMessageData?.name || "";
    if (newName === lock.name) return;

    // منع التكرار
    if (global._nmRestoring[tid]) return;
    global._nmRestoring[tid] = true;

    setTimeout(async () => {
      try { await api.setTitle(lock.name, tid); } catch (_) {}
      delete global._nmRestoring[tid];
    }, 800);
  }
};
