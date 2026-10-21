-- Invoice payment lifecycle (Fulfillment Slice D).
--
-- Invoices gain a payment state machine on the invoice record itself:
--   UNSENT -> SENT -> PAID, with DISPUTED reachable from SENT and UNSENT,
--   DISPUTED -> SENT (re-sent after resolution) and DISPUTED -> PAID.
-- When the latest invoice is PAID, its case may close (and auto-closes
-- when the service is already complete).
--
-- The blow-by-blow (sends, dispute openings/updates, resolutions,
-- payments) is an append-only thread in invoice_events, mirroring the
-- case_events pattern. Dispute updates append; nothing is edited.
--
-- Guarded in the style of 012: every statement is a no-op on a database
-- where it has already run, so the migration is safe to re-apply.
-- Note: the legacy `status` column from the superseded #243 design (see
-- 012) is untouched; the payment lifecycle lives in `payment_status`.

alter table invoices
  add column if not exists payment_status text not null default 'UNSENT';
alter table invoices
  add column if not exists sent_at timestamptz;
alter table invoices
  add column if not exists sent_via text;
alter table invoices
  add column if not exists sent_to text;
alter table invoices
  add column if not exists paid_at timestamptz;
alter table invoices
  add column if not exists paid_method text;
alter table invoices
  add column if not exists paid_ref text;
alter table invoices
  add column if not exists paid_by text;
alter table invoices
  add column if not exists dispute_reason_code text;
alter table invoices
  add column if not exists dispute_reason text;
alter table invoices
  add column if not exists disputed_at timestamptz;
alter table invoices
  add column if not exists dispute_resolution text;
alter table invoices
  add column if not exists dispute_resolved_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_payment_status_check'
  ) then
    alter table invoices
      add constraint invoices_payment_status_check
      check (payment_status in ('UNSENT', 'SENT', 'DISPUTED', 'PAID'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_dispute_resolution_check'
  ) then
    alter table invoices
      add constraint invoices_dispute_resolution_check
      check (dispute_resolution is null or dispute_resolution in
        ('RESOLVED_PAID', 'RESOLVED_ADJUSTED', 'RESOLVED_WRITTEN_OFF'));
  end if;
end $$;

create index if not exists invoices_payment_status_idx
  on invoices(payment_status);

create table if not exists invoice_events (
  id uuid primary key,
  invoice_id uuid not null references invoices(id),
  case_id uuid not null references cases(id),
  kind text not null,
  actor_type text not null,
  actor_id text,
  note text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists invoice_events_invoice_idx
  on invoice_events(invoice_id, created_at);

create index if not exists invoice_events_case_idx
  on invoice_events(case_id, created_at);

ALTER TABLE public.invoice_events ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined (API-only access).
