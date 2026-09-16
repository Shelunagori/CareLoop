-- CareLoop — frozen schema (M0)
-- Source of truth: docs/02-data-model.md, plus corrections R1–R8, F1–F6, E1–E3.
-- Behaviour belongs to later milestones; this file encodes structure only.

create schema if not exists extensions;

-- pgvector: used by exactly ONE column, episodes.embedding (D5 / R2).
-- There is deliberately no entity embedding: entity resolution is exact →
-- alias → relationship-role → (optional trigram later) → ask.
create extension if not exists vector with schema extensions;

-- pg_trgm is intentionally NOT enabled. It is only needed for the optional
-- fuzzy step 4 of entity resolution (docs/02 §5.1), which V1 does not build.

-- ---------------------------------------------------------------------------
-- Enumerations — canonical vocabulary (F5). Do not invent alternative names.
-- ---------------------------------------------------------------------------
create type public.conversation_channel  as enum ('text', 'voice');
create type public.message_role          as enum ('user', 'assistant', 'system');
create type public.message_modality      as enum ('text', 'voice');

create type public.entity_type           as enum ('person', 'pet', 'place', 'org');
create type public.entity_status         as enum ('active', 'needs_confirmation', 'merged_into');
create type public.evidence_status       as enum ('candidate', 'confirmed');

create type public.time_precision        as enum ('exact', 'day', 'week', 'unknown');

-- V1 extracts 'visit' and 'call' only; the wider set is declared so the column
-- and detectors have the right shape (docs/02 §7).
create type public.event_type            as enum ('visit', 'call', 'message', 'mention', 'outing');
create type public.event_polarity        as enum ('positive', 'absence');

-- NO_BASELINE = insufficient historical evidence
-- IRREGULAR    = sufficient evidence, no stable rhythm
-- ACTIVE       = sufficient evidence and a regular rhythm
-- (DORMANT is deliberately absent — R4.)
create type public.baseline_status       as enum ('NO_BASELINE', 'IRREGULAR', 'ACTIVE');

create type public.signal_type           as enum ('cadence_gap', 'user_asserted_absence');
create type public.signal_status         as enum ('detected', 'materialized', 'suppressed');

create type public.opportunity_status    as enum ('proposed', 'drafted', 'offered',
                                                  'approved', 'consumed', 'declined', 'expired');
create type public.family_request_status as enum ('pending', 'delivered', 'answered', 'expired');

create type public.job_kind              as enum ('ingest');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  display_name        text,
  -- What family members see this person called, e.g. "Dad".
  -- SharePayload.fromDisplayName (docs/04 §11.4).
  family_display_name text,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Conversation
-- ---------------------------------------------------------------------------
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  channel    public.conversation_channel not null default 'text'
);
create index conversations_user_started_idx on public.conversations (user_id, started_at desc);

