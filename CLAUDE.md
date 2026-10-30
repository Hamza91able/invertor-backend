# CLAUDE.md

Guidance for Claude Code and any agent working in this repo.

Backend for talking to a solar inverter through its Solarman (IGEN LSW-3) WiFi
stick logger over the LAN — Solarman V5 protocol on TCP 8899, wrapping Modbus RTU.

**Start here:** if `notes/system.md` exists, read it first — private (git-ignored)
notes on the system, verified registers, settings, energy stats, and decisions.
This repo is public: never commit serials, IPs, keys, or personal data.

## Architecture — MUST FOLLOW

Structured **by self-contained components**, not by technical role (same pattern
as expenser-backend).

- Business features live in `src/components/<feature>/`; generic capability lives in
  `src/libraries/<name>/`.
- Each component/library is imported only through its `index.ts` (public interface) —
  never reach into another unit's internal files.
- Components own their route prefix and register as Fastify plugins via `app.ts`.
  Do not add top-level `controllers/`, `services/`, `models/`, `routes/`, or
  `plugins/` folders.
- New feature = new folder under `components/`, with `*.api.ts` / `*.service.ts` /
  `*.schema.ts` / `*.data.ts` layer files added only as needed (YAGNI).

## Stack

TypeScript · Fastify 5 · zod · winston/pino · pnpm · ESM (`NodeNext`).

## Commands

- `pnpm dev` — watch/run (`src/server.ts`)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm build` — `tsc`

## Verify before claiming done

Run `pnpm typecheck` and boot-smoke affected routes (`pnpm dev` + curl). Report
actual output.
