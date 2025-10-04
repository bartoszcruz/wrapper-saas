-- ============================================================================
-- Migration 003: Fix Subscription Flow - Add missing columns and constraints
-- Date: 2025-10-04
-- Purpose: Add columns for proper grace period, pending changes, and monitoring
-- ============================================================================

-- 1. Add new columns to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS pending_plan_change BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS target_plan_id UUID REFERENCES public.plans(plan_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS last_checkout_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive';

-- 2. Add comments for new columns
COMMENT ON COLUMN public.profiles.cancel_at_period_end IS
'True if subscription is cancelled but user has access until current_period_end (grace period)';

COMMENT ON COLUMN public.profiles.pending_plan_change IS
'True if user initiated plan change and webhook has not yet confirmed it';

COMMENT ON COLUMN public.profiles.target_plan_id IS
'Target plan ID during pending plan change (null when not pending)';

COMMENT ON COLUMN public.profiles.last_checkout_at IS
'Timestamp of last checkout session creation (for rate limiting)';

COMMENT ON COLUMN public.profiles.subscription_status IS
'Raw Stripe subscription status: active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused';

-- 3. Add index for target_plan_id (FK)
CREATE INDEX IF NOT EXISTS idx_profiles_target_plan_id
ON public.profiles(target_plan_id);

-- 4. Create monitoring table for webhook alerts
CREATE TABLE IF NOT EXISTS public.webhook_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL, -- 'missing_price_id', 'webhook_delay', 'duplicate_event', 'unknown_status'
  severity TEXT NOT NULL, -- 'critical', 'warning', 'info'
  message TEXT NOT NULL,
  metadata JSONB,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- 5. Create index for webhook alerts
CREATE INDEX IF NOT EXISTS idx_webhook_alerts_severity
ON public.webhook_alerts(severity, resolved, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_alerts_type
ON public.webhook_alerts(alert_type, created_at DESC);

-- 6. RLS for webhook_alerts (admin only)
ALTER TABLE public.webhook_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage webhook alerts"
ON public.webhook_alerts
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- 7. Update existing profiles to set default subscription_status based on active
UPDATE public.profiles
SET subscription_status = CASE
  WHEN active = true THEN 'active'
  ELSE 'canceled'
END
WHERE subscription_status = 'inactive';

-- 8. Add constraint to ensure target_plan_id is set only when pending_plan_change is true
-- (Optional - we'll handle this in application logic for now)

-- 9. Success message
DO $$
BEGIN
  RAISE NOTICE '✅ Migration 003 completed: Added columns for grace period, pending changes, and monitoring';
END $$;
