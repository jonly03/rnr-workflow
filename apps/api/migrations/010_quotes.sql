-- Quote + in-app sign-off (Phase 4 slice): quotes are append-only
-- (a requote supersedes by creating a new version; history is never mutated).
-- The client's signature on a quote IS the approval; there is no separate
-- invoice signature.

create table if not exists quotes (
  id uuid primary key,
  case_id uuid not null references cases(id),
  version integer not null,
  snapshot jsonb not null,
  expires_at timestamptz not null,
  status text not null,
  signature jsonb,
  created_at timestamptz not null default now(),
  unique (case_id, version)
);

create index if not exists quotes_case_idx
  on quotes(case_id, version);

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined (API-only access).
