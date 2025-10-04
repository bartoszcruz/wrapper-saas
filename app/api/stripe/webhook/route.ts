import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import {
  isDuplicateEvent,
  logWebhookEvent,
  logAlert,
  updateProfileAtomic,
  isValidSubscriptionStatus,
} from '@/lib/webhook-helpers';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-09-30.clover',
});

// Create Supabase client with service role for webhook (bypasses RLS)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Helper: Extract current_period_end from subscription (Clover API compatible)
async function getCurrentPeriodEnd(subscriptionId: string): Promise<string | null> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items'],
    });

    const subData = subscription as unknown as Record<string, unknown>;

    // Try direct field first (backwards compatibility with older API)
    if (typeof subData.current_period_end === 'number') {
      console.log('[Webhook] current_period_end from subscription object (legacy):', subData.current_period_end);
      return new Date(subData.current_period_end * 1000).toISOString();
    }

    // Clover API: period_end is now on subscription items
    const items = subscription.items as unknown as Record<string, unknown>;
    const itemsData = items.data as unknown[];

    if (itemsData && itemsData.length > 0) {
      const firstItem = itemsData[0] as Record<string, unknown>;

      if (typeof firstItem.current_period_end === 'number') {
        console.log('[Webhook] current_period_end from subscription.items[0] (Clover):', firstItem.current_period_end);
        return new Date(firstItem.current_period_end * 1000).toISOString();
      }
    }

    console.warn('[Webhook] current_period_end not found in subscription or items');
    return null;
  } catch (error) {
    console.error('[Webhook] Error retrieving subscription for period_end:', error);
    return null;
  }
}

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

    // ✅ IDEMPOTENCY CHECK: Return early if event already processed
    const duplicate = await isDuplicateEvent(event.id);
    if (duplicate) {
      console.log('[Webhook] ⚠️ Duplicate event detected, skipping processing:', event.id);
      return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
    }

    // Log event to database for audit trail
    await logWebhookEvent({
      eventId: event.id,
      eventType: event.type,
      payload: event,
    });

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
          await logAlert({
            type: 'subscription_mismatch',
            severity: 'warning',
            message: 'Missing userId in checkout session metadata',
            metadata: { sessionId: session.id },
          });
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
          await logAlert({
            type: 'missing_price_id',
            severity: 'critical',
            message: 'No price ID found in checkout session line items',
            metadata: { sessionId: session.id, userId },
          });
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
          console.error('[Webhook] ❌ CRITICAL: Plan not found for price_id:', priceId, planError?.message);

          await logAlert({
            type: 'missing_price_id',
            severity: 'critical',
            message: `Plan not found for price_id: ${priceId}. User will have active subscription but no plan in DB.`,
            metadata: { priceId, userId, sessionId: session.id },
          });

          // ❌ DO NOT activate subscription without valid plan
          await updateProfileAtomic({
            userId,
            updates: {
              stripe_customer_id: session.customer as string,
              stripe_subscription_id: session.subscription as string,
              active: false, // Don't give access without valid plan
              pending_plan_change: false,
            },
          });

          console.log('[Webhook] Updated customer info without plan (active=false)');
          break;
        }

        console.log(`[Webhook] Detected plan ${plan.name} for user ${userId}`, {
          planId: plan.plan_id,
          limit: plan.monthly_limit,
        });

        // Update profile with plan info and clear pending state
        await updateProfileAtomic({
          userId,
          updates: {
            plan_id: plan.plan_id,
            active: true,
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
            subscription_status: 'active',
            pending_plan_change: false,
            target_plan_id: null,
          },
        });

        console.log('✅ Profile updated:', {
          userId,
          plan: plan.name,
          planId: plan.plan_id,
          limit: plan.monthly_limit,
          active: true,
        });

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
          await logAlert({
            type: 'subscription_mismatch',
            severity: 'warning',
            message: 'Profile not found for Stripe customer',
            metadata: { customerId: subscription.customer, subscriptionId: subscription.id },
          });
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
          await logAlert({
            type: 'missing_price_id',
            severity: 'critical',
            message: `Plan not found for price_id in subscription.created: ${priceId}`,
            metadata: { priceId, userId, subscriptionId: subscription.id },
          });
          break;
        }

        console.log(`[Webhook] Detected plan ${plan.name} for user ${userId}`, {
          planId: plan.plan_id,
          limit: plan.monthly_limit,
        });

        // Validate subscription status
        if (!isValidSubscriptionStatus(subscription.status)) {
          console.warn('[Webhook] Unknown subscription status:', subscription.status);
          await logAlert({
            type: 'unknown_status',
            severity: 'warning',
            message: `Unknown subscription status: ${subscription.status}`,
            metadata: { status: subscription.status, subscriptionId: subscription.id },
          });
        }

        // Calculate current_period_end (Clover API compatible)
        const currentPeriodEnd = await getCurrentPeriodEnd(subscription.id);

        // Update profile
        await updateProfileAtomic({
          userId,
          updates: {
            plan_id: plan.plan_id,
            active: subscription.status === 'active' || subscription.status === 'trialing',
            stripe_subscription_id: subscription.id,
            current_period_end: currentPeriodEnd,
            subscription_status: subscription.status,
            pending_plan_change: false,
            target_plan_id: null,
          },
        });

        console.log('✅ Subscription plan updated:', {
          userId,
          plan: plan.name,
          planId: plan.plan_id,
          status: subscription.status,
        });

        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;

        console.log('[Webhook] Subscription updated:', {
          subscriptionId: subscription.id,
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
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

        // Validate subscription status
        if (!isValidSubscriptionStatus(subscription.status)) {
          console.warn('[Webhook] Unknown subscription status:', subscription.status);
          await logAlert({
            type: 'unknown_status',
            severity: 'warning',
            message: `Unknown subscription status in update: ${subscription.status}`,
            metadata: { status: subscription.status, subscriptionId: subscription.id },
          });
        }

        // Find NEW plan by price_id
        const { data: newPlan, error: planError } = await supabase
          .from('plans')
          .select('plan_id, name, monthly_limit')
          .or(`stripe_price_id_pln.eq.${priceId},stripe_price_id_usd.eq.${priceId}`)
          .single();

        if (planError || !newPlan) {
          console.error('[Webhook] Plan not found for price_id:', priceId);
          // Update status only
          const currentPeriodEnd = await getCurrentPeriodEnd(subscription.id);

          await updateProfileAtomic({
            userId,
            updates: {
              active: subscription.status === 'active' || subscription.status === 'trialing',
              current_period_end: currentPeriodEnd,
              subscription_status: subscription.status,
              cancel_at_period_end: subscription.cancel_at_period_end || false,
            },
          });

          console.log('[Webhook] Updated subscription status without plan change');
          break;
        }

        console.log(`[Webhook] Detected plan ${newPlan.name} for user ${userId}`, {
          planId: newPlan.plan_id,
          limit: newPlan.monthly_limit,
        });

        // Calculate current_period_end (Clover API compatible)
        const currentPeriodEnd = await getCurrentPeriodEnd(subscription.id);

        // Detect if this is upgrade or downgrade
        const { data: oldPlan } = await supabase
          .from('plans')
          .select('monthly_limit')
          .eq('plan_id', profile.plan_id)
          .single();

        const isDowngrade = oldPlan && newPlan.monthly_limit < oldPlan.monthly_limit;

        // Prepare update data
        const updateData: Record<string, unknown> = {
          plan_id: newPlan.plan_id,
          active: subscription.status === 'active' || subscription.status === 'trialing',
          current_period_end: currentPeriodEnd,
          subscription_status: subscription.status,
          cancel_at_period_end: subscription.cancel_at_period_end || false,
          pending_plan_change: false,
          target_plan_id: null,
        };

        // ✅ Reset usage on downgrade, keep on upgrade
        if (isDowngrade) {
          updateData.plan_used = 0;
          console.log('[Webhook] Downgrade detected, resetting usage to 0');
        } else {
          console.log('[Webhook] Upgrade detected, preserving usage');
        }

        await updateProfileAtomic({
          userId,
          updates: updateData,
        });

        console.log('✅ Subscription updated:', {
          userId,
          plan: newPlan.name,
          planId: newPlan.plan_id,
          status: subscription.status,
          isDowngrade,
        });

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const subData = subscription as unknown as Record<string, unknown>;

        console.log('[Webhook] Subscription deleted:', subscription.id, {
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          currentPeriodEnd: subData.current_period_end,
        });

        // Find user
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, plan_id')
          .eq('stripe_subscription_id', subscription.id)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for deleted subscription');
          break;
        }

        // ✅ GRACE PERIOD CHECK: Preserve access until period end
        const currentPeriodEnd = typeof subData.current_period_end === 'number'
          ? new Date(subData.current_period_end * 1000)
          : null;

        const now = new Date();
        const isGracePeriod = currentPeriodEnd && currentPeriodEnd > now;

        if (isGracePeriod) {
          // ✅ FIX: User has paid access until period end - KEEP active=true and plan_id
          console.log('[Webhook] Subscription cancelled (grace period), keeping access until:', currentPeriodEnd.toISOString());

          await updateProfileAtomic({
            userId: profile.id,
            updates: {
              // ✅ KEEP plan_id (user still has plan)
              // ✅ KEEP active=true (user has access)
              active: true,
              cancel_at_period_end: true, // Mark as non-renewing
              current_period_end: currentPeriodEnd.toISOString(),
              subscription_status: 'canceled',
            },
          });

          console.log('✅ Subscription cancelled (grace period):', profile.id, currentPeriodEnd);
        } else {
          // Immediate cancellation - period has ended, clear plan completely
          console.log('[Webhook] Subscription ended immediately, clearing plan');

          await updateProfileAtomic({
            userId: profile.id,
            updates: {
              plan_id: null, // Clear plan
              active: false,
              current_period_end: null,
              plan_used: 0, // Reset usage
              cancel_at_period_end: false,
              subscription_status: 'canceled',
              pending_plan_change: false,
              target_plan_id: null,
            },
          });

          console.log('✅ Subscription ended, plan cleared:', profile.id);
        }

        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const invoiceData = invoice as unknown as Record<string, unknown>;

        // Extract subscription ID (with multiple fallbacks for Clover API)
        let subscriptionId = invoiceData.subscription as string | null;

        // Fallback: check invoice lines for subscription
        if (!subscriptionId && invoiceData.lines) {
          const lines = invoiceData.lines as unknown as Record<string, unknown>;
          const linesData = lines.data as unknown[];
          const firstLine = linesData?.[0] as Record<string, unknown>;
          if (firstLine?.subscription) {
            subscriptionId = firstLine.subscription as string;
            console.log('[Webhook] Found subscriptionId in invoice.lines[0]:', subscriptionId);
          }
        }

        // Additional fallback: subscription_details (Clover API)
        if (!subscriptionId && invoiceData.subscription_details) {
          const subDetails = invoiceData.subscription_details as Record<string, unknown>;
          if (subDetails.subscription_id) {
            subscriptionId = subDetails.subscription_id as string;
            console.log('[Webhook] Found subscriptionId in subscription_details (Clover):', subscriptionId);
          }
        }

        console.log('[Webhook] Invoice payment succeeded:', {
          invoiceId: invoice.id,
          subscriptionId,
          periodStart: invoiceData.period_start,
          periodEnd: invoiceData.period_end,
        });

        // Only process if this is a subscription invoice
        if (!subscriptionId) {
          console.log('[Webhook] Non-subscription invoice (no subscription ID found), skipping');
          break;
        }

        // Find user by stripe_subscription_id
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_subscription_id', subscriptionId)
          .single();

        if (profileError || !profile) {
          console.error('[Webhook] Profile not found for subscription:', subscriptionId);
          break;
        }

        const userId = profile.id;

        // ✅ NEW BILLING PERIOD: Reset usage counter and ensure active
        const updateData: Record<string, unknown> = {
          plan_used: 0,
          active: true, // Payment succeeded, ensure active
          cancel_at_period_end: false, // Payment succeeded, subscription renewed
        };

        // Get current_period_end from subscription (Clover API compatible)
        const currentPeriodEnd = await getCurrentPeriodEnd(subscriptionId);

        if (currentPeriodEnd) {
          updateData.current_period_end = currentPeriodEnd;
          console.log('[Webhook] Will update current_period_end to:', currentPeriodEnd);
        } else {
          console.warn('[Webhook] current_period_end is null - check helper logs for reason');
        }

        await updateProfileAtomic({
          userId,
          updates: updateData,
        });

        console.log('✅ Usage reset for new period:', userId, {
          plan_used: 0,
          current_period_end: updateData.current_period_end || 'not updated',
          active: true,
        });

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
        const hasMoreAttempts = invoiceData.next_payment_attempt !== null;

        if (hasMoreAttempts) {
          console.log('[Webhook] Payment failed but Stripe will retry, keeping subscription active');
          // Don't deactivate yet - Stripe will try again
          break;
        }

        // Final attempt failed, deactivate and clear plan
        await updateProfileAtomic({
          userId,
          updates: {
            active: false,
            plan_id: null, // Clear plan (no access)
            subscription_status: 'unpaid',
          },
        });

        await logAlert({
          type: 'subscription_mismatch',
          severity: 'warning',
          message: 'Payment failed (final attempt), subscription deactivated',
          metadata: { userId, subscriptionId: invoiceData.subscription },
        });

        console.log('⚠️ Payment failed (final attempt), subscription deactivated and plan cleared:', userId);

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
