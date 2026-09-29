-- 007: per-glass-type VIN lookup cache + single-flight claims.
--
-- The vin_lookups cache previously stored one result per VIN, and the mock
-- provider only ever produced Windshield candidates -- so a cached result
-- could be served to the wrong glass type. The cache now holds one row per
-- VIN with per-glass-type results under result->'glassTypes'.
-- Existing rows are migrated honestly: every result produced before this
-- migration came from the Windshield-only provider, so they map to
-- the WINDSHIELD slot.

update vin_lookups
set result = jsonb_build_object(
  'glassTypes',
  jsonb_build_object(
    'WINDSHIELD',
    jsonb_build_object(
      'success', success,
      'decoded', coalesce(result->'decoded', 'null'::jsonb),
      'candidates', coalesce(result->'candidates', '[]'::jsonb),
      'error', result->'error'
    )
  )
);

-- Single-flight claims for paid VIN lookups: exactly one caller may hold
-- the claim for a (vin, glass_type) pair, so concurrent requests cannot
-- trigger duplicate charges. Stale claims (> 5 minutes) may be stolen.
create table if not exists vin_lookup_claims (
  vin text not null,
  glass_type text not null,
  claimed_at timestamptz not null default now(),
  primary key (vin, glass_type)
);

ALTER TABLE public.vin_lookup_claims ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies are intentionally defined (API-only access).
