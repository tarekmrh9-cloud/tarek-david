/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   cookieManager.js — AIZEN V2 Cookie System v1.0       ║
 * ║   Copyright © 2025 SHIGA — All rights reserved         ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * ✦ تجديد تلقائي كل 3–4 ساعات (setInterval ذكي)
 * ✦ حفظ في account.txt + cookies.json
 * ✦ إرسال حالة فورية عبر Socket.io
 * ✦ Non-blocking — لا يوقف البوت أبداً
 * ✦ سجل كامل بالتواريخ والأخطاء
 */
"use strict";

const fs   = require("fs-extra");
const path = require("path");

const ROOT         = path.join(__dirname, "../../");
const ACCOUNT_PATH = path.join(ROOT, "account.txt");
const COOKIES_JSON = path.join(ROOT, "cookies.json");
const LOG_MAX      = 300;

// ── الحالة الداخلية ───────────────────────────────────────────────────────────
const _state = {
  status:      "unknown",   // unknown | valid | refreshing | expired | error
  lastRefresh: null,        // ISO string
  nextRefresh: null,        // ISO string
  uid:         null,
  cookieCount: 0,
  logs:        [],          // [{ts, level, msg}]
};

let _api     = null;
let _io      = null;
let _timer   = null;
let _running = false;

// ── أسماء المفاتيح الحساسة ────────────────────────────────────────────────────
const SENSITIVE_KEYS = new Set(["xs","c_user","fr","datr","sb","wd","m_sess","spin"]);

// ── مساعدات داخلية ───────────────────────────────────────────────────────────

function _ts() { return new Date().toISOString(); }

function _addLog(level, msg) {
  const entry = { ts: _ts(), level, msg };
  _state.logs.unshift(entry);
  if (_state.logs.length > LOG_MAX) _state.logs.length = LOG_MAX;

  // طباعة في Terminal
  try {
    const gl = global.log;
    if      (level === "ok")    gl?.ok?.("COOKIES", msg)    ?? console.log("[COOKIES]", msg);
    else if (level === "warn")  gl?.warn?.("COOKIES", msg)  ?? console.warn("[COOKIES]", msg);
    else if (level === "error") gl?.error?.("COOKIES", msg) ?? console.error("[COOKIES]", msg);
    else                        gl?.info?.("COOKIES", msg)  ?? console.log("[COOKIES]", msg);
  } catch(_) {}

  // إرسال عبر Socket
  if (_io) {
    _io.emit("cookie-log",    entry);
    _io.emit("cookie-status", _getStatus());
  }
}

function _setState(s) {
  _state.status = s;
  if (_io) _io.emit("cookie-status", _getStatus());
}

function _randInterval() {
  // عشوائي بين 3 و 4 ساعات (بالميلي ثانية)
  return (180 + Math.floor(Math.random() * 60)) * 60 * 1000;
}

function _maskValue(v) {
  if (!v || v.length < 4) return "••••";
  const show = Math.min(3, Math.floor(v.length * 0.15));
  return v.slice(0, show) + "••••••" + v.slice(-show);
}

// ── جلب AppState من الملف ────────────────────────────────────────────────────
function _loadCookiesFromFile() {
  try {
    const DjamelFCA = require("../../shiga-fca");
    if (!fs.existsSync(ACCOUNT_PATH)) return null;
    const raw = fs.readFileSync(ACCOUNT_PATH, "utf8").trim();
    if (!raw) return null;
    const parsed = DjamelFCA.parseCookieInput(raw);
    return parsed.cookies.length ? parsed.cookies : null;
  } catch(_) { return null; }
}

// ── حفظ AppState ──────────────────────────────────────────────────────────────
function _saveAppState(appState, uid) {
  try {
    // account.txt — يستخدمه البوت مباشرة
    global._selfWriteConfig = true;
    fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(appState, null, 2));
    setTimeout(() => { global._selfWriteConfig = false; }, 6000);

    // cookies.json — ملف metadata منظم
    const cookieData = {
      updatedAt:   _ts(),
      uid:         uid || _state.uid || "unknown",
      cookieCount: appState.length,
      cookies:     appState,
    };
    fs.writeFileSync(COOKIES_JSON, JSON.stringify(cookieData, null, 2));
    return true;
  } catch(e) {
    _addLog("error", `❌ فشل حفظ الكوكيز: ${e.message}`);
    return false;
  }
}