-- No user_id: ownership is reached through conversations.user_id (see RLS).
create table public.messages (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references public.conversations (id) on delete cascade,
  role                  public.message_role not null,
  content               text not null,
  -- Voice headroom (docs/05 §15). Null for the whole of V1.
  modality              public.message_modality not null default 'text',
  audio_url             text,
  transcript_confidence numeric check (transcript_confidence between 0 and 1),
  created_at            timestamptz not null default now()
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Observations — immutable raw LLM output. The audit log and replay source.
-- Nothing here is a belief; a policy function decides what becomes one.
-- ---------------------------------------------------------------------------
create table public.observations (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  source_message_id uuid not null references public.messages (id) on delete cascade,
  kind              text not null,
  payload           jsonb not null,
  confidence        numeric check (confidence between 0 and 1),
  source_span       text,
  model             text,
  prompt_id         text,
  created_at        timestamptz not null default now(),
  processed_at      timestamptz,
  resolution        jsonb
);
create index observations_user_created_idx on public.observations (user_id, created_at desc);
create index observations_source_message_idx on public.observations (source_message_id);

-- ---------------------------------------------------------------------------
-- Structured memory
-- entity.type = what a thing IS; relationship.kind = how two things RELATE (R1)
-- ---------------------------------------------------------------------------
create table public.entities (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  type             public.entity_type not null,
  -- Freeform, descriptive only, nothing branches on it: 'dog'. Never a relationship kind.
  subtype          text,
  display_name     text not null,
  aliases          text[] not null default '{}',
  first_seen_at    timestamptz not null default now(),
  last_mentioned_at timestamptz,
  mention_count    integer not null default 0,
  status           public.entity_status not null default 'active'
);
-- Supports resolution step 1 (normalized exact match) without a vector in sight.
create index entities_user_name_idx on public.entities (user_id, lower(display_name));
create index entities_aliases_idx on public.entities using gin (aliases);

create table public.relationships (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  -- NULL means "the user themself" (docs/02 §4.1 from_ref('user'|entity_id)).
  from_entity_id    uuid references public.entities (id) on delete cascade,
  to_entity_id      uuid not null references public.entities (id) on delete cascade,
  kind              text not null,
  label_raw         text,
  confidence        numeric check (confidence between 0 and 1),
  evidence_count    integer not null default 0,
  status            public.evidence_status not null default 'candidate',
  first_observed_at timestamptz not null default now(),
  last_confirmed_at timestamptz,
  constraint relationships_no_self_edge
    check (from_entity_id is null or from_entity_id <> to_entity_id)
);
-- One edge per (subject, object, kind); evidence_count increments in place.
create unique index relationships_unique_edge_idx on public.relationships (
  user_id,
  coalesce(from_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
  to_entity_id,
  kind
);

create table public.facts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  -- NULL means the fact is about the user themself.
  subject_entity_id     uuid references public.entities (id) on delete cascade,
  key                   text not null,
  value                 jsonb not null,
  confidence            numeric check (confidence between 0 and 1),
  evidence_count        integer not null default 0,
  status                public.evidence_status not null default 'candidate',
  source_observation_ids uuid[] not null default '{}',
  created_at            timestamptz not null default now()
);
create unique index facts_unique_key_idx on public.facts (
  user_id,
  coalesce(subject_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
  key
);

-- ---------------------------------------------------------------------------
-- Episodic memory — the ONLY pgvector column in the system
-- ---------------------------------------------------------------------------
create table public.episodes (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  summary               text not null,
  -- Resolved absolute time, never relative language (docs/02 §6).
  occurred_at           timestamptz not null,
  occurred_at_precision public.time_precision not null,
  salience              numeric not null default 0 check (salience between 0 and 1),
  embedding             extensions.vector(1536),
  source_message_ids    uuid[] not null default '{}',
  created_at            timestamptz not null default now()
);
create index episodes_user_occurred_idx on public.episodes (user_id, occurred_at desc);
-- HNSW rather than IVFFlat: no training pass, so it behaves correctly on an
-- empty table — which is every new CareLoop user (docs/02 §4.2).
create index episodes_embedding_idx on public.episodes
  using hnsw (embedding extensions.vector_cosine_ops);

-- F4: real FKs, not an array column. The one place entity references could
-- otherwise dangle after an entity is deleted.
create table public.episode_entities (
  episode_id uuid not null references public.episodes (id) on delete cascade,
  entity_id  uuid not null references public.entities (id) on delete cascade,
  primary key (episode_id, entity_id)
);
create index episode_entities_entity_idx on public.episode_entities (entity_id);

-- ---------------------------------------------------------------------------
-- Event spine — everything the pattern engine sees comes from here
-- ---------------------------------------------------------------------------
create table public.interaction_events (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  entity_id             uuid not null references public.entities (id) on delete cascade,
  event_type            public.event_type not null,
  -- When it HAPPENED.
  occurred_at           timestamptz not null,
  occurred_at_precision public.time_precision not null,
  -- When the user SAID it. Collapsing these two makes both metrics wrong.
  reported_at           timestamptz not null default now(),
  certainty             numeric not null check (certainty between 0 and 1),
  polarity              public.event_polarity not null default 'positive',
  window_start          timestamptz,
  window_end            timestamptz,
  source_episode_id     uuid references public.episodes (id) on delete set null,
  source_observation_id uuid references public.observations (id) on delete set null,
  -- R6: idempotency of INGESTION, not statistical normalization. Two genuine
  -- calls on the same day are two rows; computeBaseline() collapses per day.
  ingest_fingerprint    text not null,
  created_at            timestamptz not null default now(),
  -- An absence assertion is evidence of non-occurrence OVER A WINDOW (D6).
  constraint interaction_events_absence_needs_window
    check (polarity <> 'absence' or (window_start is not null and window_end is not null))
);
create unique index interaction_events_ingest_idx
  on public.interaction_events (user_id, ingest_fingerprint);
create index interaction_events_cadence_idx
  on public.interaction_events (user_id, entity_id, event_type, occurred_at desc);

create table public.baselines (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  entity_id           uuid not null references public.entities (id) on delete cascade,
  event_type          public.event_type not null,
  status              public.baseline_status not null,
  cadence_days_median numeric,
  cadence_days_mad    numeric,
  observation_count   integer not null default 0,
  window_start        timestamptz,
  window_end          timestamptz,
  -- Machine-readable gate failures, e.g. [{"code":"INSUFFICIENT_EVENTS","have":2,"need":4}]
  reasons             jsonb not null default '[]'::jsonb,
  method_version      text not null,
  -- Reproducibility: a baseline you cannot recompute is a rumour, not evidence.
  inputs_hash         text not null,
  computed_at         timestamptz not null default now(),
  constraint baselines_active_requires_statistics
    check (status <> 'ACTIVE' or (cadence_days_median is not null and cadence_days_mad is not null))
);
create unique index baselines_unique_idx on public.baselines (user_id, entity_id, event_type);

-- ---------------------------------------------------------------------------
-- Detection → consent → family loop
-- ---------------------------------------------------------------------------
create table public.signals (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  entity_id          uuid not null references public.entities (id) on delete cascade,
  baseline_id        uuid references public.baselines (id) on delete set null,
  signal_type        public.signal_type not null,
  score              numeric,
  -- Structured derivation, never prose.
  explanation        jsonb not null,
  detected_at        timestamptz not null default now(),
  status             public.signal_status not null default 'detected',
  suppression_reason text,
  materialized_at    timestamptz,
  constraint signals_suppressed_needs_reason
    check (status <> 'suppressed' or suppression_reason is not null)
);
create index signals_user_detected_idx on public.signals (user_id, detected_at desc);

create table public.reconnect_opportunities (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  signal_id          uuid not null references public.signals (id) on delete cascade,
  entity_id          uuid not null references public.entities (id) on delete cascade,
  proposal           jsonb not null,
  -- Minimized, whitelisted fields only.
  share_payload      jsonb,
  -- R3/F1: rendered, guarded, stored and hashed BEFORE the user is asked.
  rendered_text      text,
  rendered_text_hash text,
  status             public.opportunity_status not null default 'proposed',
  offered_at         timestamptz,
  resolved_at        timestamptz,
  -- F2: governs OFFERABILITY, pre-approval only.
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  -- Structural form of "the draft exists before it can be offered".
  constraint opportunities_offerable_requires_draft check (
    status in ('proposed', 'declined', 'expired')
    or (share_payload is not null and rendered_text is not null and rendered_text_hash is not null)
  )
);
-- F3: one signal → at most one opportunity. Enforced here, NOT by cooldowns.
create unique index reconnect_opportunities_signal_idx
  on public.reconnect_opportunities (signal_id);
create index reconnect_opportunities_open_idx
  on public.reconnect_opportunities (user_id, entity_id, status);

-- Deliberately no status column: state is derived from these four timestamps
-- by one pure function, so it cannot drift out of sync with them (F5).
create table public.consent_grants (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  opportunity_id         uuid not null references public.reconnect_opportunities (id) on delete cascade,
  scope                  jsonb not null,
  payload_snapshot       jsonb not null,
  -- Exactly what the user was shown, and its hash, copied — never regenerated.
  rendered_text_snapshot text not null,
  rendered_text_hash     text not null,
  granting_message_id    uuid references public.messages (id) on delete set null,
  granted_at             timestamptz not null default now(),
  -- F2: 72h authority to EXECUTE the send. Irrelevant once used_at is set.
  expires_at             timestamptz not null,
  used_at                timestamptz,
  revoked_at             timestamptz
);
-- One grant per opportunity: an expired grant expires the opportunity too,
-- and a fresh ask needs a fresh signal → opportunity → draft (F2).
create unique index consent_grants_opportunity_idx on public.consent_grants (opportunity_id);

-- Identity only. Holds no capability token (R7).
create table public.family_contacts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  entity_id    uuid not null references public.entities (id) on delete cascade,
  channel      text not null,
  address      text not null,
  display_name text,
  created_at   timestamptz not null default now()
);
create unique index family_contacts_unique_idx
  on public.family_contacts (user_id, entity_id, channel, address);

-- No user_id: ownership is reached through opportunity_id (see RLS).
create table public.family_requests (
  id                 uuid primary key default gen_random_uuid(),
  opportunity_id     uuid not null references public.reconnect_opportunities (id) on delete cascade,
  contact_id         uuid not null references public.family_contacts (id) on delete restrict,
  -- Copied byte-for-byte from the consent grant. Never generated here.
  rendered_body      text not null,
  rendered_body_hash text not null,
  payload            jsonb not null,
  -- R7: the capability lives on the request, one token per approved sentence.
  access_token_hash  text not null,
  -- F2: read/respond window for one recipient. Runs from CREATION, not delivery.
  token_expires_at   timestamptz not null,
  status             public.family_request_status not null default 'pending',
  -- E3: delivery happens OUTSIDE the creation transaction; failure retries the
  -- same row, same bytes, same token, and never re-consumes consent.
  delivery_attempts  integer not null default 0,
  last_delivery_error text,
  created_at         timestamptz not null default now(),
  delivered_at       timestamptz,
  opened_at          timestamptz,
  constraint family_requests_delivered_needs_timestamp
    check (status <> 'delivered' or delivered_at is not null)
);
-- E3: one approved opportunity → at most one family request.
create unique index family_requests_opportunity_idx on public.family_requests (opportunity_id);
create unique index family_requests_token_idx on public.family_requests (access_token_hash);

create table public.family_responses (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.family_requests (id) on delete cascade,
  raw_body    text not null,
  parsed      jsonb,
  received_at timestamptz not null default now()
);
create index family_responses_request_idx on public.family_responses (request_id);

-- A promise made to the older adult is a persisted obligation, not something
-- the model is trusted to remember (docs/04 §12.3).
create table public.closures (
  id                  uuid primary key default gen_random_uuid(),
  opportunity_id      uuid not null references public.reconnect_opportunities (id) on delete cascade,
  response_id         uuid not null references public.family_responses (id) on delete cascade,
  surfaced_message_id uuid references public.messages (id) on delete set null,
  surfaced_at         timestamptz,
  created_at          timestamptz not null default now()
);
create unique index closures_response_idx on public.closures (response_id);

-- ---------------------------------------------------------------------------
-- R8: durable post-turn work. Committed BEFORE the in-process attempt, so a
-- reclaimed serverless runtime leaves a pending row a later request drains.
-- No queue, no Redis, no cron.
-- ---------------------------------------------------------------------------
create table public.jobs (
  id           uuid primary key default gen_random_uuid(),
  kind         public.job_kind not null,
  -- For kind='ingest' this is the assistant message id.
  key          text not null,
  payload      jsonb,
  attempts     integer not null default 0,
  last_error   text,
  run_after    timestamptz not null default now(),
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);
create unique index jobs_kind_key_idx on public.jobs (kind, key);
create index jobs_pending_idx on public.jobs (run_after) where completed_at is null;
