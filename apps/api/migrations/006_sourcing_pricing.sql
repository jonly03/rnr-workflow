-- Sourcing + Pricing (Phase 3): supplier offers and pricing snapshots.

create table if not exists supplier_offers (
  id uuid primary key,
  case_id uuid not null references cases(id),
  glass_request_id uuid not null references glass_requests(id),
  supplier_name text not null,
  supplier_type text not null,
  part_number text not null,
  price_cents integer not null,
  available boolean not null,
  quantity integer not null default 0,
  lead_time_days integer,
  excluded_reason text,
  selected boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists supplier_offers_request_idx
  on supplier_offers(glass_request_id, created_at);

ALTER TABLE public.supplier_offers ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined.
-- The browser talks to the Express API; direct client Data API access is denied.

-- Pricing snapshots: the sell price is reproducible from the stored inputs
-- plus the pricing_config snapshot. Snapshots are append-only, never mutated.
create table if not exists price_calculations (
  id uuid primary key,
  case_id uuid not null references cases(id),
  glass_request_id uuid not null references glass_requests(id),
  selected_offer_id uuid references supplier_offers(id),
  glass_cost_cents integer not null,
  labor_cents integer not null,
  profit_cents integer not null,
  tax_cents integer not null,
  sell_price_cents integer not null,
  pricing_config jsonb not null default '{}'::jsonb,
  status text not null,
  created_at timestamptz not null default now()
);

create index if not exists price_calculations_request_idx
  on price_calculations(glass_request_id, created_at);

ALTER TABLE public.price_calculations ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined (API-only access).
