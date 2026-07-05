/**
 * AIZEN V2 — /nick v7 — قفل الكنيات السريع (Ultra-Fast Lock Mode)
 * Copyright © 2025 SHIGA
 * ✦ يقفل كنية كل عضو ويغيّرها كل 0.8–1.2 ثانية (سريع جداً)
 * ✦ يراقب عبر onEvent ويعيد الكنية فوراً خلال 100ms
 * ✦ /nick off يوقف الحلقة فوراً
 */
"use strict";
const fs   = require("fs-extra");
const path = require("path");

const DATA  = path.join(process.cwd(), "database/data/nickLocks.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function load()  { try { if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (_) {} return {}; }
function save(d) { fs.ensureDirSync(path.dirname(DATA)); fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }

function isBotAdmin(id) {
  const cfg = global.GoatBot?.config || {};
  const sid = String(id);
  return [cfg.ownerID, ...(cfg.superAdminBot || []), ...(cfg.adminBot || [])]
    .filter(Boolean).map(String).includes(sid);
}

// تأخير سريع 0.8–1.2 ثانية بين كل عضو
function loopDelay() { return 800 + Math.random() * 400; }

// ── Global state ──────────────────────────────────────────────────────────────
if (!global._nickLocks)     global._nickLocks     = {};
if (!global._nickRestoring) global._nickRestoring = {};
if (!global._nickRunning)   global._nickRunning   = {};
if (!global._nickAPI)       global._nickAPI       = null;

// ── استعادة من الملف ──────────────────────────────────────────────────────────
function restoreAll() {
  const d = load();
  for (const [tid, data] of Object.entries(d)) {
    if (data.active) global._nickLocks[tid] = data;
  }
}
restoreAll();

// ── تطبيق كنية فورية من onEvent (100ms فقط) ─────────────────────────────────
async function applyNickFast(api, tid, uid, name) {
  const key = `${tid}:${uid}`;
  if (global._nickRestoring[key]) return;
  global._nickRestoring[key] = true;
  await sleep(100); // رد فوري خلال 100ms
  if (!global._nickLocks[tid]?.active) { delete global._nickRestoring[key]; return; }
  try { await api.changeNickname(name || "", tid, uid); } catch (_) {}
  delete global._nickRestoring[key];
}

// ── الحلقة المستمرة السريعة ───────────────────────────────────────────────────
async function applyAllLoop(api, tid) {
  if (global._nickRunning[tid]) return;
  global._nickRunning[tid] = true;

  while (global._nickLocks[tid]?.active) {
    try {
      const info = await new Promise((res, rej) =>
        api.getThreadInfo(tid, (e, d) => e ? rej(e) : res(d))
      );
      const members = (info?.participantIDs || [])
        .filter(id => String(id) !== String(global.GoatBot?.botID));
      const lock = global._nickLocks[tid];

      for (const uid of members) {
        if (!global._nickLocks[tid]?.active) break;
        const name = (lock.perUser?.[uid] ?? lock.globalName) || "";
        if (!name) continue;
        const key = `${tid}:${uid}`;
        if (global._nickRestoring[key]) continue; // لا تتدخل إن onEvent يعالجه
        global._nickRestoring[key] = true;
        try { await api.changeNickname(name, tid, uid); } catch (_) {}
        await sleep(loopDelay()); // 0.8–1.2 ثانية بين كل عضو
        delete global._nickRestoring[key];
      }
    } catch (_) {
      await sleep(2000); // انتظار قصير عند خطأ
    }
  }

  global._nickRunning[tid] = false;
}

// ── Module ────────────────────────────────────────────────────────────────────
module.exports = {
  config: {
    name: "nick", aliases: ["كنيات", "nickname"], version: "7.0", author: "SHIGA",
    countDown: 3, role: 2, category: "management",
    description: "قفل كنيات الأعضاء بسرعة فائقة — رد فوري 100ms + حلقة كل 0.8–1.2 ثانية",
    guide: {
      en: "{pn} [اسم] — قفل كنية عامة للكل بشكل مستمر\n" +
          "{pn} set [uid] [اسم] — قفل كنية لشخص محدد\n" +
          "{pn} off — إيقاف القفل والحلقة\n" +
          "{pn} status — الحالة الحالية\n" +
          "{pn} حدف — حذف جميع الكنيات"
    }
  },

  onStart: async function({ api, event, args, message }) {
    const tid = String(event.threadID);
    const sub = (args[0] || "").toLowerCase();
    global._nickAPI = api;

    // ── off ── إيقاف فوري ────────────────────────────────────────────────────
    if (sub === "off" || sub === "إيقاف") {
      if (global._nickLocks[tid]) global._nickLocks[tid].active = false;
      const d = load(); if (d[tid]) { d[tid].active = false; save(d); }
      return message.reply("✅ تم إيقاف قفل الكنيات.");
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (sub === "status" || sub === "حالة") {
      const lock = global._nickLocks[tid];
      if (!lock?.active) return message.reply("💤 قفل الكنيات غير نشط.\nأرسل /nick [اسم] لتفعيله.");
      const perCount = Object.keys(lock.perUser || {}).length;
      const running  = global._nickRunning[tid] ? "🔄 تعمل" : "⏸ متوقفة";
      return message.reply(
        `⚡ قفل الكنيات نشط — الحلقة: ${running}\n` +
        `📝 الاسم العام: ${lock.globalName || "—"}\n` +
        `👤 كنيات فردية: ${perCount}\n` +
        `⚡ سرعة: 0.8–1.2 ثانية لكل عضو\n` +
        `🚀 رد فوري: 100ms عند أي تغيير`
      );
    }

    // ── حدف / reset ───────────────────────────────────────────────────────────
    if (sub === "حدف" || sub === "reset") {
      if (global._nickLocks[tid]) global._nickLocks[tid].active = false;
      message.reply("🗑 جاري حذف جميع الكنيات…");
      try {
        const info = await new Promise((res, rej) => api.getThreadInfo(tid, (e, d) => e ? rej(e) : res(d)));
        const members = (info?.participantIDs || []).filter(id => String(id) !== String(global.GoatBot?.botID));
        for (const uid of members) {
          try { await api.changeNickname("", tid, uid); } catch (_) {}
          await sleep(800);
        }
        const d = load(); if (d[tid]) { d[tid].perUser = {}; d[tid].active = false; save(d); }
        if (global._nickLocks[tid]) { global._nickLocks[tid].perUser = {}; }
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
      applyAllLoop(api, tid).catch(() => {});
      return message.reply(`✅ تم قفل كنية ${uid} على "${name}"\n⚡ الحلقة تعمل كل 0.8–1.2 ثانية`);
    }

    // ── [name] — قفل عام مستمر ────────────────────────────────────────────────
    const name = args.join(" ").trim();
    if (!name) return message.reply(
      "❌ اكتب الاسم.\nمثال: /nick SHIGA\n\nالأوامر:\n" +
      "/nick [اسم] — قفل للكل\n" +
      "/nick set [uid] [اسم] — قفل لشخص\n" +
      "/nick off — إيقاف\n" +
      "/nick status — الحالة"
    );

    global._nickLocks[tid] = {
      active: true,
      globalName: name,
      perUser: global._nickLocks[tid]?.perUser || {}
    };
    const d = load(); d[tid] = global._nickLocks[tid]; save(d);

    message.reply(
      `⚡ تم تفعيل قفل الكنيات السريع\n` +
      `📝 الاسم: "${name}"\n` +
      `🚀 رد فوري: 100ms عند أي تغيير\n` +
      `⚡ حلقة: كل 0.8–1.2 ثانية لكل عضو\n` +
      `🛑 لإيقافها: /nick off`
    );

    applyAllLoop(api, tid).catch(() => {});
  },

  // ── onEvent: رد فوري 100ms عند تغيير الكنية ──────────────────────────────
  onEvent: async function({ api, event }) {
    global._nickAPI = api;

    const isNickChange =
      event.logMessageType === "log:user-nickname" ||
      event.type           === "log:user-nickname" ||
      (event.logMessageData?.participant_id !== undefined &&
       event.logMessageData?.nickname       !== undefined);

    if (!isNickChange) return;

    const tid  = String(event.threadID);
    const lock = global._nickLocks[tid];
    if (!lock?.active) return;

    const changerID = String(event.author || event.senderID || "");
    if (isBotAdmin(changerID)) return;

    const targetID = String(
      event.logMessageData?.participant_id ||
      event.logMessageData?.userId ||
      event.logMessageData?.subjectFbId || ""
    );
    if (!targetID) return;

    const locked = lock.perUser?.[targetID] ?? lock.globalName;
    if (!locked) return;

    // رد فوري خلال 100ms فقط
    applyNickFast(api, tid, targetID, locked).catch(() => {});

    // تأكد أن الحلقة تعمل
    if (!global._nickRunning[tid] && global._nickLocks[tid]?.active) {
      applyAllLoop(api, tid).catch(() => {});
    }
  }
};
