-- ============================================================================
-- Migration: Idempotency, Cleanup, and RLS Enforcement
-- ============================================================================

-- 1. Ensure UNIQUE constraint on webhook_events.event_id (idempotency)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_events_event_id_key'
  ) THEN
    ALTER TABLE public.webhook_events
    ADD CONSTRAINT webhook_events_event_id_key UNIQUE (event_id);

    RAISE NOTICE 'Added UNIQUE constraint on webhook_events.event_id';
  ELSE
    RAISE NOTICE 'UNIQUE constraint on webhook_events.event_id already exists';
  END IF;
END $$;

-- 2. Cleanup orphaned/unconfirmed users (older than 7 days)
-- Run this periodically or as one-time cleanup
DELETE FROM auth.users
WHERE confirmed_at IS NULL
  AND created_at < NOW() - INTERVAL '7 days'
  AND deleted_at IS NULL;

-- Log cleanup
DO $$
DECLARE
  deleted_count INT;
BEGIN
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Cleaned up % unconfirmed users', deleted_count;
END $$;

-- 3. Enforce RLS on profiles (ensure policies exist)
-- Profiles: users can only access their own data
DO $$
BEGIN
  -- Enable RLS if not already
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

  -- SELECT policy
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles'
    AND policyname = 'Users can view own profile'
  ) THEN
    CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);
  END IF;

  -- INSERT policy
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles'
    AND policyname = 'Users can insert own profile'
  ) THEN
    CREATE POLICY "Users can insert own profile"
    ON public.profiles FOR INSERT
    WITH CHECK (auth.uid() = id);
  END IF;

  -- UPDATE policy
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles'
    AND policyname = 'Users can update own profile'
  ) THEN
    CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);
  END IF;

  RAISE NOTICE 'RLS policies enforced on profiles';
END $$;

-- 4. Enforce RLS on plans (public read-only)
DO $$
BEGIN
  ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plans'
    AND policyname = 'Anyone can view plans'
  ) THEN
    CREATE POLICY "Anyone can view plans"
    ON public.plans FOR SELECT
    USING (true);
  END IF;

  RAISE NOTICE 'RLS policies enforced on plans';
END $$;

-- 5. Ensure indexes exist for performance
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_subscription
ON public.profiles(stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer
ON public.profiles(stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_profiles_plan_id
ON public.profiles(plan_id);

-- 6. Add helpful comments
COMMENT ON COLUMN public.profiles.active IS 'True if subscription is active and renewing. False if cancelled but may still have access until current_period_end.';
COMMENT ON COLUMN public.profiles.current_period_end IS 'End date of current billing period. User has access until this date even if active=false (grace period).';
COMMENT ON COLUMN public.profiles.plan_used IS 'Number of generations used in current billing period. Reset to 0 on invoice.payment_succeeded.';

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✅ Migration 002 completed: Idempotency, cleanup, RLS enforcement';
END $$;
