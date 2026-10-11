-- Phase 4b: install-appointment tracking (technician view, dispatcher map
-- monitor, client tracker). One status stream drives all three views.
--
-- Forward-compat: when the install slice lands, schedule_install creates
-- these rows for real (address captured at schedule time, geocoded via
-- Nominatim). Until then, seeded demo rows use the same shape.
create table if not exists appointments (
  id uuid primary key,
  case_id uuid not null references cases(id) on delete cascade,
  technician_id uuid references staff_users(id) on delete set null,
  technician_name text not null default '',
  service_address text not null,
  lat double precision not null,
  lng double precision not null,
  scheduled_date date not null,
  time_window text not null default '',
  customer_name text not null default '',
  status text not null default 'SCHEDULED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_appointments_date on appointments(scheduled_date);
create index if not exists idx_appointments_case on appointments(case_id);
create index if not exists idx_appointments_technician on appointments(technician_id);
