-- The migrate runner creates schema_migrations itself without RLS, which trips
-- Supabase's security advisor (rls_disabled_in_public). Enable RLS with no
-- permissive policies: direct PostgREST access is denied by default, while the
-- server-side pool (DATABASE_URL bypasses RLS) keeps running migrations.
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
