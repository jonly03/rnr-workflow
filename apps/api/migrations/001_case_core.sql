create sequence if not exists case_reference_seq start 1;

create table if not exists customers (
  id uuid primary key,
  created_at timestamptz not null default now()
);

create table if not exists vehicles (
  id uuid primary key,
  year integer not null,
  make text not null,
  model text not null,
  vin text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists cases (
  id uuid primary key,
  reference text not null unique,
  channel text not null check (channel in ('DIRECT','AUCTION','INSURANCE')),
  current_state text not null,
  customer_id uuid null references customers(id),
  vehicle_id uuid not null references vehicles(id),
  glass_request_id uuid not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  version integer not null default 1
);

create table if not exists glass_requests (
  id uuid primary key,
  case_id uuid not null unique references cases(id) on delete cascade,
  glass_type text not null check (glass_type in ('WINDSHIELD','BACK_GLASS','DOOR_GLASS','QUARTER_GLASS','VENT_GLASS')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

do $casecore$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cases_glass_request_fk'
      and conrelid = 'public.cases'::regclass
  ) then
    alter table public.cases
      add constraint cases_glass_request_fk
      foreign key (glass_request_id)
      references public.glass_requests(id)
      deferrable initially deferred;
  end if;
end
$casecore$;

create table if not exists case_events (
  id uuid primary key,
  case_id uuid not null references cases(id) on delete cascade,
  sequence bigint not null,
  event_type text not null,
  occurred_at timestamptz not null,
  actor_type text not null,
  actor_id text null,
  payload jsonb not null default '{}'::jsonb,
  corrects_event_id uuid null references case_events(id),
  unique(case_id, sequence)
);

create table if not exists case_create_idempotency (
  idempotency_key text primary key,
  case_id uuid not null references cases(id) on delete cascade,
  created_at timestamptz not null
);

create index if not exists idx_cases_updated_at on cases(updated_at desc);
create index if not exists idx_case_events_case_sequence on case_events(case_id, sequence);
