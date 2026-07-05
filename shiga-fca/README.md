# shiga-fca

> مكاتب البوت — Facebook Client Abstractions for AIZEN V2

**Copyright © SHIGA — All rights reserved.**

A high-level abstraction library over `fca-eryxenx` (Facebook Client API) built for the **AIZEN V2** Messenger Bot.

---

## Features

| Feature | Description |
|---------|-------------|
| `humanSend()` | Send messages with realistic typing delays |
| `calcDelay()` | Calculate human-like delay from message length |
| `appStateToCookieString()` | Convert appState JSON → cookie string |
| `cookieStringToAppState()` | Convert cookie string → appState array |
| `isValidAppState()` | Validate appState has required fields |
| `getThreadInfoAsync()` | Promise-based thread info |
| `getUserInfoAsync()` | Promise-based user info |
| `setTitleAsync()` | Promise-based group title change |
| `changeNicknameAsync()` | Promise-based nickname change |
| `MessageQueue` | Rate-limited message queue |

---

## Usage

```js
const fca = require("./shiga-fca");

// Send with human typing simulation
await fca.humanSend(api, "Hello!", threadID);

// Check if appState is valid
const valid = fca.isValidAppState(appState);

// Queue messages with rate limiting
const queue = new fca.MessageQueue(500, 2000);
await queue.enqueue(() => api.sendMessage("msg 1", tid));
await queue.enqueue(() => api.sendMessage("msg 2", tid));
```

---

## About

This library is part of the **AIZEN V2** bot project by **SHIGA**.

- Author: **SHIGA**
- Version: 1.0.0
- Engine: White Bot Engine
- Platform: Facebook Messenger
