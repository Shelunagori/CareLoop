# CareLoop

A long-term conversational companion for older adults. It learns the people and
routines that matter to someone, notices observable changes, and — only with
explicit consent — helps them reconnect with family.

The architecture is frozen. The decision record is `docs/00-overview.md`
(D1–D8, R1–R8, F1–F6, E1–E3); read that before changing anything structural.

## Status

**M0 — scaffold, schema and boundaries.** No product behaviour yet.

## Setup

```bash
npm install
cp .env.example .env.local     # fill in Supabase values
npm run dev
```

## Database

Migrations live in `supabase/migrations/` and are the frozen schema in SQL.

```bash
npm run db:start    # local Supabase (requires Docker)
npm run db:reset    # re-apply all migrations
npm run db:types    # regenerate server/db/types.generated.ts
```

## Checks

```bash
npm run lint        # includes the core/ purity boundary
npm run typecheck
npm run build
```

## Layout

| Path | What lives here |
|---|---|
| `app/` | Routes and UI. Depends on `server/services`, never on repositories directly. |
| `core/` | Pure domain: baselines, detection, consent, safety guards, minimization. No I/O, no framework, no database — enforced by ESLint. |
| `server/services/` | Use-cases that compose repositories, adapters and `core`. |
| `server/repositories/` | Typed Postgres access, one per aggregate. |
| `server/adapters/` | Ports: LLM, embeddings, voice, clock, notifier. |
| `server/prompts/` | Versioned prompt files; a prompt change is a behaviour change. |
| `server/db/` | Supabase client seam and generated types. |
| `supabase/migrations/` | Schema and RLS. |
| `fixtures/`, `scripts/` | Demo timeline and the seeder that replays it through the production pipeline. |
| `tests/` | `unit` (pure core), `golden` (recorded extraction), `e2e`. |

Dependency direction: `app → server/services → repositories/adapters → core`.
