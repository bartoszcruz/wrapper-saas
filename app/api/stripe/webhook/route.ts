import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-09-30.clover',
});

// Create Supabase client with service role for webhook (bypasses RLS)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  const body = await req.text();
  const incomingHeaders = await headers();
  const sig = incomingHeaders.get('stripe-signature')!;

  try {
    const event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );

    console.log('[Webhook] Event received:', event.type, event.id);

    // Log FULL webhook event to database for complete audit trail (idempotent)
    // Table schema: id (int8 PK), event_id (text UNIQUE), type (text), raw (jsonb), created_at (timestamptz)
    try {
      // Check if event already logged (idempotency)
      const { data: existing } = await supabase
        .from('webhook_events')
        .select('event_id')
        .eq('event_id', event.id)
        .single();

      if (!existing) {
        await supabase.from('webhook_events').insert({
          event_id: event.id,
          type: event.type,
          raw: event,
        });
        console.log('[Webhook] Full event logged to database');
      } else {
        console.log('[Webhook] Event already logged (duplicate), skipping');
      }
    } catch (logError) {
      console.error('[Webhook] Failed to log event to database:', logError);
      // Continue processing even if logging fails
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        console.log('[Webhook] Checkout session completed:', {
          sessionId: session.id,
          customerId: session.customer,
          subscriptionId: session.subscription,
          metadata: session.metadata,
        });

        // Get userId from metadata
        const userId = session.metadata?.userId;

        if (!userId) {
          console.error('[Webhook] Missing userId in session metadata');
          break;
        }

        // Get subscription details to find price_id
        if (!session.subscription) {
          console.error('[Webhook] No subscription ID in session');
          break;
        }

        // Expand session to get line_items with price info
        const expandedSession = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ['line_items'],
        });

        const priceId = expandedSession.line_items?.data[0]?.price?.id;

        if (!priceId) {
          console.error('[Webhook] No price ID found in session line_items');
          break;
        }

        console.log('[Webhook] Subscription price ID:', priceId);

        // Find plan in Supabase by price_id (check both PLN and USD)
        const { data: plan, error: planError } = await supabase
          .from('plans')
          .select('plan_id, name, monthly_limit')
          .or(`stripe_price_id_pln.eq.${priceId},stripe_price_id_usd.eq.${priceId}`)
          .single();

        if (planError || !plan) {
          console.error('[Webhook] Plan not found for price_id:', priceId, planError?.message);
          // Still update customer info even if plan not found
          await supabase
            .from('profiles')
            .update({
              stripe_customer_id: session.customer as string,
              stripe_subscription_id: session.subscription as string,
              active: true,
            })
            .eq('id', userId);

          console.log('[Webhook] Updated customer info without plan');
          break;
        }

        console.log(`[Webhook] Detected plan ${plan.name} for user ${userId}`, {
          planId: plan.plan_id,
          limit: plan.monthly_limit,
        });

        // Update profile with plan info
        // Note: current_period_end will be set by customer.subscription.created event
        const { error: updateError } = await supabase
          .from('profiles')
          .update({
            plan_id: plan.plan_id,
            active: true,
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
          })
          .eq('id', userId);

        if (updateError) {
          console.error('[Webhook] Error updating profile:', updateError);
        } else {
          console.log('✅ Profile updated:', {
            userId,
            plan: plan.name,
            planId: plan.plan_id,
            limit: plan.monthly_limit,
            active: true,
          });
        }

        break;
      }

      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription;

        console.log('[Webhook] Subscription created:', {
          subscriptionId: subscription.id,
          customerId: subscription.customer,
          status: subscription.status,
        });

        const priceId = subscription.items.data[0]?.price.id;

        if (!priceId) {
          console.error('[Webhook] No price ID in subscription');
          break;
        }

        // Find user by stripe_customer_id
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_customer_id', subscription.customer as string)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for customer:', subscription.customer);
          break;
        }

        const userId = profile.id;

        // Find plan by price_id
        const { data: plan, error: planError } = await supabase
          .from('plans')
          .select('plan_id, name, monthly_limit')
          .or(`stripe_price_id_pln.eq.${priceId},stripe_price_id_usd.eq.${priceId}`)
          .single();

        if (planError || !plan) {
          console.error('[Webhook] Plan not found for price_id:', priceId);
          break;
        }

        console.log(`[Webhook] Detected plan ${plan.name} for user ${userId}`, {
          planId: plan.plan_id,
          limit: plan.monthly_limit,
        });

        // Calculate current_period_end from subscription
        const subData = subscription as unknown as Record<string, unknown>;
        const currentPeriodEnd = typeof subData.current_period_end === 'number'
          ? new Date(subData.current_period_end * 1000).toISOString()
          : null;

        // Update profile
        const { error: updateError } = await supabase
          .from('profiles')
          .update({
            plan_id: plan.plan_id,
            active: subscription.status === 'active',
            stripe_subscription_id: subscription.id,
            current_period_end: currentPeriodEnd,
          })
          .eq('id', userId);

        if (updateError) {
          console.error('[Webhook] Error updating profile:', updateError);
        } else {
          console.log('✅ Subscription plan updated:', {
            userId,
            plan: plan.name,
            planId: plan.plan_id,
            status: subscription.status,
          });
        }

        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;

        console.log('[Webhook] Subscription updated:', {
          subscriptionId: subscription.id,
          status: subscription.status,
        });

        const priceId = subscription.items.data[0]?.price.id;

        if (!priceId) {
          console.error('[Webhook] No price ID in subscription');
          break;
        }

        // Find user by subscription_id
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, plan_id')
          .eq('stripe_subscription_id', subscription.id)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for subscription:', subscription.id);
          break;
        }

        const userId = profile.id;

        // Find NEW plan by price_id
        const { data: newPlan, error: planError } = await supabase
          .from('plans')
          .select('plan_id, name, monthly_limit')
          .or(`stripe_price_id_pln.eq.${priceId},stripe_price_id_usd.eq.${priceId}`)
          .single();

        if (planError || !newPlan) {
          console.error('[Webhook] Plan not found for price_id:', priceId);
          // Update status only
          const subData = subscription as unknown as Record<string, unknown>;
          const currentPeriodEnd = typeof subData.current_period_end === 'number'
            ? new Date(subData.current_period_end * 1000).toISOString()
            : null;

          await supabase
            .from('profiles')
            .update({
              active: subscription.status === 'active',
              current_period_end: currentPeriodEnd,
            })
            .eq('id', userId);

          console.log('[Webhook] Updated subscription status without plan change');
          break;
        }

        console.log(`[Webhook] Detected plan ${newPlan.name} for user ${userId}`, {
          planId: newPlan.plan_id,
          limit: newPlan.monthly_limit,
        });

        // Calculate current_period_end
        const subData = subscription as unknown as Record<string, unknown>;
        const currentPeriodEnd = typeof subData.current_period_end === 'number'
          ? new Date(subData.current_period_end * 1000).toISOString()
          : null;

        // Detect if this is upgrade or downgrade
        const { data: oldPlan } = await supabase
          .from('plans')
          .select('monthly_limit')
          .eq('plan_id', profile.plan_id)
          .single();

        const isDowngrade = oldPlan && newPlan.monthly_limit < oldPlan.monthly_limit;

        // Update profile with new plan
        const updateData: Record<string, unknown> = {
          plan_id: newPlan.plan_id,
          active: subscription.status === 'active',
          current_period_end: currentPeriodEnd,
        };

        // ✅ SANITY CHECK: Reset usage on downgrade, keep on upgrade
        if (isDowngrade) {
          updateData.plan_used = 0;
          console.log('[Webhook] Downgrade detected, resetting usage to 0');
        } else {
          console.log('[Webhook] Upgrade detected, preserving usage');
        }

        const { error: updateError } = await supabase
          .from('profiles')
          .update(updateData)
          .eq('id', userId);

        if (updateError) {
          console.error('[Webhook] Error updating profile:', updateError);
        } else {
          console.log('✅ Subscription updated:', {
            userId,
            plan: newPlan.name,
            planId: newPlan.plan_id,
            status: subscription.status,
            isDowngrade,
          });
        }

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const subData = subscription as unknown as Record<string, unknown>;

        console.log('[Webhook] Subscription deleted:', subscription.id);

        // Find user
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_subscription_id', subscription.id)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for deleted subscription');
          break;
        }

        // ✅ GRACE PERIOD CHECK: Don't downgrade immediately
        const currentPeriodEnd = typeof subData.current_period_end === 'number'
          ? new Date(subData.current_period_end * 1000)
          : null;

        const now = new Date();
        const isGracePeriod = currentPeriodEnd && currentPeriodEnd > now;

        if (isGracePeriod) {
          // User cancelled but still has paid access until period end
          console.log('[Webhook] Subscription cancelled, keeping access until:', currentPeriodEnd.toISOString());

          // Keep current plan, mark as ending soon
          await supabase
            .from('profiles')
            .update({
              active: false, // Mark as non-renewing (won't auto-bill)
              current_period_end: currentPeriodEnd.toISOString(),
            })
            .eq('id', profile.id);

          console.log('✅ Subscription will end at period:', profile.id, currentPeriodEnd);
        } else {
          // Period has ended, now safe to downgrade
          const { data: basicPlan } = await supabase
            .from('plans')
            .select('plan_id')
            .ilike('name', 'basic')
            .single();

          await supabase
            .from('profiles')
            .update({
              plan_id: basicPlan?.plan_id || null,
              active: false,
              current_period_end: null,
              plan_used: 0, // ✅ Reset usage when downgrading
            })
            .eq('id', profile.id);

          console.log('✅ User downgraded to basic (period ended):', profile.id);
        }

        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceData = invoice as unknown as Record<string, unknown>;

        console.log('[Webhook] Invoice payment succeeded:', {
          invoiceId: invoice.id,
          subscriptionId: invoiceData.subscription,
          periodEnd: invoiceData.period_end,
        });

        // Only process if this is a subscription invoice
        if (!invoiceData.subscription) {
          console.log('[Webhook] Non-subscription invoice, skipping');
          break;
        }

        // Find user by stripe_subscription_id
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_subscription_id', invoiceData.subscription as string)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for subscription:', invoiceData.subscription);
          break;
        }

        const userId = profile.id;

        // ✅ NEW BILLING PERIOD: Reset usage counter
        const updateData: Record<string, unknown> = {
          plan_used: 0,
        };

        // Update current_period_end if available in invoice
        if (typeof invoiceData.period_end === 'number') {
          updateData.current_period_end = new Date(invoiceData.period_end * 1000).toISOString();
        }

        const { error: updateError } = await supabase
          .from('profiles')
          .update(updateData)
          .eq('id', userId);

        if (updateError) {
          console.error('[Webhook] Error resetting usage:', updateError);
        } else {
          console.log('✅ Usage reset for new period:', userId);
        }

        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceData = invoice as unknown as Record<string, unknown>;

        console.log('[Webhook] Invoice payment failed:', {
          invoiceId: invoice.id,
          subscriptionId: invoiceData.subscription,
          attemptCount: invoiceData.attempt_count,
          nextPaymentAttempt: invoiceData.next_payment_attempt,
        });

        // Only process if this is a subscription invoice
        if (!invoiceData.subscription) {
          console.log('[Webhook] Non-subscription invoice, skipping');
          break;
        }

        // Find user by stripe_subscription_id
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_subscription_id', invoiceData.subscription as string)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for subscription:', invoiceData.subscription);
          break;
        }

        const userId = profile.id;

        // ✅ RETRY LOGIC: Only deactivate if Stripe has given up (no more retry attempts)
        // Stripe will send this event multiple times as it retries (up to 4 attempts)
        const hasMoreAttempts = invoiceData.next_payment_attempt !== null;

        if (hasMoreAttempts) {
          console.log('[Webhook] Payment failed but Stripe will retry, keeping subscription active');
          // Don't deactivate yet - Stripe will try again
          break;
        }

        // Final attempt failed, deactivate
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ active: false })
          .eq('id', userId);

        if (updateError) {
          console.error('[Webhook] Error deactivating subscription:', updateError);
        } else {
          console.log('⚠️ Payment failed (final attempt), subscription deactivated:', userId);
        }

        break;
      }

      default:
        console.log('⚠️ Unhandled event type:', event.type);
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error('❌ Webhook error:', err.message);
    } else {
      console.error('❌ Unknown webhook error:', err);
    }
    return NextResponse.json({ error: 'Webhook error' }, { status: 400 });
  }
}
