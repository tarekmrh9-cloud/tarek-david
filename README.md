<div align="center">

<img src="https://img.shields.io/badge/DAVID%20V1-Android%20App-0A84FF?style=for-the-badge&logo=android&logoColor=white" height="36"/>

# DAVID V1 — DjamelBot Android

**لوحة تحكم احترافية لبوت فيسبوك ماسنجر — تطبيق Android بتصميم iOS 26**

---

## ⬇️ تحميل التطبيق

[![تحميل APK](https://img.shields.io/github/v/release/castrolmocro/divid-apk?label=%E2%AC%87%EF%B8%8F%20%D8%AA%D8%AD%D9%85%D9%8A%D9%84%20DAVID%20V1%20APK&style=for-the-badge&color=32D74B&logo=android)](https://github.com/castrolmocro/divid-apk/releases/latest/download/david-v1.apk)

> انقر الزر الأخضر أعلاه لتحميل أحدث نسخة مباشرةً

[![آخر إصدار](https://img.shields.io/github/v/release/castrolmocro/divid-apk?style=flat-square&label=آخر%20إصدار&color=0A84FF)](https://github.com/castrolmocro/divid-apk/releases/latest)
[![حالة البناء](https://img.shields.io/github/actions/workflow/status/castrolmocro/divid-apk/build-apk.yml?style=flat-square&label=حالة%20البناء)](https://github.com/castrolmocro/divid-apk/actions)

</div>

---

## ✨ الميزات (v5.1)

| الميزة | التفاصيل |
|--------|----------|
| 📱 تصميم iOS 26 | واجهة داكنة أنيقة مع تأثيرات زجاجية وضغط Spring |
| ☰ قائمة جانبية | زر ثابت على الشاشة يفتح القائمة في أي وقت — حتى من صفحة الخطأ |
| 🤖 محرك البوت | تشغيل البوت مباشرة من الهاتف عبر Termux بدون نافذة |
| 📡 الهاتف كسيرفر | تشغيل البوت محلياً + يفتح الواجهة تلقائياً بعد 5 ثوانٍ |
| 💬 مسنجر حي | إرسال رسائل وصور وصوت مع الردّ على الرسائل |
| 📨 طلبات الرسائل | قبول أو رفض طلبات الرسائل مع بطاقات زجاجية |
| ✏️ /nick المتطور | تغيير كنية البوت في كل الغروبات بحلقة مستمرة كل 3.5–5 ثوانٍ |
| 🤖 ملفات شخصية | تبديل بين عدة بوتات بنقرة واحدة مع ألوان مخصصة |
| ⚡ WakeLock | حماية من إيقاف ColorOS للخلفية |
| 🔋 استثناء البطارية | إعدادات OPPO/ColorOS خطوة بخطوة |
| 🤖 ذكاء اصطناعي | دعم Claude AI |
| 📊 إحصائيات | لوحة تحكم كاملة مع سجل مباشر |

---

## 📲 خطوات التثبيت

### على OPPO K12S 5G / ColorOS 16

1. **حمّل** ملف APK من الزر الأخضر أعلاه
2. **الإعدادات** ← **الأمان** ← **تثبيت تطبيقات من مصادر أخرى** ← فعّل للمتصفح أو مدير الملفات
3. **افتح** ملف APK من مجلد التنزيلات وثبّت
4. **شغّل** التطبيق ← اضغط **☰** أعلى اليسار لفتح القائمة
5. أدخل رابط السيرفر ← كلمة السر الافتراضية: **`david2025`**

### تغيير كلمة السر
في ملف `config.json`:
```json
{
  "dashboard": {
    "password": "كلمة_السر_الجديدة"
  }
}
```

---

## 📡 الهاتف كسيرفر (Termux)

```bash
# تثبيت Node.js
pkg update && pkg install nodejs git -y

# مجلد البوت
mkdir -p /sdcard/DAVID-V1
cd /sdcard/DAVID-V1
node index.js
```

ثم في التطبيق:
- اضغط **☰** ← **🤖 محرك البوت** ← **▶ تشغيل**
- البوت يعمل في الخلفية ويفتح الواجهة تلقائياً خلال 5 ثوانٍ

---

## 🗂️ القائمة الجانبية (Drawer)

| الطريقة | الوصف |
|---------|-------|
| زر **☰** أعلى اليسار | الأسرع — متاح دائماً فوق كل الشاشات |
| شريط الحافة اليمنى | مرر من الحافة اليمنى للشاشة (RTL عربي) |
| `Android.openDrawer()` | من الواجهة عبر JavaScript Bridge |

---

## 🔧 روابط السيرفر الشائعة

| النوع | الرابط |
|-------|--------|
| Railway | `https://اسمك.railway.app` |
| Render | `https://اسمك.onrender.com` |
| Termux نفس الشبكة | `http://192.168.x.x:5000` |
| Termux نفس الهاتف | `http://localhost:5000` |
| ngrok | `https://xxxx.ngrok-free.app` |

---

## 🔄 ما الجديد في v5.1

- ✅ **زر ☰ ثابت** على الشاشة — يفتح القائمة من أي مكان
- ✅ **إصلاح القائمة الجانبية** — كانت لا تظهر في بعض الأجهزة
- ✅ **شريط الحافة اليمنى** محسّن — أكبر وأسهل في اللمس (RTL)
- ✅ **محرك البوت** — تشغيل مباشر عبر Termux بدون نافذة
- ✅ **تأثيرات Spring** — كل الأزرار بضغطة iOS 26 أصيلة
- ✅ **طلبات الرسائل** — بطاقات زجاجية مع قبول/رفض
- ✅ **/nick v6** — حلقة مستمرة لتغيير الكنية في كل الغروبات

---

<div align="center">

صُنع بـ ❤️ | نسخة **v5.1** | آخر تحديث: يونيو 2025

</div>
