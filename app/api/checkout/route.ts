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
      .select('plan_id, name, stripe_price_id_pln, stripe_price_id_usd, price_pln, price_usd, monthly_limit')
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

    // 5. Get user profile with rate limiting check
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, stripe_subscription_id, active, plan_id, last_checkout_at, pending_plan_change')
      .eq('id', user.id)
      .single();

    // 6. RATE LIMITING: Check if last checkout was less than 60 seconds ago
    if (existingProfile?.last_checkout_at) {
      const lastCheckoutTime = new Date(existingProfile.last_checkout_at).getTime();
      const now = Date.now();
      const timeSinceLastCheckout = now - lastCheckoutTime;

      if (timeSinceLastCheckout < 60000) { // 60 seconds
        const remainingSeconds = Math.ceil((60000 - timeSinceLastCheckout) / 1000);
        console.warn('[/api/checkout] Rate limit hit:', user.id, `Wait ${remainingSeconds}s`);
        return NextResponse.json(
          { error: `Please wait ${remainingSeconds} seconds before trying again` },
          { status: 429 }
        );
      }
    }

    // 7. Check if there's already a pending plan change
    if (existingProfile?.pending_plan_change) {
      console.warn('[/api/checkout] Pending plan change already in progress:', user.id);
      return NextResponse.json(
        { error: 'A plan change is already in progress. Please wait for it to complete.' },
        { status: 409 }
      );
    }

    // 8. Check if user is trying to select the same plan they already have
    if (existingProfile?.plan_id === plan.plan_id && existingProfile?.active) {
      console.log('[/api/checkout] User already has this plan:', plan.name);
      return NextResponse.json(
        { error: 'You already have this plan' },
        { status: 400 }
      );
    }

    // 9. FORK: Existing subscription (upgrade/downgrade) vs New subscription
    const hasActiveSubscription = existingProfile?.stripe_subscription_id && existingProfile?.active;

    if (hasActiveSubscription) {
      // ========================================
      // UPGRADE/DOWNGRADE: Use subscriptions.update
      // ========================================
      console.log('[/api/checkout] User has active subscription, using subscriptions.update');

      try {
        // Verify subscription exists and is active in Stripe
        const subscription = await stripe.subscriptions.retrieve(
          existingProfile.stripe_subscription_id
        );

        if (subscription.status !== 'active' && subscription.status !== 'trialing') {
          console.error('[/api/checkout] Subscription not active in Stripe:', subscription.status);
          return NextResponse.json(
            { error: `Subscription is ${subscription.status}. Please contact support.` },
            { status: 400 }
          );
        }

        // Get subscription item ID (first item)
        const subscriptionItemId = subscription.items.data[0]?.id;

        if (!subscriptionItemId) {
          console.error('[/api/checkout] No subscription item found');
          return NextResponse.json(
            { error: 'Invalid subscription structure. Please contact support.' },
            { status: 500 }
          );
        }

        console.log('[/api/checkout] Updating subscription:', {
          subscriptionId: subscription.id,
          itemId: subscriptionItemId,
          oldPrice: subscription.items.data[0]?.price.id,
          newPrice: stripePriceId,
        });

        // Update subscription with new price
        const updatedSubscription = await stripe.subscriptions.update(
          existingProfile.stripe_subscription_id,
          {
            items: [
              {
                id: subscriptionItemId,
                price: stripePriceId, // New price
              },
            ],
            proration_behavior: 'create_prorations', // Calculate proration
            billing_cycle_anchor: 'unchanged', // Keep same billing cycle
            metadata: {
              userId: user.id,
              planId: plan.plan_id,
              planName: plan.name,
              currency: currency,
              previousPlanId: existingProfile.plan_id || 'unknown',
            },
          }
        );

        console.log('[/api/checkout] ✅ Subscription updated:', {
          subscriptionId: updatedSubscription.id,
          newPrice: stripePriceId,
          status: updatedSubscription.status,
        });

        // Set pending state (webhook will clear it)
        const { error: updateError } = await supabase
          .from('profiles')
          .update({
            pending_plan_change: true,
            target_plan_id: plan.plan_id,
            last_checkout_at: new Date().toISOString(),
          })
          .eq('id', user.id);

        if (updateError) {
          console.error('[/api/checkout] Failed to set pending state:', updateError);
        } else {
          console.log('[/api/checkout] Set pending_plan_change=true for user:', user.id);
        }

        // Return success (no redirect, stay on dashboard)
        // Dashboard will poll and detect pending_plan_change
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        return NextResponse.redirect(`${appUrl}/dashboard?plan_change=pending`, 303);

      } catch (error) {
        console.error('[/api/checkout] Error updating subscription:', error);

        if (error instanceof Stripe.errors.StripeError) {
          return NextResponse.json(
            { error: `Stripe error: ${error.message}` },
            { status: 500 }
          );
        }

        return NextResponse.json(
          { error: 'Failed to update subscription' },
          { status: 500 }
        );
      }

    } else {
      // ========================================
      // NEW SUBSCRIPTION: Use Checkout Session
      // ========================================
      console.log('[/api/checkout] Creating new subscription via Checkout Session');

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const cookieStore = await cookies();
      const locale = cookieStore.get('locale')?.value || 'en';
      const stripeLocale = locale === 'pl' ? 'pl' : 'auto';

      const sessionParams: Stripe.Checkout.SessionCreateParams = {
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
        client_reference_id: user.id,
        locale: stripeLocale as Stripe.Checkout.SessionCreateParams.Locale,
        allow_promotion_codes: true,
        metadata: {
          userId: user.id,
          planId: plan.plan_id,
          planName: plan.name,
          currency: currency,
        },
      };

      // If user has existing customer ID, attach it
      if (existingProfile?.stripe_customer_id) {
        sessionParams.customer = existingProfile.stripe_customer_id;
      } else {
        sessionParams.customer_email = user.email || undefined;
      }

      // Create Checkout Session
      const session = await stripe.checkout.sessions.create(sessionParams);

      console.log('[/api/checkout] Checkout session created:', {
        sessionId: session.id,
        plan: plan.name,
        currency,
      });

      if (!session.url) {
        console.error('[/api/checkout] No checkout URL returned from Stripe');
        return NextResponse.json(
          { error: 'Failed to create checkout session' },
          { status: 500 }
        );
      }

      // Set pending state
      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          pending_plan_change: true,
          target_plan_id: plan.plan_id,
          last_checkout_at: new Date().toISOString(),
        })
        .eq('id', user.id);

      if (updateError) {
        console.error('[/api/checkout] Failed to set pending state:', updateError);
      } else {
        console.log('[/api/checkout] Set pending_plan_change=true for user:', user.id);
      }

      // Redirect to Stripe Checkout
      return NextResponse.redirect(session.url, 303);
    }

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
