import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase-server';

// Define types for Supabase response
type PlanData = {
  name: string;
  monthly_limit: number;
  price_usd: number;
  price_pln: number;
  stripe_price_id_pln: string | null;
  stripe_price_id_usd: string | null;
} | null;

type ProfileData = {
  id: string;
  email: string | null;
  plan_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_used: number;
  active: boolean;
  current_period_end: string | null;
  plans: PlanData;
};

type SupabaseError = {
  code: string;
  message: string;
  details: string;
  hint: string;
} | null;

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();

    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError) {
      console.error('[/api/me] Auth error:', authError.message);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!user) {
      console.error('[/api/me] No user found in session');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[/api/me] Authenticated user:', user.id, user.email);

    // Query profiles with plan JOIN through plan_id → plans.plan_id
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select(`
        id,
        email,
        plan_id,
        stripe_customer_id,
        stripe_subscription_id,
        plan_used,
        active,
        current_period_end,
        plans!plan_id (
          name,
          monthly_limit,
          price_usd,
          price_pln,
          stripe_price_id_pln,
          stripe_price_id_usd
        )
      `)
      .eq('id', user.id)
      .single() as { data: ProfileData | null; error: SupabaseError };

    // If profile query fails, log detailed error
    if (profileError) {
      console.error('[/api/me] Profile query error:', {
        code: profileError.code,
        message: profileError.message,
        details: profileError.details,
        hint: profileError.hint,
        userId: user.id,
      });
    }

    // If profile not found, return fallback minimal profile
    if (!profile) {
      console.warn('[/api/me] Profile not found for user:', user.id, '- returning fallback');

      // Return minimal profile with defaults
      return NextResponse.json({
        id: user.id,
        email: user.email || 'No email provided',
        plan: null,
        plan_limit: 0,
        plan_used: 0,
        active: false,
        current_period_end: null,
        plan_price_usd: null,
        plan_price_pln: null,
        stripe_price_id_pln: null,
        stripe_price_id_usd: null,
        stripe_customer_id: null,
        profileMissing: true, // Flag to indicate profile needs setup
      }, { status: 200 });
    }

    console.log('[/api/me] Profile found:', {
      userId: profile.id,
      email: profile.email,
      plan: profile.plans?.name,
      planId: profile.plan_id,
      active: profile.active,
    });

    // Format response - profile.plans is correctly typed as object (not array)
    const response = {
      id: profile.id,
      email: profile.email || user.email || 'No email provided',
      plan: profile.plans?.name || null,
      plan_limit: profile.plans?.monthly_limit || 0,
      plan_used: profile.plan_used || 0,
      active: profile.active || false,
      current_period_end: profile.current_period_end,
      plan_price_usd: profile.plans?.price_usd || null,
      plan_price_pln: profile.plans?.price_pln || null,
      stripe_price_id_pln: profile.plans?.stripe_price_id_pln || null,
      stripe_price_id_usd: profile.plans?.stripe_price_id_usd || null,
      stripe_customer_id: profile.stripe_customer_id || null,
      profileMissing: false,
    };

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error('[/api/me] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
