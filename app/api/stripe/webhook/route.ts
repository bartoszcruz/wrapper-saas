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

    // Log webhook event to database for audit trail
    try {
      await supabase.from('webhook_events').insert({
        event_id: event.id,
        event_type: event.type,
        payload: event.data.object,
      });
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

        // Update webhook_events with user_id now that we know it
        await supabase
          .from('webhook_events')
          .update({ user_id: userId })
          .eq('event_id', event.id);

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
          .select('id')
          .eq('stripe_subscription_id', subscription.id)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for subscription:', subscription.id);
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

        console.log(`[Webhook] Detected plan ${plan.name} for user ${userId}`, {
          planId: plan.plan_id,
          limit: plan.monthly_limit,
        });

        // Calculate current_period_end
        const subData = subscription as unknown as Record<string, unknown>;
        const currentPeriodEnd = typeof subData.current_period_end === 'number'
          ? new Date(subData.current_period_end * 1000).toISOString()
          : null;

        // Update profile with new plan
        const { error: updateError } = await supabase
          .from('profiles')
          .update({
            plan_id: plan.plan_id,
            active: subscription.status === 'active',
            current_period_end: currentPeriodEnd,
          })
          .eq('id', userId);

        if (updateError) {
          console.error('[Webhook] Error updating profile:', updateError);
        } else {
          console.log('✅ Subscription updated:', {
            userId,
            plan: plan.name,
            planId: plan.plan_id,
            status: subscription.status,
          });
        }

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;

        console.log('[Webhook] Subscription deleted:', subscription.id);

        // Find user and downgrade to basic (or set plan_id to null)
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_subscription_id', subscription.id)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for deleted subscription');
          break;
        }

        // Find basic plan
        const { data: basicPlan } = await supabase
          .from('plans')
          .select('plan_id')
          .ilike('name', 'basic')
          .single();

        const { error: updateError } = await supabase
          .from('profiles')
          .update({
            plan_id: basicPlan?.plan_id || null,
            active: false,
            current_period_end: null,
          })
          .eq('id', profile.id);

        if (updateError) {
          console.error('[Webhook] Error downgrading user:', updateError);
        } else {
          console.log('✅ User downgraded to basic:', profile.id);
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

        // Reset usage counter for new billing period
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

        // Deactivate subscription (payment failed)
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ active: false })
          .eq('id', userId);

        if (updateError) {
          console.error('[Webhook] Error deactivating subscription:', updateError);
        } else {
          console.log('⚠️ Payment failed, subscription deactivated:', userId);
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
