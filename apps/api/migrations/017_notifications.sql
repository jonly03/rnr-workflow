-- Job-completion client notifications (Nelly, 2026-11-03).
--
-- When a job's service completes, the client gets a text to the phone
-- they provided: their tracking link + the ask for a Google review.
-- This table is the durable record of that send — one row per
-- (case, kind), enforced by the unique constraint, so the completion
-- notification is idempotent no matter how many times completion is
-- attempted. Delivery goes through the SMS seam in the API
-- (apps/api/src/sms.ts): the mock driver records + marks sent; the
-- Twilio driver is inert until its env vars are set.
--
-- `note` records delivery decisions a human may later need to audit —
-- e.g. that the tracker link was minted at completion time (approval
-- tokens are stored hashed, so an earlier link can never be re-sent),
-- or why a send was skipped.
--
-- Guarded/idempotent in the 012/016 style so re-runs and
-- partially-migrated databases are safe.

create table if not exists notifications (
  id uuid primary key,
  case_id uuid not null references cases(id) on delete cascade,
  channel text not null,
  kind text not null,
  to_phone text not null,
  body text not null,
  status text not null,
  provider text null,
  provider_message_id text null,
  error text null,
  note text null,
  created_at timestamptz not null default now(),
  sent_at timestamptz null,
  unique (case_id, kind)
);

create index if not exists notifications_case_idx
  on notifications (case_id, created_at desc);

alter table public.notifications enable row level security;

-- No anon/authenticated policies are intentionally defined (same posture
-- as the other Case Core tables): the browser talks to the Express API
-- only, and the API enforces access server-side.
