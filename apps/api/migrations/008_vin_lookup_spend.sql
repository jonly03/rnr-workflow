-- 008: VIN lookup spend ledger.
--
-- MyGrant charges the shop $1 per VIN lookup (YMM and part-number
-- searches are free). Every paid lookup records one row here so the
-- daily spend cap is enforced against real recorded charges, not memory
-- (the API runs serverless; in-process counters would reset and leak).
-- Rows are append-only: a failed-after-submission lookup is recorded too,
-- because the $1 may have been consumed even though the result was lost.

create table if not exists vin_lookup_spend (
  id text primary key,
  vin text not null,
  glass_type text not null,
  cost_cents integer not null,
  provider text not null,
  spent_at timestamptz not null default now()
);

create index if not exists idx_vin_lookup_spend_spent_at
  on vin_lookup_spend (spent_at);

ALTER TABLE public.vin_lookup_spend ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies are intentionally defined (API-only access).
