ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.glass_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_create_idempotency ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are intentionally defined for Case Core v0.1.
-- The browser talks to the Express API; direct client Data API access is denied.
