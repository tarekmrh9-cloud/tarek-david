---
name: DAVID V1 Architecture
description: Key project decisions, structure, and quirks for the DAVID V1 Facebook bot project
---

## Project Overview
- Node.js 18 / Express / Socket.io on port 5000
- `Djamel-fca` local package (ESM→CJS patched via postinstall)
- Dashboard: `src/dashboard/public/index.html` (single giant SPA file, ~3200 lines after updates)
- Android app: `app/src/main/java/com/djamel/davidbot/MainActivity.java` (WebView-based)
- Login password: `david2025` (in config.json)

## Dashboard Tabs (13 after update)
control, messenger, cookies, commands, activation, editor, protection, settings, messages, logs, ai, files, **railway** (new)

## Key Files
- `src/dashboard/server.js` — Express backend (946→1100+ lines after Railway/GitHub API)
- `src/dashboard/public/index.html` — Full SPA
- `David.js` — Main bot engine
- `app/src/main/java/com/djamel/davidbot/MainActivity.java` — Android

## Railway/GitHub API Added
- `GET /api/github/repo-info` — check repo info
- `POST /api/github/push` — push files using Git Trees API (blobs → tree → commit → ref update)
- `GET /api/railway/status` — Railway GraphQL status query
- `POST /api/railway/deploy` — trigger Railway deploy

## Android Changes
- Added `showRailwayDialog()` method
- Added `openRailwayHelp()` / `openPhoneHostHelp()` to AndroidBridge
- Updated `showConnectionError()` with hosting mode options (Railway / Phone / Replit)
- Drawer now has "🚀 نشر البوت" section with Railway + Phone buttons prominently

## Why fetch() in server.js
Node 18 has native fetch — no node-fetch needed. All GitHub and Railway API calls use native fetch directly.

## Swipe Fix
Changed dt > 600 → dt > 900, dx < 55 → dx < 45, dy ratio 0.75 → 1.1 (more permissive)

## TAB_ORDER
Now includes ai, files, railway — all 13 tabs swipeable
