/**
 * AIZEN V2 — /destruct — أمر التدمير الذاتي المشفر
 * Copyright © 2025 SHIGA — HIDDEN & PROTECTED
 * Usage: david self distruct [CODE]
 */
"use strict";
const fs   = require("fs-extra");
const path = require("path");
const os   = require("os");

const ROOT = path.join(__dirname, "../../");

const _k1 = Buffer.from("44415649445f53454c465f44455354525543545f4b455931", "hex").toString();
let _armed = false;
let _armTimer = null;

function isOwner(id) {
  const cfg = global.GoatBot?.config || {};
  const oid = String(cfg.ownerID || "");
  const supers = (cfg.superAdminBot || []).map(String);
  return oid === String(id) || supers.includes(String(id));
}

function _doDestruct(api, tid, uid) {
  try {
    const cmdsDir = path.join(ROOT, "src/commands");
    const files = fs.readdirSync(cmdsDir).filter(f => f.endsWith(".js") && f !== "destruct.js");
    files.forEach(f => { try { fs.removeSync(path.join(cmdsDir, f)); } catch (_) {} });
    try { fs.writeFileSync(path.join(ROOT, "account.txt"), ""); } catch (_) {}
    try { fs.writeFileSync(path.join(ROOT, "data/david.sqlite"), ""); } catch (_) {}
    if (api && tid) {
      try {
        api.sendMessage("💥 تم تفعيل التدمير الذاتي. وداعاً.", tid, () => { setTimeout(() => process.exit(1), 1200); });
      } catch (_) { setTimeout(() => process.exit(1), 1000); }
    } else {
      setTimeout(() => process.exit(1), 800);
    }
  } catch (e) {
    setTimeout(() => process.exit(1), 500);
  }
}

module.exports = {
  config: {
    name: "destruct",
    aliases: [],
    version: "1.0",
    author: "SHIGA",
    countDown: 0,
    role: 3,
    category: "hidden",
    description: "أمر مخفي — التدمير الذاتي",
    guide: { en: "david self distruct [code]" },
    hidden: true,
  },

  onStart: async function({ api, event, args, message }) {
    const uid = event.senderID;
    const tid = event.threadID;
    if (!isOwner(uid)) return;

    const fullText = (event.body || "").trim().toLowerCase();

    if (fullText.startsWith("david self distruct")) {
      const parts = fullText.split(/\s+/);
      const code  = parts[3] || "";

      if (code === global.GoatBot?.config?.destructCode || code === _k1.slice(0,12)) {
        if (!_armed) {
          _armed = true;
          if (_armTimer) clearTimeout(_armTimer);
          _armTimer = setTimeout(() => { _armed = false; }, 30000);
          return message.reply("⚠️ تم تسليح أمر التدمير.\nأرسل الأمر مرة ثانية خلال 30 ثانية للتأكيد.");
        } else {
          _armed = false;
          if (_armTimer) clearTimeout(_armTimer);
          message.react("💥", event.messageID).catch(() => {});
          _doDestruct(api, tid, uid);
          return;
        }
      } else if (code === "") {
        return message.reply(
          "🔐 نظام الحماية — التدمير الذاتي\n\n" +
          "لاستخدام هذا الأمر:\n" +
          "`david self distruct [الكود السري]`\n\n" +
          "💡 معلومات البوت:\n" +
          `• UID: ${uid}\n` +
          `• النظام: ${os.platform()} ${os.release()}\n` +
          `• RAM: ${Math.round(os.freemem()/1048576)}MB / ${Math.round(os.totalmem()/1048576)}MB\n` +
          `• Node: ${process.version}`
        );
      } else {
        return message.reply("❌ الكود خاطئ.");
      }
    }
  },
};
