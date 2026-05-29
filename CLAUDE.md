# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
# Development
bun run start              # Electron desktop (dev)
bun run webui              # WebUI mode — no Electron window, browser connects via WebSocket
bun run server:start       # Pure Node.js server mode (no Electron)

# Build
bun run package            # Build all (electron-vite)
bun run build:server       # Build the standalone server bundle

# Quality (run before every PR)
bun run lint:fix           # Auto-fix lint (oxlint)
bun run format             # Auto-format (oxfmt)
bunx tsc --noEmit          # Type check

# Tests
bun run test               # All unit + integration tests (Vitest)
bun run test:watch         # Watch mode
bun run test:coverage      # With coverage report
vitest run tests/unit/specificTest.test.ts   # Single test file
bun run test:e2e           # Playwright E2E tests

# i18n (required when touching src/renderer/, locales/, or i18n config)
bun run i18n:types
node scripts/check-i18n.js
```

**Test file naming:** Node environment tests use `*.test.ts`; DOM/React hook tests use `*.dom.test.ts` or `*.dom.test.tsx` — Vitest runs them in separate projects with different environments.

## Architecture

AionUi is an Electron + React 19 AI cowork platform. It runs in four modes:

| Mode                      | Command         | Transport    |
| ------------------------- | --------------- | ------------ |
| Desktop                   | `start` / `cli` | Electron IPC |
| WebUI (headless Electron) | `webui`         | WebSocket    |
| Server (pure Node.js)     | `server:start`  | WebSocket    |
| Multi-instance            | `start:multi`   | Electron IPC |

### Process Boundaries

```
src/
├── index.ts              # Main process entry
├── preload/main.ts       # contextBridge — exposes window.electronAPI to renderer
├── process/              # Main process (Node.js + Electron)
│   ├── bridge/           # IPC handlers (<domain>Bridge.ts)
│   ├── services/         # Business logic (<Name>Service.ts)
│   ├── services/database/  # SQLite via better-sqlite3, schema v26, migration-based
│   ├── task/             # Agent/task managers (ACP, Gemini, NanoBot, OpenClaw, Remote)
│   ├── agent/            # AI platform process launchers
│   ├── acp/              # Agent Client Protocol runtime
│   ├── channels/         # Messaging channels (Telegram, Lark, DingTalk, WeChat, WeCom)
│   ├── team/             # Multi-agent team sessions
│   ├── webserver/        # Express + WebSocket server (JWT auth for remote access)
│   └── worker/           # Fork workers — background AI tasks, no Electron APIs
├── renderer/             # React UI (no Node.js APIs)
│   ├── pages/            # Route-level page modules
│   ├── components/       # Shared UI components
│   ├── hooks/            # Shared React hooks
│   └── services/         # Client-side services
└── common/               # Cross-process shared code
    ├── adapter/          # IPC bridge abstraction (ipcBridge.ts = typed API)
    ├── api/              # Rotating API clients (Anthropic, OpenAI, Gemini)
    └── types/            # Shared TypeScript types
```

### IPC Flow

Renderer calls `window.electronAPI.emit(name, data)` → `src/preload/main.ts` forwards via `ipcRenderer.invoke` → `src/process/bridge/*.ts` handlers respond. In WebUI/server modes the same bridge handlers are reached over WebSocket instead.

**Server mode** has 10 Electron-only bridges unavailable: `fsBridge`, `cronBridge`, `mcpBridge`, `dialogBridge`, `shellBridge`, `applicationBridge`, `windowControlsBridge`, `updateBridge`, `webuiBridge`, `notificationBridge`.

### Database

SQLite via `better-sqlite3`, current schema version **26** (`src/process/services/database/schema.ts`). Schema changes require a numbered migration in `src/process/services/database/migrations.ts`.

### Agent Backends

Multiple AI backends are supported via `src/common/api/`: Anthropic (direct + rotating), OpenAI-compatible, Gemini, AWS Bedrock. Protocol converters (`OpenAI2AnthropicConverter`, `OpenAI2GeminiConverter`) normalize third-party agents to the internal ACP format.
