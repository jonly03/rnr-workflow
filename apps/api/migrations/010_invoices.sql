-- Invoice + in-app sign-off (Phase 4 slice): invoices are append-only
-- (re-invoicing creates a new version; history is never mutated).

create table if not exists invoices (
  id uuid primary key,
  case_id uuid not null references cases(id),
  version integer not null,
  actuals jsonb not null,
  status text not null,
  signature jsonb,
  created_at timestamptz not null default now(),
  unique (case_id, version)
);

create index if not exists invoices_case_idx
  on invoices(case_id, version);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined (API-only access).
