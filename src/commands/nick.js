/**
 * AIZEN V2 — /nick v8 — حماية وتغيير الكنيات (Ultra-Speed Parallel Mode)
 * Copyright © 2025 SHIGA
 * ✦ يغير كنية كل أعضاء الغروب بالتوازي فوراً عند التفعيل
 * ✦ يعيد الكنية خلال 50ms عند أي تغيير (onEvent)
 * ✦ حلقة خلفية كل 3 ثواني تعيد تطبيق الكنيات على الكل معاً
 */
"use strict";
const fs   = require("fs-extra");
const path = require("path");

const DATA  = path.join(process.cwd(), "database/data/nickLocks.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function load()  { try { if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA,"utf8")); } catch(_){} return {}; }
function save(d) { fs.ensureDirSync(path.dirname(DATA)); fs.writeFileSync(DATA, JSON.stringify(d,null,2)); }

function isBotAdmin(id) {
  const cfg = global.GoatBot?.config || {};
  const sid = String(id);
  return [cfg.ownerID, ...(cfg.superAdminBot||[]), ...(cfg.adminBot||[])]
    .filter(Boolean).map(String).includes(sid);
}

// ── Global state ──────────────────────────────────────────────────────────────
if (!global._nickLocks)   global._nickLocks   = {}; // tid → { active, globalName, perUser:{uid:name} }
if (!global._nickRunning) global._nickRunning = {}; // tid → true
if (!global._nickAPI)     global._nickAPI     = null;

// ── استعادة القفل بعد إعادة التشغيل ─────────────────────────────────────────
(function restoreAll() {
  const d = load();
  for (const [tid, data] of Object.entries(d))
    if (data.active) global._nickLocks[tid] = data;
})();

// ── تغيير كنية واحد — بدون انتظار (fire and forget) ────────────────────────
function setNick(api, tid, uid, name) {
  return new Promise(res => {
    try { api.changeNickname(name || "", tid, uid, () => res()); }
    catch(_) { res(); }
  });
}

// ── تطبيق كنيات كل الأعضاء بالتوازي فوراً ──────────────────────────────────
async function applyAll(api, tid) {
  const lock = global._nickLocks[tid];
  if (!lock?.active) return;
  try {
    const info = await new Promise((res, rej) =>
      api.getThreadInfo(tid, (e, d) => e ? rej(e) : res(d))
    );
    const members = (info?.participantIDs || [])
      .filter(id => String(id) !== String(global.GoatBot?.botID));

    // كل الأعضاء بالتوازي — بدون انتظار بين واحد وثاني
    await Promise.all(
      members.map(uid => {
        const name = (lock.perUser?.[uid] ?? lock.globalName) || "";
        if (!name) return Promise.resolve();
        return setNick(api, tid, uid, name);
      })
    );
  } catch(_) {}
}

// ── الحلقة الخلفية — كل 3 ثواني تعيد تطبيق الكل ────────────────────────────
async function startLoop(api, tid) {
  if (global._nickRunning[tid]) return;
  global._nickRunning[tid] = true;

  while (global._nickLocks[tid]?.active) {
    await applyAll(api, tid);
    // انتظر 3 ثواني ثم كرر
    await sleep(3000);
  }

  global._nickRunning[tid] = false;
}

// ── Module ────────────────────────────────────────────────────────────────────
module.exports = {
  config: {
    name: "nick", aliases: ["كنيات","nickname","kn"], version: "8.0", author: "SHIGA",
    countDown: 3, role: 2, category: "management",
    description: "تغيير وحماية كنيات الأعضاء — تطبيق فوري بالتوازي + حماية 50ms",
    guide: {
      en: "{pn} [اسم] — تفعيل قفل كنية عامة للكل\n" +
          "{pn} set [uid] [اسم] — قفل كنية لشخص محدد\n" +
          "{pn} off — إيقاف القفل\n" +
          "{pn} status — عرض الحالة\n" +
          "{pn} حدف — حذف جميع الكنيات"
    }
  },

  onStart: async function({ api, event, args, message }) {
    const tid = String(event.threadID);
    const sub = (args[0] || "").toLowerCase();
    global._nickAPI = api;

    // ── off ──────────────────────────────────────────────────────────────────
    if (sub === "off" || sub === "إيقاف") {
      if (global._nickLocks[tid]) global._nickLocks[tid].active = false;
      const d = load(); if (d[tid]) { d[tid].active = false; save(d); }
      return message.reply("✅ تم إيقاف حماية الكنيات.");
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (sub === "status" || sub === "حالة") {
      const lock = global._nickLocks[tid];
      if (!lock?.active) return message.reply("💤 الحماية غير نشطة.\nأرسل /nick [اسم] لتفعيلها.");
      const perCount = Object.keys(lock.perUser || {}).length;
      const running  = global._nickRunning[tid] ? "🟢 تعمل" : "🔴 متوقفة";
      return message.reply(
        `⚡ حماية الكنيات: ${running}\n` +
        `📝 الاسم العام: ${lock.globalName || "—"}\n` +
        `👤 كنيات فردية: ${perCount}\n` +
        `🔄 حلقة: كل 3 ثواني (تطبيق جماعي بالتوازي)\n` +
        `🚀 رد فوري: 50ms عند أي تغيير`
      );
    }

    // ── حدف — حذف جميع الكنيات ───────────────────────────────────────────────
    if (sub === "حدف" || sub === "reset") {
      if (global._nickLocks[tid]) global._nickLocks[tid].active = false;
      message.reply("🗑 جاري حذف جميع الكنيات…");
      try {
        const info = await new Promise((res, rej) =>
          api.getThreadInfo(tid, (e, d) => e ? rej(e) : res(d))
        );
        const members = (info?.participantIDs || [])
          .filter(id => String(id) !== String(global.GoatBot?.botID));
        // حذف بالتوازي
        await Promise.all(members.map(uid => setNick(api, tid, uid, "")));
        const d = load();
        delete d[tid];
        save(d);
        delete global._nickLocks[tid];
        return message.reply("✅ تم حذف جميع الكنيات.");
      } catch(e) { return message.reply("❌ خطأ: " + e.message); }
    }

    // ── set [uid] [name] ──────────────────────────────────────────────────────
    if (sub === "set") {
      const uid  = args[1];
      const name = args.slice(2).join(" ").trim();
      if (!uid || !name) return message.reply("❌ الاستخدام: /nick set [uid] [اسم]");
      if (!global._nickLocks[tid])
        global._nickLocks[tid] = { active: true, globalName: "", perUser: {} };
      global._nickLocks[tid].perUser[uid] = name;
      global._nickLocks[tid].active = true;
      const d = load(); d[tid] = global._nickLocks[tid]; save(d);
      await setNick(api, tid, uid, name); // طبّق فوراً
      startLoop(api, tid).catch(() => {});
      return message.reply(`✅ تم قفل كنية ${uid} على "${name}"\n⚡ الحماية نشطة`);
    }

    // ── [name] — قفل عام للكل ────────────────────────────────────────────────
    const name = args.join(" ").trim();
    if (!name) return message.reply(
      "❌ اكتب الاسم.\nمثال: /nick SHIGA\n\n" +
      "/nick [اسم] — قفل للكل\n" +
      "/nick set [uid] [اسم] — قفل لشخص\n" +
      "/nick off — إيقاف\n" +
      "/nick status — الحالة\n" +
      "/nick حدف — حذف الكنيات"
    );

    global._nickLocks[tid] = {
      active: true,
      globalName: name,
      perUser: global._nickLocks[tid]?.perUser || {}
    };
    const d = load(); d[tid] = global._nickLocks[tid]; save(d);

    // ابدأ التطبيق الفوري على الكل بالتوازي
    message.reply(
      `⚡ تم تفعيل حماية الكنيات\n` +
      `📝 الاسم: "${name}"\n` +
      `🚀 جاري تطبيق الكنية على الكل فوراً…`
    );

    await applyAll(api, tid); // تطبيق فوري بالتوازي
    message.reply(`✅ تم تطبيق الكنية على جميع الأعضاء\n🔄 الحماية نشطة — كل 3 ثواني\n🛑 /nick off لإيقافها`);

    startLoop(api, tid).catch(() => {});
  },

  // ── onEvent: رد فوري 50ms عند أي تغيير ──────────────────────────────────
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

    // رد فوري 50ms
    await sleep(50);
    setNick(api, tid, targetID, locked).catch(() => {});

    // تأكد أن الحلقة تعمل
    if (!global._nickRunning[tid] && global._nickLocks[tid]?.active)
      startLoop(api, tid).catch(() => {});
  }
};
