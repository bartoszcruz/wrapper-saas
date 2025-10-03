import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { cookies } from 'next/headers';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-09-30.clover',
});

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();

    // 1. Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      console.error('[/api/checkout] Unauthorized:', authError?.message);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[/api/checkout] User:', user.id, user.email);

    // 2. Parse FormData
    const formData = await request.formData();
    const planName = formData.get('plan') as string | null;
    const currency = formData.get('currency') as string | null;

    if (!planName || !currency) {
      console.error('[/api/checkout] Missing parameters:', { planName, currency });
      return NextResponse.json(
        { error: 'Plan and currency parameters are required' },
        { status: 400 }
      );
    }

    if (!['PLN', 'USD'].includes(currency)) {
      console.error('[/api/checkout] Invalid currency:', currency);
      return NextResponse.json(
        { error: 'Currency must be PLN or USD' },
        { status: 400 }
      );
    }

    console.log('[/api/checkout] Request:', { planName, currency });

    // 3. Fetch plan from Supabase (case-insensitive)
    const { data: plan, error: planError } = await supabase
      .from('plans')
      .select('plan_id, name, stripe_price_id_pln, stripe_price_id_usd, price_pln, price_usd')
      .ilike('name', planName)
      .single();

    if (planError || !plan) {
      console.error('[/api/checkout] Plan not found:', planError?.message, planName);
      return NextResponse.json(
        { error: `Plan "${planName}" not found` },
        { status: 400 }
      );
    }

    console.log('[/api/checkout] Plan found:', plan.name, plan.plan_id);

    // 4. Select correct Stripe Price ID based on currency
    const stripePriceId = currency === 'PLN'
      ? plan.stripe_price_id_pln
      : plan.stripe_price_id_usd;

    if (!stripePriceId) {
      console.error('[/api/checkout] Missing stripe_price_id for:', {
        plan: plan.name,
        currency,
        pln_id: plan.stripe_price_id_pln,
        usd_id: plan.stripe_price_id_usd,
      });

      return NextResponse.json(
        {
          error: `Plan "${plan.name}" is not available in ${currency}. Please try a different currency or contact support.`,
        },
        { status: 400 }
      );
    }

    console.log('[/api/checkout] Using Stripe Price ID:', stripePriceId, `(${currency})`);

    // 5. Get app URL from env
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    // 6. Get locale from cookies for Stripe Checkout UI
    const cookieStore = await cookies();
    const locale = cookieStore.get('locale')?.value || 'en';
    const stripeLocale = locale === 'pl' ? 'pl' : 'auto';

    // 7. Create Stripe Checkout Session with promotion codes enabled
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: stripePriceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${appUrl}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/pricing`,
      customer_email: user.email || undefined,
      client_reference_id: user.id, // User ID for webhook processing
      locale: stripeLocale as Stripe.Checkout.SessionCreateParams.Locale,
      allow_promotion_codes: true, // Enable promotion code field
      metadata: {
        userId: user.id,
        planId: plan.plan_id,
        planName: plan.name,
        currency: currency,
      },
    });

    console.log('[checkout] session created with allow_promotion_codes=true', {
      sessionId: session.id,
      plan: plan.name,
      currency,
    });

    // 8. Return redirect to Stripe Checkout
    if (!session.url) {
      console.error('[/api/checkout] No checkout URL returned from Stripe');
      return NextResponse.json(
        { error: 'Failed to create checkout session' },
        { status: 500 }
      );
    }

    // Redirect to Stripe Checkout (303 for POST form)
    return NextResponse.redirect(session.url, 303);

  } catch (error) {
    console.error('[/api/checkout] Unexpected error:', error);

    if (error instanceof Stripe.errors.StripeError) {
      console.error('[/api/checkout] Stripe error details:', {
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
