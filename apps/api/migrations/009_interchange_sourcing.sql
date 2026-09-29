-- 009: Interchange cheapest-wins sourcing.
--
-- MyGrant VIN results carry "Interchangeables:" lists. Sourcing must price
-- the primary part plus every interchange and pick the cheapest in-stock
-- offer (interchanges are often cheaper, sometimes pricier MOPAR/OEM).
-- The full offer set stays visible (primary vs interchange) so staff can
-- override the system pick when a job needs the OEM part.
--
-- glass_identifications gains the interchange list from the VIN result
-- (JSONB, empty by default for pre-existing rows). supplier_offers gains
-- is_interchange so offers for interchange part numbers are labeled.

alter table if exists glass_identifications
  add column if not exists interchange_part_numbers jsonb not null default '[]'::jsonb;

alter table if exists supplier_offers
  add column if not exists is_interchange boolean not null default false;
