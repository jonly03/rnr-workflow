-- Reconcile the invoices table with the current code (migration 011).
--
-- The staging database carries an invoices table created by the
-- superseded invoice-signoff design (PR #243, applied there 2026-10-19):
-- it has two extra columns the current code never writes — `status`
-- (text NOT NULL, no default) and `signature` (jsonb). Migration 011's
-- CREATE TABLE IF NOT EXISTS was a no-op against that existing table,
-- so every saveInvoice on staging failed with:
--   null value in column "status" of relation "invoices"
--     violates not-null constraint
-- That broke the public quote-signing endpoint (500 after the signature
-- was saved; no invoice generated) and the staff generate_invoice
-- action, from 2026-10-19 until this migration.
--
-- Fix: the legacy `status` column stops being mandatory and gains the
-- default the current lifecycle implies (an invoice exists because a
-- signed quote issued it). The legacy columns themselves stay — old
-- rows keep their data; new rows simply leave `signature` null.
-- On databases created purely from migration 011 there is no `status`
-- column and this migration is a no-op.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'invoices'
      and column_name = 'status'
  ) then
    alter table invoices alter column status drop not null;
    alter table invoices alter column status set default 'ISSUED';
  end if;
end $$;
