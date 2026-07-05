/**
 * AIZEN V2 — /setavatar — تغيير صورة حساب البوت
 * Copyright © 2025 SHIGA
 */
"use strict";
const axios = require("axios");
const fs    = require("fs-extra");
const path  = require("path");
const os    = require("os");

function isBotAdmin(id) {
  const cfg = global.GoatBot?.config || {};
  const sid = String(id);
  return [cfg.ownerID, ...(cfg.superAdminBot||[]), ...(cfg.adminBot||[])]
    .filter(Boolean).map(String).includes(sid);
}

module.exports = {
  config: {
    name: "setavatar", aliases: ["avatar","صورة-البوت"], version: "1.0", author: "SHIGA",
    countDown: 10, role: 3, category: "management",
    description: "تغيير صورة البروفايل لحساب البوت",
    guide: { en: "{pn} [رابط] — أو رد على صورة بـ {pn}" }
  },

  onStart: async function({ api, event, args, message }) {
    if (!isBotAdmin(event.senderID)) return message.reply("⛔ للمالك فقط.");

    // استخراج رابط الصورة
    let imageUrl = null;
    const attach = event.messageReply?.attachments?.[0] || event.attachments?.[0];
    if (attach?.type === "photo") imageUrl = attach.url || attach.previewUrl;
    if (!imageUrl) {
      for (const a of args) {
        if (a?.startsWith("http")) { imageUrl = a; break; }
      }
    }

    if (!imageUrl) {
      return message.reply(
        "📸 الاستخدام:\n" +
        "• /setavatar [رابط صورة]\n" +
        "• أو رد على صورة بـ /setavatar"
      );
    }

    message.react("⏳", event.messageID);
    try {
      const res = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 20000, headers: { "User-Agent": "Mozilla/5.0" } });
      const tmp = path.join(os.tmpdir(), `david_avatar_${Date.now()}.jpg`);
      fs.writeFileSync(tmp, Buffer.from(res.data));

      // محاولة تغيير صورة البوت عبر api.changeAvatar
      if (typeof api.changeAvatar === "function") {
        await new Promise((res, rej) => api.changeAvatar(fs.createReadStream(tmp), (e) => e ? rej(e) : res()));
        fs.removeSync(tmp);
        message.react("✅", event.messageID);
        return message.reply("✅ تم تغيير صورة البوت بنجاح.");
      }

      // fallback: api.setProfilePicture (بعض الإصدارات)
      if (typeof api.setProfilePicture === "function") {
        await new Promise((res, rej) => api.setProfilePicture(fs.createReadStream(tmp), (e) => e ? rej(e) : res()));
        fs.removeSync(tmp);
        message.react("✅", event.messageID);
        return message.reply("✅ تم تغيير صورة البوت.");
      }

      fs.removeSync(tmp);
      message.react("❌", event.messageID);
      return message.reply("❌ هذا الإصدار من FCA لا يدعم تغيير الصورة تلقائياً.\nيمكنك تغييرها يدوياً من إعدادات الحساب على Facebook.");
    } catch (e) {
      message.react("❌", event.messageID);
      message.reply("❌ فشل تغيير الصورة: " + e.message);
    }
  }
};
