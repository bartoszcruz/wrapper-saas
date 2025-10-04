import { createClient } from '@supabase/supabase-js';

// Supabase client with service role for webhook operations
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Alert severity levels
 */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Alert types for different webhook scenarios
 */
export type AlertType =
  | 'missing_price_id'
  | 'webhook_delay'
  | 'duplicate_event'
  | 'unknown_status'
  | 'subscription_mismatch'
  | 'invalid_plan_change';

/**
 * Log a webhook alert to the database and optionally send external notifications
 */
export async function logAlert(params: {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { type, severity, message, metadata } = params;

  console.log(`[Alert] [${severity.toUpperCase()}] [${type}] ${message}`, metadata);

  try {
    // Insert alert into database
    await supabase.from('webhook_alerts').insert({
      alert_type: type,
      severity,
      message,
      metadata: metadata || {},
    });

    // For critical alerts, send external notification
    if (severity === 'critical') {
      await sendCriticalAlert({ type, message, metadata });
    }
  } catch (error) {
    console.error('[Alert] Failed to log alert:', error);
  }
}

/**
 * Send critical alert via external channels (email, Slack, etc.)
 * Currently logs to console - implement actual notifications as needed
 */
async function sendCriticalAlert(params: {
  type: AlertType;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { type, message, metadata } = params;

  console.error('🚨 CRITICAL ALERT 🚨', {
    type,
    message,
    metadata,
    timestamp: new Date().toISOString(),
  });

  // TODO: Implement actual notification system
  // Examples:
  // - Send email via SendGrid/Resend
  // - Post to Slack webhook
  // - Create PagerDuty incident
  // - Send SMS via Twilio
}

/**
 * Check if event has already been processed (idempotency)
 * Returns true if duplicate, false if new
 */
export async function isDuplicateEvent(eventId: string): Promise<boolean> {
  try {
    const { data: existing } = await supabase
      .from('webhook_events')
      .select('event_id')
      .eq('event_id', eventId)
      .single();

    return !!existing;
  } catch {
    // If error (e.g. not found), treat as new event
    return false;
  }
}

/**
 * Log webhook event to database for audit trail
 */
export async function logWebhookEvent(params: {
  eventId: string;
  eventType: string;
  userId?: string;
  payload: unknown;
}): Promise<void> {
  const { eventId, eventType, userId, payload } = params;

  try {
    await supabase.from('webhook_events').insert({
      event_id: eventId,
      event_type: eventType,
      user_id: userId || null,
      payload: payload as Record<string, unknown>,
    });

    console.log(`[Webhook] Event logged: ${eventType} (${eventId})`);
  } catch (error) {
    console.error('[Webhook] Failed to log event:', error);
    // Don't throw - logging failure shouldn't stop webhook processing
  }
}

/**
 * Atomically update profile - use transaction to prevent race conditions
 * Returns success status
 */
export async function updateProfileAtomic(params: {
  userId: string;
  updates: Record<string, unknown>;
  conditions?: Record<string, unknown>;
}): Promise<{ success: boolean; error?: string }> {
  const { userId, updates, conditions } = params;

  try {
    // Build query with conditions
    let query = supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId);

    // Add additional conditions if provided
    if (conditions) {
      Object.entries(conditions).forEach(([key, value]) => {
        query = query.eq(key, value);
      });
    }

    const { error } = await query;

    if (error) {
      console.error('[updateProfileAtomic] Update failed:', error);
      return { success: false, error: error.message };
    }

    console.log('[updateProfileAtomic] Profile updated:', userId, updates);
    return { success: true };
  } catch (error) {
    console.error('[updateProfileAtomic] Unexpected error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Clear pending plan change state
 */
export async function clearPendingPlanChange(userId: string): Promise<void> {
  await supabase
    .from('profiles')
    .update({
      pending_plan_change: false,
      target_plan_id: null,
    })
    .eq('id', userId);

  console.log('[clearPendingPlanChange] Cleared for user:', userId);
}

/**
 * Validate Stripe subscription status against known valid statuses
 */
export function isValidSubscriptionStatus(status: string): boolean {
  const validStatuses = [
    'active',
    'trialing',
    'past_due',
    'canceled',
    'unpaid',
    'incomplete',
    'incomplete_expired',
    'paused',
  ];

  return validStatuses.includes(status);
}

/**
 * Get user-friendly status message for subscription status
 */
export function getStatusMessage(status: string, locale: 'en' | 'pl' = 'en'): string {
  const messages: Record<string, { en: string; pl: string }> = {
    active: {
      en: 'Your subscription is active',
      pl: 'Twoja subskrypcja jest aktywna',
    },
    trialing: {
      en: 'You are in trial period',
      pl: 'Jesteś w okresie próbnym',
    },
    past_due: {
      en: 'Payment is past due - please update your payment method',
      pl: 'Płatność zaległa - zaktualizuj metodę płatności',
    },
    canceled: {
      en: 'Your subscription has been canceled',
      pl: 'Twoja subskrypcja została anulowana',
    },
    unpaid: {
      en: 'Payment failed - subscription suspended',
      pl: 'Płatność nieudana - subskrypcja zawieszona',
    },
    incomplete: {
      en: 'Subscription setup incomplete',
      pl: 'Konfiguracja subskrypcji niekompletna',
    },
    incomplete_expired: {
      en: 'Subscription setup expired',
      pl: 'Konfiguracja subskrypcji wygasła',
    },
    paused: {
      en: 'Your subscription is paused',
      pl: 'Twoja subskrypcja jest wstrzymana',
    },
  };

  return messages[status]?.[locale] || status;
}
