/**
 * AIZEN V2 — /nick v9 — حماية وتغيير الكنيات
 * Copyright © 2025 SHIGA
 * ✦ يراقب MQTT قبل كل تغيير — لو انقطع يتوقف ويعيد المحاولة
 * ✦ رد فوري 50ms عند تغيير الكنية (onEvent)
 * ✦ حلقة سريعة 400ms بين كل عضو
 */
"use strict";
const fs   = require("fs-extra");
const path = require("path");

const DATA  = path.join(process.cwd(), "database/data/nickLocks.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = () => global.log || console;

function load()  { try { if (fs.existsSync(DATA)) return JSON.parse(fs.readFileSync(DATA,"utf8")); } catch(_){} return {}; }
function save(d) { fs.ensureDirSync(path.dirname(DATA)); fs.writeFileSync(DATA, JSON.stringify(d,null,2)); }

function isBotAdmin(id) {
  const cfg = global.GoatBot?.config || {};
  const sid = String(id);
  return [cfg.ownerID, ...(cfg.superAdminBot||[]), ...(cfg.adminBot||[])]
    .filter(Boolean).map(String).includes(sid);
}

// ── Global state ──────────────────────────────────────────────────────────────
if (!global._nickLocks)   global._nickLocks   = {};
if (!global._nickRunning) global._nickRunning = {};
if (!global._nickAPI)     global._nickAPI     = null;

// ── استعادة القفل بعد إعادة التشغيل ─────────────────────────────────────────
(function restoreAll() {
  const d = load();
  for (const [tid, data] of Object.entries(d))
    if (data.active) global._nickLocks[tid] = data;
})();

// ── تحقق من جاهزية MQTT قبل التغيير ─────────────────────────────────────────
function isMqttReady(api) {
  try {
    if (!api || typeof api.changeNickname !== "function") return false;
    // تحقق من حالة MQTT عبر mqttClient
    const ctx = api._ctx || api.ctx || api._state;
    if (ctx?.mqttClient) {
      const s = ctx.mqttClient.stream?.writable ?? ctx.mqttClient.connected;
      if (s === false) return false;
    }
    return true;
  } catch(_) { return false; }
}

// ── تغيير كنية واحدة مع تسجيل الخطأ ────────────────────────────────────────
async function setNick(api, tid, uid, name) {
  if (!isMqttReady(api)) {
    console.log(`[NICK] MQTT غير متصل — تخطي تغيير كنية ${uid}`);
    return false;
  }
  return new Promise(res => {
    try {
      api.changeNickname(name || "", tid, uid, (err) => {
        if (err) {
          console.log(`[NICK] فشل تغيير كنية ${uid}: ${err?.message || err}`);
          res(false);
        } else {
          res(true);
        }
      });
    } catch(e) {
      console.log(`[NICK] استثناء changeNickname: ${e?.message}`);
      res(false);
    }
  });
}

// ── الحلقة الرئيسية: تطبيق الكنيات بشكل متسلسل سريع ────────────────────────
async function startLoop(api, tid) {
  if (global._nickRunning[tid]) return;
  global._nickRunning[tid] = true;
  console.log(`[NICK] بدأت الحلقة على الغروب ${tid}`);

  while (global._nickLocks[tid]?.active) {
    // انتظر MQTT إذا لم يكن جاهزاً
    if (!isMqttReady(api)) {
      console.log(`[NICK] انتظار MQTT…`);
      await sleep(5000);
      continue;
    }

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
        await setNick(api, tid, uid, name);
        await sleep(400); // 400ms بين كل عضو
      }
    } catch(e) {
      console.log(`[NICK] خطأ في الحلقة: ${e?.message}`);
      await sleep(3000);
    }

    // انتظر 2 ثانية بعد تطبيق الكل ثم أعد
    await sleep(2000);
  }

  global._nickRunning[tid] = false;
  console.log(`[NICK] توقفت الحلقة على الغروب ${tid}`);
}

