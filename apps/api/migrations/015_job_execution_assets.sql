-- Slice B (fulfillment): job execution + case assets.
--
-- 1. jobs.status gains the execution states: a job is IN_PROGRESS from
--    the tech's first checklist step and COMPLETED at finish. The CHECK
--    from migration 014 is replaced, guarded so re-runs and
--    partially-migrated databases are safe (the 012 lesson).
-- 2. job_step_events: the append-only checklist record on a job
--    (brief §3.3). Granular steps live here; case state stays coarse.
-- 3. case_assets: the per-case file registry (brief §7.3) — metadata
--    + visibility class for every stored file. Bytes live in object
--    storage (S3 in production, a local driver in dev/test); this table
--    stores the storage key, never a URL.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'jobs_status_check'
      and conrelid = 'public.jobs'::regclass
  ) then
    alter table public.jobs drop constraint jobs_status_check;
  end if;
  alter table public.jobs
    add constraint jobs_status_check
    check (status in ('UNASSIGNED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'));
end $$;

create table if not exists job_step_events (
  id uuid primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  step text not null,
  actor_type text not null,
  actor_id uuid null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists job_step_events_job_idx
  on job_step_events (job_id, occurred_at);

create index if not exists job_step_events_case_idx
  on job_step_events (case_id, occurred_at);

create table if not exists case_assets (
  id uuid primary key,
  case_id uuid not null references cases(id) on delete cascade,
  job_id uuid null references jobs(id) on delete set null,
  kind text not null check (kind in (
    'INTAKE_PHOTO', 'BEFORE_PHOTO', 'AFTER_PHOTO',
    'INVOICE_PDF', 'SIGNED_QUOTE', 'OTHER'
  )),
  visibility text not null check (visibility in (
    'CLIENT_VISIBLE', 'TECH_VISIBLE', 'INTERNAL'
  )),
  storage_driver text not null,
  storage_key text not null,
  filename text not null,
  content_type text not null,
  size_bytes bigint not null default 0,
  status text not null default 'PENDING' check (status in ('PENDING', 'READY')),
  uploaded_by_type text not null,
  uploaded_by_id uuid null,
  created_at timestamptz not null default now()
);

create index if not exists case_assets_case_idx
  on case_assets (case_id, created_at);

create index if not exists case_assets_job_idx
  on case_assets (job_id, created_at);

alter table public.job_step_events enable row level security;
alter table public.case_assets enable row level security;

-- No anon/authenticated policies are intentionally defined (same posture
-- as the other Case Core tables): the browser talks to the Express API
-- only, and the API enforces the asset visibility law server-side.
