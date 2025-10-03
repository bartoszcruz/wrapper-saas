import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-09-30.clover',
});

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();

    // 1. Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      console.error('[/api/customer-portal] Unauthorized:', authError?.message);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[/api/customer-portal] User:', user.id, user.email);

    // 2. Get user's Stripe customer ID
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.error('[/api/customer-portal] Profile not found');
      return NextResponse.json(
        { error: 'Profile not found' },
        { status: 404 }
      );
    }

    if (!profile.stripe_customer_id) {
      console.error('[/api/customer-portal] No Stripe customer ID');
      return NextResponse.json(
        { error: 'No active subscription found. Please subscribe to a plan first.' },
        { status: 400 }
      );
    }

    console.log('[/api/customer-portal] Customer ID:', profile.stripe_customer_id);

    // 3. Get app URL for return redirect
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    // 4. Create Stripe Customer Portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}/dashboard`,
    });

    console.log('[/api/customer-portal] Portal session created:', portalSession.id);

    // 5. Redirect to Stripe Customer Portal
    if (!portalSession.url) {
      console.error('[/api/customer-portal] No portal URL returned');
      return NextResponse.json(
        { error: 'Failed to create portal session' },
        { status: 500 }
      );
    }

    return NextResponse.redirect(portalSession.url, 303);

  } catch (error) {
    console.error('[/api/customer-portal] Unexpected error:', error);

    if (error instanceof Stripe.errors.StripeError) {
      console.error('[/api/customer-portal] Stripe error:', {
        type: error.type,
        code: error.code,
        message: error.message,
      });

      return NextResponse.json(
        { error: `Stripe error: ${error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