// ── التجديد الرئيسي ───────────────────────────────────────────────────────────
async function refreshNow(api) {
  if (_running) {
    _addLog("warn", "⏳ تجديد جارٍ بالفعل — تخطي");
    return { ok: false, reason: "busy" };
  }
  _running = true;
  _setState("refreshing");
  _addLog("info", "🔄 بدء تجديد الكوكيز…");

  const useApi = api || _api;

  try {
    // ─── مسار 1: API متصل — اجلب AppState الطازج ──────────────────────────
    if (useApi && typeof useApi.getAppState === "function") {
      let fresh;
      try { fresh = useApi.getAppState(); } catch(_) {}

      if (Array.isArray(fresh) && fresh.length) {
        const uid = _getUID(useApi);
        _saveAppState(fresh, uid);

        _state.cookieCount = fresh.length;
        _state.lastRefresh = _ts();
        _state.nextRefresh = new Date(Date.now() + _randInterval()).toISOString();
        _state.uid         = uid;
        _setState("valid");
        _addLog("ok", `✅ تم تجديد ${fresh.length} كوكي بنجاح (AppState طازج)`);
        _running = false;
        return { ok: true, count: fresh.length };
      }
    }

    // ─── مسار 2: لا API — تحقق من صلاحية الملف ────────────────────────────
    const DjamelFCA = require("../../shiga-fca");
    const cookies   = _loadCookiesFromFile();

    if (!cookies) {
      _setState("expired");
      _addLog("error", "❌ لا توجد كوكيز — ارفع كوكيز جديدة من لوحة التحكم");
      _running = false;
      return { ok: false, reason: "no_cookies" };
    }

    if (!DjamelFCA.hasMandatory(cookies)) {
      _setState("expired");
      _addLog("error", "❌ الكوكيز ناقصة — c_user أو xs مفقود");
      _running = false;
      return { ok: false, reason: "incomplete" };
    }

    _addLog("info", `🔍 جاري التحقق من صلاحية ${cookies.length} كوكي…`);
    const cookieStr = DjamelFCA.cookiesToString(cookies);
    const isLive    = await DjamelFCA.checkLiveCookie(cookieStr, DjamelFCA.getUA());

    if (isLive) {
      _state.cookieCount = cookies.length;
      _state.lastRefresh = _ts();
      _state.nextRefresh = new Date(Date.now() + _randInterval()).toISOString();
      _setState("valid");
      _addLog("ok", `✅ الكوكيز صالحة ومفعلة — ${cookies.length} كوكي`);
      _running = false;
      return { ok: true, count: cookies.length };
    } else {
      _setState("expired");
      _addLog("error", "❌ الكوكيز منتهية — يتم إعادة الاتصال…");
      _running = false;
      // إعادة تسجيل دخول بدون توقف (non-blocking)
      setTimeout(() => {
        try { global.startBot?.(); }
        catch(e) { _addLog("error", `❌ فشل إعادة الدخول: ${e.message}`); }
      }, 2000);
      return { ok: false, reason: "expired" };
    }

  } catch(e) {
    _setState("error");
    _addLog("error", `❌ خطأ أثناء التجديد: ${e.message}`);
    _running = false;
    return { ok: false, reason: e.message };
  }
}

// ── جدولة التجديد التلقائي ────────────────────────────────────────────────────
function _scheduleNext() {
  clearTimeout(_timer);
  const ms = _randInterval();
  _state.nextRefresh = new Date(Date.now() + ms).toISOString();
  const hrs = Math.round(ms / 3600000 * 10) / 10;
  _addLog("info", `⏰ التجديد التالي بعد ${hrs} ساعة`);

  _timer = setTimeout(async () => {
    await refreshNow();
    _scheduleNext();
  }, ms);
}

// ── استخراج UID ──────────────────────────────────────────────────────────────
function _getUID(api) {
  try { return String(api?.getCurrentUserID?.() || api?.getUID?.() || _state.uid || "?"); }
  catch(_) { return _state.uid || "?"; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  الـ API المصدَّر
// ─────────────────────────────────────────────────────────────────────────────

/**
 * يُستدعى بعد تسجيل دخول ناجح
 */
function start(api) {
  _api = api;
  _state.uid = _getUID(api);

  // حساب عدد الكوكيز الحالية
  const cookies = _loadCookiesFromFile();
  _state.cookieCount = cookies ? cookies.length : 0;

  _state.lastRefresh = _ts();
  _setState("valid");
  _addLog("ok", `🚀 نظام الكوكيز نشط — UID: ${_state.uid} — ${_state.cookieCount} كوكي`);

  // حفظ AppState الطازج بعد بدء التشغيل
  setTimeout(async () => {
    try {
      const fresh = api.getAppState?.();
      if (fresh?.length) {
        _saveAppState(fresh, _state.uid);
        _addLog("ok", `💾 حُفظ AppState الأولي — ${fresh.length} كوكي`);
      }
    } catch(_) {}
  }, 5000);

  _scheduleNext();
}

/**
 * يُستدعى قبل إعادة التشغيل أو الإيقاف
 */
function stop() {
  clearTimeout(_timer);
  _api     = null;
  _running = false;
  _addLog("info", "⏹ توقف نظام الكوكيز (إعادة تشغيل قادمة)");
}

/**
 * ربط Socket.io للتحديث اللحظي
 */
function setIO(io) {
  _io = io;
}

/**
 * حالة النظام الحالية
 */
function _getStatus() {
  return {
    status:      _state.status,
    lastRefresh: _state.lastRefresh,
    nextRefresh: _state.nextRefresh,
    uid:         _state.uid,
    cookieCount: _state.cookieCount,
  };
}

/**
 * الكوكيز الحالية مع إخفاء القيم الحساسة
 */
function getCurrentCookies() {
  try {
    // جرب cookies.json أولاً (أحدث)
    if (fs.existsSync(COOKIES_JSON)) {
      const data = JSON.parse(fs.readFileSync(COOKIES_JSON, "utf8"));
      if (Array.isArray(data.cookies) && data.cookies.length) {
        return _maskCookies(data.cookies);
      }
    }
    // fallback → account.txt
    const cookies = _loadCookiesFromFile();
    return cookies ? _maskCookies(cookies) : [];
  } catch(_) { return []; }
}

function _maskCookies(arr) {
  return arr.map(c => ({
    key:       c.key,
    value:     SENSITIVE_KEYS.has(c.key) ? _maskValue(c.value) : c.value,
    sensitive: SENSITIVE_KEYS.has(c.key),
    domain:    c.domain || ".facebook.com",
  }));
}

/**
 * آخر سجلات النظام
 */
function getLogs() { return _state.logs; }

// ── تصدير ────────────────────────────────────────────────────────────────────
module.exports = {
  start,
  stop,
  setIO,
  refreshNow,
  getStatus:        _getStatus,
  getLogs,
  getCurrentCookies,
};
