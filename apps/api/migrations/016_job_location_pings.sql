-- Slice C (fulfillment): live tracking — job location pings.
--
-- A ping is one position report from the assigned tech's device,
-- accepted ONLY while their job is IN_PROGRESS and their profile
-- carries location-sharing consent (enforced server-side in the API;
-- this table is just the record). Pings are deliberately NOT case
-- events: at one report every ~45s they would flood the case log and
-- the realtime fan-out. The staff ops map reads the latest ping per
-- job from here; the client tracker never reads this table at all —
-- it gets a computed ETA summary, never coordinates (brief §3.4).
--
-- Guarded/idempotent in the 012 style so re-runs and
-- partially-migrated databases are safe.

create table if not exists job_location_pings (
  id uuid primary key,
  job_id uuid not null references jobs(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  tech_id uuid not null,
  lat double precision not null,
  lon double precision not null,
  accuracy_m double precision null,
  recorded_at timestamptz not null default now()
);

-- "Latest ping per job" is the hot read (ops map + client ETA).
create index if not exists job_location_pings_job_time_idx
  on job_location_pings (job_id, recorded_at desc);

create index if not exists job_location_pings_case_idx
  on job_location_pings (case_id, recorded_at desc);

alter table public.job_location_pings enable row level security;

-- No anon/authenticated policies are intentionally defined (same posture
-- as the other Case Core tables): the browser talks to the Express API
-- only, and the API enforces the location law server-side.
