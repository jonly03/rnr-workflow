-- Approval tokens for scoped, expiring, single-use external access
-- (e.g. a customer approving a quote via a link, without a staff session).

create table if not exists approval_tokens (
  jti uuid primary key,
  case_id uuid not null references cases(id),
  channel text not null,
  purpose text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists approval_tokens_case_idx on approval_tokens(case_id);
create index if not exists approval_tokens_hash_idx on approval_tokens(token_hash);

ALTER TABLE public.approval_tokens ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined.
-- The browser talks to the Express API; direct client Data API access is denied.

-- Channel-scoped staff: staff_users.channels is a JSON array of channel codes
-- a staff member may access. NULL/absent means all channels (full access).
alter table public.staff_users
  add column if not exists channels jsonb;
