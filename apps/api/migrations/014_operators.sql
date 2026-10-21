-- Slice A (fulfillment): operators / techs.
--
-- 1. staff_users gains the 'owner' and 'tech' roles alongside the
--    existing 'staff' / 'admin'. The role CHECK from migration 003 is
--    replaced, guarded so re-runs and partially-migrated databases are
--    safe (the 012 lesson: never assume a long-lived table's birth shape).
-- 2. password_hash becomes nullable: tech accounts are created by Google
--    Sign-In (brief §7.1) and hold no local password. Password login
--    rejects rows with a NULL hash, so existing accounts are unaffected.
-- 3. tech_profiles: one row per tech user — onboarding status,
--    qualifications (claimed vs staff-verified), availability windows,
--    and the linked Google identity.
-- 4. operator_invites: Gmail-addressed onboarding invites. Only the
--    sha256 hash of the invite credential is stored.
-- 5. jobs: the assignment record for a case (1 job per case in v1) —
--    assigned tech, schedule window, assignment mode (DIRECT now;
--    OFFERED is the later bid marketplace, designed-for only).

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'staff_users_role_check'
      and conrelid = 'public.staff_users'::regclass
  ) then
    alter table public.staff_users drop constraint staff_users_role_check;
  end if;
  alter table public.staff_users
    add constraint staff_users_role_check
    check (role in ('owner', 'admin', 'staff', 'tech'));
end $$;

alter table public.staff_users alter column password_hash drop not null;

create table if not exists tech_profiles (
  user_id uuid primary key references staff_users(id) on delete cascade,
  status text not null default 'PROFILE_PENDING'
    check (status in ('PROFILE_PENDING', 'ACTIVE', 'DEACTIVATED')),
  phone text,
  home_base text,
  service_area text,
  claimed_qualifications jsonb not null default '[]'::jsonb,
  qualifications jsonb not null default '[]'::jsonb,
  availability jsonb not null default '[]'::jsonb,
  live_status text not null default 'AVAILABLE' check (live_status in ('AVAILABLE', 'OFF')),
  location_sharing_consent boolean not null default false,
  google_sub text,
  google_refresh_credential text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists operator_invites (
  id uuid primary key,
  email text not null,
  credential_hash text not null unique,
  invited_by uuid null references staff_users(id),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists operator_invites_email_idx
  on operator_invites (lower(email));

create table if not exists jobs (
  id uuid primary key,
  case_id uuid not null unique references cases(id) on delete cascade,
  status text not null default 'UNASSIGNED' check (status in ('UNASSIGNED', 'ASSIGNED')),
  assignment_mode text not null default 'DIRECT' check (assignment_mode in ('DIRECT', 'OFFERED')),
  assigned_tech_id uuid null references staff_users(id),
  scheduled_start timestamptz null,
  scheduled_end timestamptz null,
  calendar_event_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_tech_idx on jobs (assigned_tech_id);

alter table public.tech_profiles enable row level security;
alter table public.operator_invites enable row level security;
alter table public.jobs enable row level security;

-- No anon/authenticated policies are intentionally defined (same posture
-- as staff_users): the browser talks to the Express API only.
