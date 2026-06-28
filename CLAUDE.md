# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Homebridge dynamic platform plugin. Exposes a Komfovent Domekt unit (C4 controller + PING2 network module) to HomeKit, talking **Modbus TCP directly** (port 502) — no middleware. Published to npm as `@rnsc/homebridge-komfovent-ping2`. v0.3.0 replaced the old Python middleware with direct Modbus.

## Commands

- `npm run build` — `rimraf ./dist && tsc`, compiles `src/` → `dist/`
- `npm run lint` — `eslint . --max-warnings=0` (zero-warning gate, CI fails on any warning)
- `npm test` — `vitest run` (one-shot)
- `npm run test:watch` — `vitest` (watch)
- Single test file: `npx vitest run src/client.spec.ts`
- Single test by name: `npx vitest run -t "<test name>"`
- `npm run watch` — `npm run build && npm link && nodemon`; nodemon runs `tsc && homebridge -I -D` on `src/` change (live local Homebridge with debug)

CI (`.github/workflows/build.yml`) runs lint → build → test on Node 20/22/24. `publish.yml` publishes on tag push (tags containing `beta` go to the `beta` npm tag). `prepublishOnly` re-runs lint+test+build.

## Architecture

Four-layer plugin, registered in `src/index.ts` via `api.registerPlatform(PLATFORM_NAME, KomfoventPing2Platform)`. `PLATFORM_NAME = 'KomfoventPing2'` (`src/settings.ts`) — this is the string users put in `config.json`.

- **`platform.ts` — `KomfoventPing2Platform`**: dynamic platform. `configureAccessory()` caches restored accessories; `discoverDevices()` (on `didFinishLaunching`) generates a HomeKit UUID per `device.deviceId`, restores or registers the accessory, and instantiates one `KomfoventPing2Accessory` per device. Tracks `activeAccessories` for shutdown.

- **`platformAccessory.ts` — `KomfoventPing2Accessory`**: one per configured unit. Wires two HomeKit services:
  - **Fan** (`Active` + `RotationSpeed`) → ON/OFF and Mode-2 fan intensity
  - **TemperatureSensor** (read-only) → supply air temp
  - Polls `client.getStatus()` every `POLL_INTERVAL_MS` to push state into HomeKit.
  - `setRotationSpeed` is debounced by `SPEED_DEBOUNCE_MS` (avoid hammering Modbus while the HomeKit slider moves).
  - Clock sync runs on startup and every `CLOCK_SYNC_INTERVAL_MS` (24h).
  - `shutdown()` clears all timers + disconnects.

- **`client.ts` — `ModbusClient`**: wraps `modbus-serial`. The single most important file for behavior. Key design points:
  - **`C4_REGISTERS`** — the C4 Modbus holding-register map (e.g. `START_STOP`=1000, `VENTILATION_LEVEL`=1100 block, `SUPPLY_AIR_TEMP`=1200). All register knowledge lives here.
  - **`serialize<T>()`** — every Modbus op chains onto `operationQueue` so reads/writes never overlap on one TCP socket. Modify any I/O method → keep it inside `serialize`.
  - **`getStatus()`** — caches its promise for `STATUS_CACHE_TTL_MS`; multiple HomeKit getters in the same window share one round-trip. On any read error it drops the connection, closes the socket, and invalidates cache so the next call reconnects.
  - **Value scaling**: temps are stored ×10 in registers (`supplyAirTemp = data / 10`). `setMode2Speed` writes intake/exhaust intensity (registers 1104/1108); `setPower` writes `START_STOP`. `active` is `register === 1`.
  - `syncClock()` writes date/time registers from the Homebridge host clock; `timezone` config overrides host TZ (for Docker where host TZ may be UTC).

- **`types.ts`** — `Device` config shape; **`UnitStatus`** (in `client.ts`) — normalized status returned to the accessory layer.

## Conventions

- HomeKit identity is keyed on `deviceId` (16 chars, `[A-Za-z0-9_]`). **Never** change how the UUID is derived from `deviceId` — it would orphan users' existing accessories.
- `config.schema.json` (Homebridge UI form) must stay in sync with `types.ts`/`Device` and the README config table when adding/renaming config fields.
- Adding a new readable/writable unit feature = add the register to `C4_REGISTERS`, a read in `getStatus` (or a new serialized method), and wire a HomeKit characteristic in `platformAccessory.ts`.
- ESLint config is flat (`eslint.config.mjs`), `typescript-eslint`. Build target/output in `tsconfig.json`.

## LSP / Serena note

This repo's read-guard hook blocks `Read` on `src/*.ts` until an LSP warmup runs. Use `mcp__serena__get_symbols_overview` / `find_symbol` (Serena) to inspect code instead of raw `Read`/`cat`.
