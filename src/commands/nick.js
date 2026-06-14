/**
 * DAVID V1 — /nick v5 — قفل الكنيات (Lock Mode)
 * Copyright © 2025 DJAMEL
 * ✦ يقفل كنية كل عضو ويمنع أي شخص من تغييرها إلا أدمن البوت
 * ✦ يراقب عبر onEvent ويعيد الكنية فوراً عند تغييرها
 * ✦ تأخير عشوائي 3.5–5 ثوانٍ بين كل كنية
 */
"use strict";
const fs   = require("fs-extra");
const path = require("path");

const DATA = path.join(process.cwd(), "database/data/nickLocks.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function load()  { try { if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (_) {} return {}; }
function save(d) { fs.ensureDirSync(path.dirname(DATA)); fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }

function isBotAdmin(id) {
  const cfg = global.GoatBot?.config || {};
  const sid = String(id);
  return [cfg.ownerID, ...(cfg.superAdminBot || []), ...(cfg.adminBot || [])]
    .filter(Boolean).map(String).includes(sid);
}

function randDelay() { return 3500 + Math.random() * 1500; } // 3.5–5 ثانية

// ── Global state ──────────────────────────────────────────────────────────────
if (!global._nickLocks)     global._nickLocks     = {}; // tid → { active, globalName, perUser:{uid:name} }
if (!global._nickQueue)     global._nickQueue     = {}; // tid → قيد التطبيق
if (!global._nickRestoring) global._nickRestoring = {}; // tid:uid → true (منع التكرار)
if (!global._nickTimers)    global._nickTimers    = {}; // tid → intervalID للمراقبة الدورية
if (!global._nickAPI)       global._nickAPI       = null; // مرجع الـ API للمؤقتات

// ── استعادة من الملف ──────────────────────────────────────────────────────────
function restoreAll() {
  const d = load();
  for (const [tid, data] of Object.entries(d)) {
    if (data.active) global._nickLocks[tid] = data;
  }
}
restoreAll();

// ── تطبيق كنية لشخص واحد ──────────────────────────────────────────────────────
async function applyNick(api, tid, uid, name) {
  const key = `${tid}:${uid}`;
  if (global._nickRestoring[key]) return;
  global._nickRestoring[key] = true;
  try {
    await api.changeNickname(name || "", tid, uid);
  } catch (_) {}
  await sleep(randDelay());
  delete global._nickRestoring[key];
}

// ── تطبيق كنيات على جميع الأعضاء (عند التفعيل) ──────────────────────────────
async function applyAll(api, tid) {
  if (global._nickQueue[tid]) return;
  global._nickQueue[tid] = true;
  try {
    const info = await new Promise((res, rej) => api.getThreadInfo(tid, (e, d) => e ? rej(e) : res(d)));
    const members = (info?.participantIDs || []).filter(id => String(id) !== String(global.GoatBot?.botID));
    const lock    = global._nickLocks[tid] || {};
    for (const uid of members) {
      if (!lock.active) break;
      const name = lock.perUser?.[uid] ?? lock.globalName ?? "";
      if (name) await applyNick(api, tid, uid, name);
    }
  } catch (_) {}
  global._nickQueue[tid] = false;
}

// ── Module ────────────────────────────────────────────────────────────────────
module.exports = {
  config: {
    name: "nick", aliases: ["كنيات", "nickname"], version: "5.0", author: "DJAMEL",
    countDown: 3, role: 2, category: "management",
    description: "قفل كنيات الأعضاء ومنع تغييرها",
    guide: {
      en: "{pn} [اسم] — قفل كنية عامة للكل\n" +
          "{pn} set [uid] [اسم] — قفل كنية لشخص محدد\n" +
          "{pn} off — إيقاف القفل\n" +
          "{pn} status — الحالة\n" +
          "{pn} حدف — حذف جميع الكنيات"
    }
  },

  onStart: async function({ api, event, args, message }) {
    const tid = String(event.threadID);
    const sub = (args[0] || "").toLowerCase();

    global._nickAPI = api; // حفظ الـ API للمؤقتات الدورية

    // ── off ───────────────────────────────────────────────────────────────────
    if (sub === "off" || sub === "إيقاف") {
      if (global._nickLocks[tid]) global._nickLocks[tid].active = false;
      const d = load(); if (d[tid]) { d[tid].active = false; save(d); }
      // إيقاف المؤقت الدوري
      if (global._nickTimers[tid]) { clearInterval(global._nickTimers[tid]); delete global._nickTimers[tid]; }
      return message.reply("✅ تم إيقاف قفل الكنيات والمراقبة الدورية.");
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (sub === "status" || sub === "حالة") {
      const lock = global._nickLocks[tid];
      if (!lock?.active) return message.reply("💤 قفل الكنيات غير نشط.");
      const perCount = Object.keys(lock.perUser || {}).length;
      return message.reply(
        `🔒 قفل الكنيات نشط\n` +
        `📝 الاسم العام: ${lock.globalName || "—"}\n` +
        `👤 كنيات فردية: ${perCount}`
      );
    }

    // ── حدف / reset ───────────────────────────────────────────────────────────
    if (sub === "حدف" || sub === "reset") {
      message.reply("🗑 جاري حذف جميع الكنيات…");
      try {
        const info = await new Promise((res, rej) => api.getThreadInfo(tid, (e, d) => e ? rej(e) : res(d)));
        const members = (info?.participantIDs || []).filter(id => String(id) !== String(global.GoatBot?.botID));
        for (const uid of members) {
          try { await api.changeNickname("", tid, uid); } catch (_) {}
          await sleep(randDelay());
        }
        if (global._nickLocks[tid]) global._nickLocks[tid].perUser = {};
        return message.reply("✅ تم حذف جميع الكنيات.");
      } catch (e) { return message.reply("❌ خطأ: " + e.message); }
    }

    // ── set [uid] [name] ──────────────────────────────────────────────────────
    if (sub === "set") {
      const uid  = args[1];
      const name = args.slice(2).join(" ").trim();
      if (!uid || !name) return message.reply("❌ الاستخدام: /nick set [uid] [اسم]");
      if (!global._nickLocks[tid]) global._nickLocks[tid] = { active: true, globalName: "", perUser: {} };
      global._nickLocks[tid].perUser = global._nickLocks[tid].perUser || {};
      global._nickLocks[tid].perUser[uid] = name;
      global._nickLocks[tid].active = true;
      const d = load(); d[tid] = global._nickLocks[tid]; save(d);
      _startNickTimer(tid); // بدء المراقبة الدورية
      await applyNick(api, tid, uid, name);
      return message.reply(`✅ تم قفل كنية ${uid} على "${name}" مع المراقبة الدورية`);
    }

    // ── [name] — قفل عام ──────────────────────────────────────────────────────
    const name = args.join(" ").trim();
    if (!name) return message.reply("❌ اكتب الاسم.\nمثال: /nick DJAMEL");

    global._nickLocks[tid] = {
      active: true,
      globalName: name,
      perUser: global._nickLocks[tid]?.perUser || {}
    };
    const d = load(); d[tid] = global._nickLocks[tid]; save(d);
    _startNickTimer(tid); // بدء المراقبة الدورية

    message.reply(`🔒 تم تفعيل قفل الكنيات\n📝 الاسم: "${name}"\n⏱ تأخير 3.5–5s بين كل كنية\n👁 مراقبة فورية عند التغيير\n🔄 إعادة تطبيق تلقائي كل 8 دقائق`);
    applyAll(api, tid).catch(() => {});
  },

  // ── onEvent: مراقبة تغييرات الكنيات ──────────────────────────────────────────
  onEvent: async function({ api, event }) {
    global._nickAPI = api; // تحديث مرجع الـ API دائماً

    // كشف حدث تغيير الكنية — دعم صيغ متعددة من مكتبة fca
    const isNickChange =
      event.logMessageType === "log:user-nickname" ||
      event.type          === "log:user-nickname" ||
      (event.logMessageData?.participant_id !== undefined &&
       event.logMessageData?.nickname       !== undefined);

    if (!isNickChange) return;

    const tid  = String(event.threadID);
    const lock = global._nickLocks[tid];
    if (!lock?.active) return;

    // من الذي غيّر الكنية؟
    const changerID = String(event.author || event.senderID || "");
    if (isBotAdmin(changerID)) return; // أدمن البوت مسموح له

    // الشخص الذي تغيّرت كنيته
    const targetID = String(
      event.logMessageData?.participant_id ||
      event.logMessageData?.userId ||
      event.logMessageData?.subjectFbId || ""
    );
    if (!targetID) return;

    // الكنية المطلوبة
    const locked = lock.perUser?.[targetID] ?? lock.globalName;
    if (!locked) return;

    // أعِد الكنية بعد 800ms (تجنب تعارض مع الحدث نفسه)
    setTimeout(() => applyNick(api, tid, targetID, locked), 800);
  }
};

// ── مؤقت المراقبة الدورية (8 دقائق) ─────────────────────────────────────────
function _startNickTimer(tid) {
  if (global._nickTimers[tid]) clearInterval(global._nickTimers[tid]);
  global._nickTimers[tid] = setInterval(async () => {
    const lock = global._nickLocks[tid];
    if (!lock?.active) {
      clearInterval(global._nickTimers[tid]);
      delete global._nickTimers[tid];
      return;
    }
    const api = global._nickAPI;
    if (!api) return;
    // إعادة تطبيق جميع الكنيات بهدوء
    await applyAll(api, tid).catch(() => {});
  }, 8 * 60 * 1000); // كل 8 دقائق
}
