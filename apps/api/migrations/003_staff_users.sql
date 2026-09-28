create table if not exists staff_users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  role text not null default 'staff' check (role in ('staff', 'admin')),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists staff_users_email_idx on staff_users (lower(email));

ALTER TABLE public.staff_users ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined.
-- The browser talks to the Express API; direct client Data API access is denied.
