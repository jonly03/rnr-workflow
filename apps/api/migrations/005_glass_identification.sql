-- Glass Identification (Phase 2): persisted identification runs and VIN cache.

create table if not exists glass_identifications (
  id uuid primary key,
  case_id uuid not null references cases(id),
  glass_request_id uuid not null references glass_requests(id),
  method text not null,
  status text not null,
  provider text not null,
  candidates jsonb not null default '[]'::jsonb,
  selected_candidate jsonb,
  created_at timestamptz not null default now()
);

create index if not exists glass_identifications_request_idx
  on glass_identifications(glass_request_id, created_at);

ALTER TABLE public.glass_identifications ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined.
-- The browser talks to the Express API; direct client Data API access is denied.

-- VIN lookup cache: a successful VIN result is reused, never repurchased.
create table if not exists vin_lookups (
  id uuid primary key,
  vin text not null unique,
  success boolean not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

ALTER TABLE public.vin_lookups ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined (API-only access).
