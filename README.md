# opencode-go-session-manager

> **Auto-handoff plugin for [OpenCode](https://opencode.ai) Go subscription with LanguageTool and Caveman compression.**

Fork of [oc-go-multi-auth](https://github.com/imarshallwidjaja/oc-go-multi-auth) with automatic session handoff on rate limits, integrated spellcheck, and MLM compression.

![License](https://img.shields.io/github/license/BaconDroid/opencode-go-session-manager)
![GitHub last commit](https://img.shields.io/github/last-commit/BaconDroid/opencode-go-session-manager)

---

## Features

- **Auto-handoff on 429** - Automatically create a handoff when rate limit detected
- **Account rotation with cooldown** - 5-hour cooldown for OpenCode Go accounts
- **LanguageTool integration** - Auto-detect language (fr/en), spellcheck before compression
- **Caveman integration** - MLM compression (CamemBERT for French, RoBERTa for English)
- **Session ID management** - New session ID per account attempt
- **Graceful fallbacks** - Works even when LanguageTool or Caveman unavailable
- **Multi-account failover** - Retry with each remaining available Go API key
- **Persistent state** - Accounts, rotation, and handoffs survive restarts

---

## Installation

```sh
opencode plugin github:BaconDroid/opencode-go-session-manager --global
```

**Prerequisites:**
- [OpenCode](https://opencode.ai) 1.x (Go subscription)
- [Bun](https://bun.sh) 1.x (for local development)
- One or more Go API keys from [opencode.ai/auth](https://opencode.ai/auth)
- LanguageTool on port 8010 (optional)
- Caveman on port 3000 (optional)

---

## Quick Start

### 1. Get your Go API keys

Open [opencode.ai/auth](https://opencode.ai/auth) in your browser and generate one or more Go subscription API keys.

### 2. Add accounts to the plugin

In OpenCode, open the auth settings and run the **Add Go Account** method:

```
OpenCode Settings -> Auth -> Add Go Account
```

Repeat for each Go subscription you own.

### 3. Start using OpenCode

The plugin automatically:
- Picks an account on every session start
- Creates a handoff when rate limit detected
- Rotates to the next available account
- Resumes work seamlessly

---

## How It Works

### Rate Limit Handoff Flow

```
Session 1 (Account A)
    v 429 Rate Limit detected
    v Get enhanced compaction summary
    v Get messages since last compaction
    v Separate natural text from code blocks
    v Send natural text to LanguageTool (auto-detect language)
    v Send corrected text to Caveman (MLM compression)
    v Create handoff (compaction + compressed messages + file manifest)
    v Save handoff
    v Put account in cooldown (5 hours)
    v Open new session with next available account
    v Execute /handoff resume <path>
    v Continue working

Session 2 (Account B)
    v Context recovered from handoff
    v Work continues
```

### Account Selection Priority

1. **Available accounts** (not in cooldown) - use first
2. **Cooldown accounts** (sorted by earliest expiry) - try all
3. **All failed** - notify user

### Cooldown Behavior

- **OpenCode Go cooldown**: 5 hours
- **Cooldown reset**: When a cooldown account fails (429), its cooldown resets
- **Retry-after**: Respects server's retry-after header when present

---

## Configuration

Add to your `opencode.json`:

```json
{
  "opencode-go-session-manager": {
    "cooldownMs": 18000000,
    "autoHandoff": true,
    "autoResume": true,
    "tryCooldownAccounts": true,
    "maxWaitTimeMs": 300000,
    "notifyCooldown": true,
    "maxHandoffs": 10,
    "handoffRetentionDays": 7,
    "languagetoolUrl": "http://192.168.1.69:8010",
    "cavemanUrl": "http://192.168.1.69:3000"
  }
}
```

---

## Account Management

OpenCode exposes auth methods for this plugin:

| Type | Label | Purpose |
|---|---|---|
| `api` | **Add Go Account** | Add a new Go API key to the rotation pool |
| `api` | **Set Go Account Role** | Change an existing account's `primary` / `overage_fallback` role |

Use the CLI for account management:

| Command | Purpose |
|---|---|
| `opencode-go-session-manager list` | List configured accounts |
| `opencode-go-session-manager add --key <key>` | Add an account |
| `opencode-go-session-manager remove <number>` | Remove an account |

---

## Storage

Accounts, rotation state, and handoffs live in `~/.config/opencode/`:

| File | Purpose |
|---|---|
| `opencode-go-accounts.json` | Stored API keys, labels, enabled/disabled state |
| `opencode-go-rotation.json` | Last used account index |
| `handoffs/` | Handoff files with compressed session context |

---

## Error Handling

### LanguageTool Unavailable
- Skip spellcheck
- Use original text
- Log warning

### Caveman Unavailable
- Use simple compression (remove stop words)
- Log warning

### Both Unavailable
- Use original text
- Log warning
- Handoff still created

---

## Development

```sh
git clone https://github.com/BaconDroid/opencode-go-session-manager
cd opencode-go-session-manager
bun install
bun test
bun run build
bun run typecheck
```

---

## Architecture

```
┌-------------┐     ┌--------------┐     ┌----------┐
|   index.ts  |----▶|   storage.ts |----▶|  Disk    |
|  (Plugin)   |     |  (Accounts)  |     | (JSON)   |
└------┬------┘     └--------------┘     └----------┘
       |
       ├--▶ rotate.ts        -- round-robin selection
       ├--▶ fetch.ts         -- auth header injection + credential failover
       ├--▶ handoff.ts       -- handoff creation and management
       ├--▶ languagetool.ts  -- spellcheck integration
       ├--▶ caveman.ts       -- MLM compression
       ├--▶ config.ts        -- configuration management
       └--▶ types.ts         -- shared type definitions
```

---

## License

MIT
