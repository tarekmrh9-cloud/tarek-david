/**
 * AIZEN V2 — /angel v5 — رسائل تلقائية مع نظام مراقبة ذكي
 * Copyright © 2025 SHIGA
 * ✦ يتوقف مؤقتاً إذا كان البوت آخر 3 مرات بدون رد بشري
 * ✦ يستأنف عند أول رسالة بشرية
 * ✦ يغادر المجموعة بعد 16 دقيقة من الصمت
 */
"use strict";
const fs   = require("fs-extra");
const path = require("path");

const DATA = path.join(process.cwd(), "database/data/angelData.json");

function load()   { try { if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (_) {} return {}; }
function save(d)  { fs.ensureDirSync(path.dirname(DATA)); fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }
function rand(a, b) { return a + Math.random() * (b - a); }

// ── Global state ──────────────────────────────────────────────────────────────
if (!global.GoatBot.angelIntervals) global.GoatBot.angelIntervals = {};
if (!global._angelState)            global._angelState = {};
// _angelState[tid] = { consecutive, paused, lastHumanTs }

// ── Human-message listener (registered once) ──────────────────────────────────
if (!global._msgListeners)            global._msgListeners = [];
if (!global._angelListenerRegistered) {
  global._angelListenerRegistered = true;
  global._msgListeners.push(({ threadID }) => {
    const st = global._angelState[threadID];
    if (!st) return;
    st.consecutive = 0;
    st.lastHumanTs = Date.now();
    if (st.paused) {
      st.paused = false;
      const data = load();
      const td   = data[threadID];
      if (td?.active && global.GoatBot?.fcaApi)
        scheduleNext(global.GoatBot.fcaApi, threadID, td);
    }
  });
}

// ── Core scheduler ────────────────────────────────────────────────────────────
function scheduleNext(api, tid, td) {
  clearTimeout(global.GoatBot.angelIntervals[tid]);
  delete global.GoatBot.angelIntervals[tid];
  if (!td?.active || !td?.message) return;

  if (!global._angelState[tid])
    global._angelState[tid] = { consecutive: 0, paused: false, lastHumanTs: Date.now() };
  if (global._angelState[tid].paused) return;

  const ms = Math.round(rand(td.minSeconds ?? 60, td.maxSeconds ?? td.minSeconds ?? 60) * 1000);

  global.GoatBot.angelIntervals[tid] = setTimeout(async () => {
    delete global.GoatBot.angelIntervals[tid];
    const fresh = load()[tid];
    if (!fresh?.active) return;

    // استخدم دائماً أحدث API بعد إعادة التشغيل
    const liveApi = global.GoatBot?.fcaApi || api;
    if (!liveApi) return;

    const st = global._angelState[tid] || {};

    // ── 16 دقيقة بدون رد بشري → أرسل 😂 واغادر ────────────────────────────
    if (Date.now() - (st.lastHumanTs || Date.now()) > 16 * 60 * 1000) {
      try { await liveApi.sendMessage("😂", tid); } catch (_) {}
      await new Promise(r => setTimeout(r, 2000));
      try { await liveApi.removeUserFromGroup(global.GoatBot.botID, tid); } catch (_) {}
      const d = load(); if (d[tid]) { d[tid].active = false; save(d); }
      delete global._angelState[tid];
      return;
    }

    // ── 3 رسائل متتالية → توقف مؤقت ─────────────────────────────────────────
    if ((st.consecutive || 0) >= 3) {
      st.paused = true;
      global._angelState[tid] = st;
      return; // المستمع سيستأنف عند رسالة بشرية
    }

    // ── إرسال ────────────────────────────────────────────────────────────────
    try {
      const delay = global.utils?.calcHumanTypingDelay?.(fresh.message) || 1500;
      await global.utils?.simulateTyping?.(liveApi, tid, delay);
      await liveApi.sendMessage(fresh.message, tid);
      st.consecutive = (st.consecutive || 0) + 1;
      global._angelState[tid] = st;
    } catch (_) {}

    const next = load()[tid];
    if (next?.active) scheduleNext(liveApi, tid, next);
  }, ms);
}

// ── Session restore ───────────────────────────────────────────────────────────
function restoreAll(api) {
  if (global.GoatBot._angelRestored) return;
  global.GoatBot._angelRestored = true;
  const data = load();
  for (const [tid, td] of Object.entries(data)) {
    if (td.active && td.message) {
      if (!global._angelState[tid])
        global._angelState[tid] = { consecutive: 0, paused: false, lastHumanTs: Date.now() };
      scheduleNext(api, tid, td);
    }
  }
}

// ── Module ────────────────────────────────────────────────────────────────────
module.exports = {
  config: {
    name: "angel", aliases: ["ang"], version: "5.0", author: "SHIGA",
    countDown: 3, role: 2, category: "management",
    description: "رسائل تلقائية ذكية مع نظام مراقبة",
    guide: { en: "{pn} [رسالة] [min] [max] — تفعيل\n{pn} off — إيقاف\n{pn} status — الحالة" }
  },

  onStart: async function({ api, event, args, message }) {
    const tid = event.threadID;
    restoreAll(api);
    const data = load();
    const sub  = (args[0] || "").toLowerCase();

    if (!sub || sub === "status") {
      const td = data[tid];
      if (!td?.active) return message.reply("💤 Angel غير مفعل في هذا الغروب.");
      const st   = global._angelState[tid] || {};
      const mode = st.paused ? "⏸ متوقف مؤقتاً (ينتظر رد)" : "▶️ نشط";
      return message.reply(
        `🕊 Angel — ${mode}\n` +
        `📝 الرسالة: ${td.message}\n` +
        `⏱ كل: ${td.minSeconds}–${td.maxSeconds}s\n` +
        `🔢 رسائل متتالية: ${st.consecutive || 0}/3`
      );
    }

    if (sub === "off") {
      clearTimeout(global.GoatBot.angelIntervals[tid]);
      delete global.GoatBot.angelIntervals[tid];
      delete global._angelState[tid];
      if (data[tid]) { data[tid].active = false; save(data); }
      return message.reply("✅ تم إيقاف Angel.");
    }

    // /angel [رسالة] [min] [max]
    const nums      = args.filter(a => /^\d+$/.test(a));
    const textParts = args.filter(a => !/^\d+$/.test(a) && a.toLowerCase() !== "on");
    const msg  = textParts.join(" ").trim() || data[tid]?.message || "🌸 مرحباً!";
    const minS = parseInt(nums[0]) || 60;
    const maxS = Math.max(parseInt(nums[1]) || minS, minS);

    data[tid] = { active: true, message: msg, minSeconds: minS, maxSeconds: maxS };
    save(data);

    global._angelState[tid] = { consecutive: 0, paused: false, lastHumanTs: Date.now() };
    scheduleNext(api, tid, data[tid]);
    message.reply(
      `✅ تم تفعيل Angel v5\n` +
      `📝 "${msg}"\n` +
      `⏱ كل ${minS}–${maxS} ثانية\n` +
      `🧠 يتوقف بعد 3 رسائل بدون رد\n` +
      `⚠️ يغادر بعد 16 دقيقة صمت`
    );
  }
};
