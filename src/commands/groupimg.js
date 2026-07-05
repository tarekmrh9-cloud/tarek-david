/**
 * AIZEN V2 — /groupimg — تغيير وقفل صورة الغروب
 * Copyright © 2025 SHIGA — v3.1 Fixed
 */
"use strict";
const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");
const os    = require("os");
const http  = require("http");
const https = require("https");

const CACHE = path.join(os.tmpdir(), "david_groupimg");
fs.ensureDirSync(CACHE);

function lockFile(tid) { return path.join(CACHE, `lock_${tid}.jpg`); }

function isAdmin(id) {
  const cfg = global.GoatBot?.config || {};
  const sid = String(id);
  const owners = [cfg.ownerID, ...(cfg.superAdminBot||[])].filter(Boolean).map(String);
  const admins = (cfg.adminBot||[]).map(String);
  return owners.includes(sid) || admins.includes(sid);
}

async function isGroupAdmin(api, uid, tid) {
  try {
    const info = await new Promise((res, rej) => api.getThreadInfo(tid, (e,d) => e ? rej(e) : res(d)));
    const admins = info?.adminIDs || [];
    return admins.some(a => String(a.id || a) === String(uid));
  } catch (_) { return false; }
}

const locks = new Map();

async function downloadImage(url) {
  const tmpFile = path.join(CACHE, `tmp_${Date.now()}.jpg`);
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36",
        "Accept": "image/*,*/*;q=0.8",
      },
      timeout: 25000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const dest = fs.createWriteStream(tmpFile);
      res.pipe(dest);
      dest.on("finish", () => resolve(tmpFile));
      dest.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.abort(); reject(new Error("timeout")); });
  });
}

async function applyImage(api, tid) {
  const lf = lockFile(tid);
  if (!fs.existsSync(lf)) return;
  try {
    await new Promise((resolve, reject) => {
      api.changeGroupImage(fs.createReadStream(lf), tid, (err) => {
        if (err) reject(err); else resolve();
      });
    });
  } catch (e) {
    if (global.log) global.log.warn("GROUPIMG", `فشل إعادة تطبيق الصورة: ${e.message}`);
  }
}

module.exports = {
  config: {
    name: "groupimg",
    aliases: ["gcimg", "صورة", "img"],
    version: "3.1",
    author: "SHIGA",
    countDown: 5,
    role: 2,
    category: "management",
    description: "تغيير وقفل صورة الغروب تلقائياً",
    guide: { en: "{pn} [رابط أو صورة] — تغيير وقفل\n{pn} off — فك القفل\n{pn} status — الحالة" }
  },

  onStart: async function({ api, event, args, message }) {
    const tid = String(event.threadID);
    const uid = event.senderID;

    const canUse = isAdmin(uid) || await isGroupAdmin(api, uid, tid);
    if (!canUse) return message.reply("⛔ هذا الأمر للأدمن فقط.");

    const sub = (args[0] || "").toLowerCase();

    if (sub === "off" || sub === "إيقاف") {
      locks.set(tid, false);
      const lf = lockFile(tid);
      if (fs.existsSync(lf)) { try { fs.removeSync(lf); } catch(_) {} }
      return message.reply("✅ تم فك قفل صورة الغروب.\n🔓 يمكن الآن تغيير الصورة بحرية.");
    }

    if (sub === "status" || sub === "حالة") {
      const locked = locks.get(tid) === true && fs.existsSync(lockFile(tid));
      return message.reply(locked
        ? "🔒 صورة الغروب مقفلة.\n↩️ استخدم /groupimg off لفك القفل."
        : "🔓 صورة الغروب غير مقفلة.");
    }

    let imageUrl = null;

    // Check reply attachment
    const replyAttach = event.messageReply?.attachments?.[0];
    if (replyAttach?.type === "photo") {
      imageUrl = replyAttach.url || replyAttach.previewUrl || replyAttach.thumbnailUrl;
    }

    // Check direct attachments
    if (!imageUrl) {
      const direct = (event.attachments || []).find(a => a.type === "photo");
      if (direct) imageUrl = direct.url || direct.previewUrl || direct.thumbnailUrl;
    }

    // Check args for URL
    if (!imageUrl) {
      for (const a of args) {
        if (a && (a.startsWith("http://") || a.startsWith("https://"))) { imageUrl = a; break; }
      }
    }

    if (!imageUrl) {
      return message.reply(
        "📸 كيفية الاستخدام:\n" +
        "• أرسل صورة مع الأمر /groupimg\n" +
        "• أو: /groupimg [رابط]\n" +
        "• أو رد على صورة بـ /groupimg\n\n" +
        "/groupimg off — فك القفل\n" +
        "/groupimg status — الحالة"
      );
    }

    message.react("⏳", event.messageID);

    try {
      const tmpPath = await downloadImage(imageUrl);
      const lf = lockFile(tid);
      fs.copySync(tmpPath, lf);
      try { fs.removeSync(tmpPath); } catch (_) {}

      await new Promise((resolve, reject) => {
        api.changeGroupImage(fs.createReadStream(lf), tid, (err) => {
          if (err) reject(err); else resolve();
        });
      });

      locks.set(tid, true);
      message.react("✅", event.messageID);
      message.reply(
        "✅ تم تغيير صورة الغروب وقفلها.\n" +
        "🔒 سيتم إعادة الصورة تلقائياً عند التغيير.\n" +
        "↩️ /groupimg off لفك القفل."
      );
    } catch (e) {
      message.react("❌", event.messageID);
      message.reply("❌ فشل تغيير الصورة: " + (e.message || String(e)));
    }
  },

  onEvent: async function({ api, event }) {
    if (event.logMessageType !== "log:thread-image") return;
    const tid = String(event.threadID);
    if (locks.get(tid) !== true) return;
    const lf = lockFile(tid);
    if (!fs.existsSync(lf)) return;
    setTimeout(() => applyImage(api, tid), 2500);
  }
};