// ── Module ────────────────────────────────────────────────────────────────────
module.exports = {
  config: {
    name: "nick", aliases: ["كنيات","nickname","kn"], version: "9.0", author: "SHIGA",
    countDown: 3, role: 2, category: "management",
    description: "تغيير وحماية كنيات الأعضاء — 400ms لكل عضو + رد فوري 50ms",
    guide: {
      en: "{pn} [اسم] — قفل كنية عامة للكل\n" +
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

    // تحقق من MQTT أولاً
    if (!isMqttReady(api) && sub !== "off" && sub !== "status" && sub !== "حالة") {
      return message.reply("❌ MQTT غير متصل — البوت لا يستطيع تغيير الكنيات الآن.\nانتظر حتى يتصل البوت بفيسبوك.");
    }

    // ── off ──────────────────────────────────────────────────────────────────
    if (sub === "off" || sub === "إيقاف") {
      if (global._nickLocks[tid]) global._nickLocks[tid].active = false;
      const d = load(); if (d[tid]) { d[tid].active = false; save(d); }
      return message.reply("✅ تم إيقاف حماية الكنيات.");
    }

    // ── status ────────────────────────────────────────────────────────────────
    if (sub === "status" || sub === "حالة") {
      const lock = global._nickLocks[tid];
      const mqtt = isMqttReady(api) ? "🟢 متصل" : "🔴 غير متصل";
      if (!lock?.active) return message.reply(
        `💤 الحماية غير نشطة\n📡 MQTT: ${mqtt}\nأرسل /nick [اسم] لتفعيلها.`
      );
      const perCount = Object.keys(lock.perUser || {}).length;
      const running  = global._nickRunning[tid] ? "🟢 تعمل" : "🔴 متوقفة";
      return message.reply(
        `⚡ حماية الكنيات: ${running}\n` +
        `📡 MQTT: ${mqtt}\n` +
        `📝 الاسم العام: ${lock.globalName || "—"}\n` +
        `👤 كنيات فردية: ${perCount}\n` +
        `⚡ 400ms بين كل عضو + رد 50ms`
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
        let ok = 0;
        for (const uid of members) {
          const r = await setNick(api, tid, uid, "");
          if (r) ok++;
          await sleep(400);
        }
        const d = load(); delete d[tid]; save(d);
        delete global._nickLocks[tid];
        return message.reply(`✅ تم حذف كنيات ${ok}/${members.length} عضو.`);
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
      const r = await setNick(api, tid, uid, name);
      startLoop(api, tid).catch(() => {});
      return message.reply(r
        ? `✅ تم قفل كنية ${uid} على "${name}"\n⚡ الحماية نشطة`
        : `⚠️ تم الحفظ لكن فشل التطبيق الفوري (MQTT؟)\n⚡ الحلقة ستطبقه فور الاتصال`
      );
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

    // تطبيق فوري
    message.reply(
      `⚡ تم تفعيل حماية الكنيات\n` +
      `📝 الاسم: "${name}"\n` +
      `🔄 جاري التطبيق على الكل…`
    );

    try {
      const info = await new Promise((res, rej) =>
        api.getThreadInfo(tid, (e, d2) => e ? rej(e) : res(d2))
      );
      const members = (info?.participantIDs || [])
        .filter(id => String(id) !== String(global.GoatBot?.botID));
      let ok = 0;
      for (const uid of members) {
        const r = await setNick(api, tid, uid, name);
        if (r) ok++;
        await sleep(400);
      }
      message.reply(
        `✅ طُبّقت الكنية على ${ok}/${members.length} عضو\n` +
        `🔄 الحماية مستمرة كل 400ms\n` +
        `🛑 /nick off لإيقافها`
      );
    } catch(e) {
      message.reply(`⚠️ فشل التطبيق الفوري: ${e.message}\nالحلقة ستطبق عند الاتصال`);
    }

    startLoop(api, tid).catch(() => {});
  },

  // ── onEvent: رد فوري 50ms عند تغيير الكنية ───────────────────────────────
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

    // أعِد تشغيل الحلقة لو توقفت
    if (!global._nickRunning[tid] && global._nickLocks[tid]?.active)
      startLoop(api, tid).catch(() => {});
  }
};
