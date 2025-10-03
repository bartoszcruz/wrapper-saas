-- ============================================================================
-- REPAIR SCRIPT: Fix users incorrectly downgraded to Basic
-- ============================================================================
-- Bug: customer.subscription.deleted downgraded users immediately
-- instead of waiting for period end, and didn't reset plan_used
-- ============================================================================

-- STEP 1: Find affected users (Basic plan with excessive usage)
-- These are likely Pro/Agency users who were incorrectly downgraded
SELECT
  p.id,
  p.email,
  pl.name as current_plan,
  pl.monthly_limit as plan_limit,
  p.plan_used,
  p.active,
  p.stripe_subscription_id,
  p.current_period_end
FROM profiles p
LEFT JOIN plans pl ON p.plan_id = pl.plan_id
WHERE pl.name = 'basic'
  AND p.plan_used > pl.monthly_limit  -- Usage exceeds Basic limit
ORDER BY p.plan_used DESC;

-- STEP 2: Reset plan_used for users downgraded to Basic
-- This fixes the "100/50" display bug
UPDATE profiles
SET plan_used = 0
WHERE plan_id IN (SELECT plan_id FROM plans WHERE name = 'basic')
  AND plan_used > 50;  -- Basic limit is 50

-- STEP 3: For users who should still have Pro/Agency access
-- (check Stripe Dashboard first to see if their subscription is actually active)
-- Example: Restore Pro for specific user
/*
UPDATE profiles
SET
  plan_id = (SELECT plan_id FROM plans WHERE name = 'pro'),
  active = true,
  plan_used = 0,  -- Optional: reset usage
  current_period_end = '2025-02-15T00:00:00Z'  -- Set to actual period end from Stripe
WHERE email = 'affected.user@example.com';
*/

-- STEP 4: Verify repairs
SELECT
  p.email,
  pl.name as plan,
  pl.monthly_limit as limit,
  p.plan_used as used,
  p.active,
  p.current_period_end,
  CASE
    WHEN p.plan_used > pl.monthly_limit THEN '❌ OVER LIMIT'
    WHEN p.plan_used = 0 THEN '✅ RESET'
    ELSE '✓ OK'
  END as status
FROM profiles p
LEFT JOIN plans pl ON p.plan_id = pl.plan_id
ORDER BY p.created_at DESC
LIMIT 20;

-- ============================================================================
-- PREVENTION: Check if there are pending grace periods
-- ============================================================================
SELECT
  p.email,
  pl.name,
  p.active,
  p.current_period_end,
  CASE
    WHEN p.current_period_end > NOW() AND p.active = false THEN '⚠️ GRACE PERIOD'
    WHEN p.current_period_end < NOW() AND p.active = true THEN '❌ EXPIRED BUT ACTIVE'
    ELSE '✓ NORMAL'
  END as period_status
FROM profiles p
LEFT JOIN plans pl ON p.plan_id = pl.plan_id
WHERE p.current_period_end IS NOT NULL
ORDER BY p.current_period_end;
