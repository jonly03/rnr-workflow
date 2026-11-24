-- Vehicle descriptor for the customer part line (Nelly, 2026-11-23).
--
-- The quote and invoice part lines mirror the customer's vehicle back
-- to them ("Glass — windshield for your 2023 Toyota bZ4X · Electric
-- SUV · AWD · 5-door · built in Japan"). The descriptor tokens are
-- composed from the VIN decode at intake and stored on the vehicle;
-- the quote snapshot freezes its own copy at quote time.
--
-- Guarded/idempotent in the 012/016 style so re-runs and
-- partially-migrated databases are safe.

alter table vehicles add column if not exists descriptor text;
