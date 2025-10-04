'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

interface UserProfile {
  id: string;
  email: string;
  plan: string | null;
  plan_limit: number;
  plan_used: number;
  active: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  pending_plan_change: boolean;
  target_plan_id: string | null;
  subscription_status: string;
  plan_price_usd: number | null;
  plan_price_pln: number | null;
  stripe_price_id_pln: string | null;
  stripe_price_id_usd: string | null;
  stripe_customer_id?: string | null;
  profileMissing?: boolean;
}

const POLL_INTERVAL = 2000; // 2 seconds
const POLL_TIMEOUT = 30000; // 30 seconds

export default function DashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [polling, setPolling] = useState(false);
  const [pollTimeout, setPollTimeout] = useState(false);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pollStartTimeRef = useRef<number>(0);

  const fetchProfile = useCallback(async () => {
    try {
      const response = await fetch('/api/me', {
        credentials: 'include',
      });

      if (response.status === 401) {
        console.error('[Dashboard] Unauthorized - redirecting to login');
        router.push('/login');
        return null;
      }

      if (response.status === 500) {
        throw new Error('Server error - please try again later');
      }

      const data = await response.json();

      if (data.error) {
        console.error('[Dashboard] API error:', data.error);
        throw new Error(data.error);
      }

      console.log('[Dashboard] Profile loaded:', data);
      setProfile(data);
      return data;
    } catch (err) {
      console.error('[Dashboard] Error fetching profile:', err);
      setError(err instanceof Error ? err.message : 'Failed to load profile data');
      return null;
    } finally {
      setLoading(false);
    }
  }, [router]);

  // Polling logic for pending plan changes
  const startPolling = useCallback(() => {
    console.log('[Dashboard] Starting polling for pending plan change');
    setPolling(true);
    setPollTimeout(false);
    pollStartTimeRef.current = Date.now();

    const poll = async () => {
      const elapsed = Date.now() - pollStartTimeRef.current;

      if (elapsed > POLL_TIMEOUT) {
        console.error('[Dashboard] Polling timeout after 30s');
        setPolling(false);
        setPollTimeout(true);
        toast.error('Plan change is taking longer than expected. Please refresh the page in a moment.');
        if (pollTimerRef.current) {
          clearTimeout(pollTimerRef.current);
        }
        return;
      }

      const freshProfile = await fetchProfile();

      if (freshProfile && !freshProfile.pending_plan_change) {
        console.log('[Dashboard] Pending plan change completed');
        setPolling(false);
        toast.success('Plan updated successfully!');
        if (pollTimerRef.current) {
          clearTimeout(pollTimerRef.current);
        }
        // Clear query params
        window.history.replaceState({}, '', '/dashboard');
      } else if (freshProfile && freshProfile.pending_plan_change) {
        // Continue polling
        pollTimerRef.current = setTimeout(poll, POLL_INTERVAL);
      }
    };

    poll();
  }, [fetchProfile]);

  // Stop polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  // Initial load
  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  // Handle session_id from Stripe Checkout success OR plan_change=pending from subscriptions.update
  useEffect(() => {
    const sessionId = searchParams?.get('session_id');
    const planChange = searchParams?.get('plan_change');

    if (sessionId) {
      console.log('[Dashboard] Stripe session detected, starting polling for webhook...');
      toast.info('Processing your payment...', { duration: 3000 });

      // Start polling for pending_plan_change to become false
      startPolling();
    } else if (planChange === 'pending') {
      console.log('[Dashboard] Plan change detected (subscriptions.update), starting polling...');
      toast.info('Updating your plan...', { duration: 3000 });

      // Start polling for pending_plan_change to become false
      startPolling();
    }
  }, [searchParams, startPolling]);

  // Check if profile has pending_plan_change on mount
  useEffect(() => {
    if (profile && profile.pending_plan_change && !polling) {
      console.log('[Dashboard] Detected pending plan change on mount, starting polling');
      startPolling();
    }
  }, [profile, polling, startPolling]);

  const handleGenerate = async () => {
    setGenerating(true);
    setTimeout(() => {
      toast.info('Generate functionality coming soon!');
      setGenerating(false);
    }, 1000);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-foreground"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full space-y-4">
          <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 px-6 py-4 rounded-lg">
            <h3 className="font-semibold mb-2">Error Loading Dashboard</h3>
            <p className="text-sm">{error}</p>
          </div>
          <button
            onClick={fetchProfile}
            className="w-full px-4 py-2 bg-foreground text-background rounded-md hover:bg-foreground/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!profile) {
    return null;
  }

  const planName = profile.plan || 'No Plan';
  const hasPlan = profile.plan !== null && !profile.profileMissing;
  const usagePercentage = profile.plan_limit > 0
    ? (profile.plan_used / profile.plan_limit) * 100
    : 0;

  const isLimitReached =
    (profile.plan_limit ?? 0) > 0 &&
    profile.plan_used >= (profile.plan_limit ?? 0);

  // Determine if user has access (active OR grace period)
  const hasAccess = profile.active || (profile.cancel_at_period_end && profile.current_period_end);

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 sm:py-8 max-w-4xl">
        <div className="space-y-2 mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Welcome back, {profile.email}
          </p>
        </div>

        <div className="space-y-6">
          {/* Pending Plan Change Loading */}
          {(profile.pending_plan_change || polling) && (
            <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-400 px-6 py-4 rounded-lg">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <div>
                  <h3 className="font-semibold">Plan change in progress</h3>
                  <p className="text-sm mt-1">
                    Please wait while we process your subscription update...
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Polling Timeout Warning */}
          {pollTimeout && (
            <div className="bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800 text-orange-800 dark:text-orange-400 px-6 py-4 rounded-lg">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
                <div>
                  <h3 className="font-semibold">Update taking longer than expected</h3>
                  <p className="text-sm mt-1">
                    Your plan change is being processed by Stripe. This may take a few more moments. Try refreshing the page in 30 seconds.
                  </p>
                  <button
                    onClick={() => {
                      setPollTimeout(false);
                      window.location.reload();
                    }}
                    className="mt-3 text-sm font-medium underline hover:no-underline"
                  >
                    Refresh now →
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Profile Missing Warning */}
          {profile.profileMissing && (
            <div className="bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800 text-orange-800 dark:text-orange-400 px-6 py-4 rounded-lg">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
                <div>
                  <h3 className="font-semibold">Profile Setup Required</h3>
                  <p className="text-sm mt-1">
                    Your account profile is incomplete. Please contact support or select a plan to get started.
                  </p>
                  <button
                    onClick={() => router.push('/pricing')}
                    className="mt-3 text-sm font-medium underline hover:no-underline"
                  >
                    View pricing plans →
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Grace Period / Canceled Subscription Warning */}
          {profile.cancel_at_period_end && profile.current_period_end && (
            <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-400 px-6 py-4 rounded-lg">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <div>
                  <h3 className="font-semibold">Subscription will not renew</h3>
                  <p className="text-sm mt-1">
                    Your subscription has been canceled but you still have access until{' '}
                    <span className="font-semibold">
                      {new Date(profile.current_period_end).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                      })}
                    </span>
                    . Reactivate anytime before this date.
                  </p>
                  <button
                    onClick={() => router.push('/pricing')}
                    className="mt-3 text-sm font-medium underline hover:no-underline"
                  >
                    Reactivate subscription →
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* No Active Subscription Warning */}
          {!hasAccess && !profile.profileMissing && !profile.pending_plan_change && (
            <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-400 px-6 py-4 rounded-lg">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                <div>
                  <h3 className="font-semibold">No active subscription</h3>
                  <p className="text-sm mt-1">
                    Please upgrade your plan to continue using the service.
                  </p>
                  <button
                    onClick={() => router.push('/pricing')}
                    className="mt-3 text-sm font-medium underline hover:no-underline"
                  >
                    View pricing plans →
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Plan Card - show if user has access (active OR grace period) */}
          {hasAccess && hasPlan && !profile.pending_plan_change && (
            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold">Current Plan</h2>
                  <p className="text-muted-foreground text-sm mt-1">
                    {planName}
                  </p>
                </div>
                <button
                  onClick={() => router.push('/pricing')}
                  disabled={profile.pending_plan_change || polling}
                  className="px-4 py-2 text-sm font-medium border border-border rounded-md hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {profile.cancel_at_period_end ? 'Reactivate' : 'Change Plan'}
                </button>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Monthly usage</span>
                  <span className="font-medium">
                    {profile.plan_used} / {profile.plan_limit > 0 ? profile.plan_limit : 'Unlimited'}
                  </span>
                </div>

                {profile.plan_limit > 0 && (
                  <>
                    <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          isLimitReached
                            ? 'bg-red-500'
                            : usagePercentage > 80
                            ? 'bg-yellow-500'
                            : 'bg-green-500'
                        }`}
                        style={{ width: `${Math.min(usagePercentage, 100)}%` }}
                      />
                    </div>

                    {isLimitReached && (
                      <p className="text-sm text-red-600 dark:text-red-400">
                        You&apos;ve reached your monthly limit. Upgrade to continue.
                      </p>
                    )}
                  </>
                )}
              </div>

              {profile.current_period_end && (
                <p className="text-xs text-muted-foreground">
                  {profile.cancel_at_period_end
                    ? `Access until ${new Date(profile.current_period_end).toLocaleDateString()}`
                    : `Renews on ${new Date(profile.current_period_end).toLocaleDateString()}`
                  }
                </p>
              )}
            </div>
          )}

          {/* Subscription Details */}
          {hasPlan && hasAccess && !profile.pending_plan_change && (
            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
              <h2 className="text-xl font-semibold">Subscription Details</h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium">
                    {profile.active && !profile.cancel_at_period_end ? (
                      <span className="text-green-600 dark:text-green-400">● Active</span>
                    ) : profile.cancel_at_period_end ? (
                      <span className="text-yellow-600 dark:text-yellow-400">● Canceled (access until period end)</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400">● Inactive</span>
                    )}
                  </p>
                </div>

                {profile.current_period_end && (
                  <div>
                    <p className="text-muted-foreground">
                      {profile.cancel_at_period_end ? 'Access until' : 'Next billing date'}
                    </p>
                    <p className="font-medium">
                      {new Date(profile.current_period_end).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                      })}
                    </p>
                  </div>
                )}

                {profile.plan_price_pln !== null && (
                  <div>
                    <p className="text-muted-foreground">Price (PLN)</p>
                    <p className="font-medium">{profile.plan_price_pln} zł/month</p>
                  </div>
                )}

                {profile.plan_price_usd !== null && (
                  <div>
                    <p className="text-muted-foreground">Price (USD)</p>
                    <p className="font-medium">${profile.plan_price_usd}/month</p>
                  </div>
                )}
              </div>

              {profile.stripe_customer_id && (
                <div className="pt-4 border-t border-border">
                  <form action="/api/customer-portal" method="POST">
                    <button
                      type="submit"
                      disabled={profile.pending_plan_change || polling}
                      className="w-full sm:w-auto px-4 py-2 border border-border rounded-md hover:bg-accent transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Manage Subscription →
                    </button>
                  </form>
                  <p className="text-xs text-muted-foreground mt-2">
                    Update payment method, view invoices, or cancel subscription
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Generate Section */}
          <div className="bg-card border border-border rounded-lg p-6 space-y-4">
            <div>
              <h2 className="text-xl font-semibold">Generate</h2>
              <p className="text-muted-foreground text-sm mt-1">
                Start creating with AI
              </p>
            </div>

            <button
              onClick={handleGenerate}
              disabled={!hasAccess || isLimitReached || generating || profile.profileMissing || profile.pending_plan_change || polling}
              className="w-full bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed font-medium py-3 px-6 rounded-md transition-colors"
            >
              {generating ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Generating...
                </span>
              ) : (
                'Generate Now'
              )}
            </button>

            {(!hasAccess || isLimitReached || profile.profileMissing || profile.pending_plan_change) && (
              <p className="text-xs text-center text-muted-foreground">
                {profile.profileMissing
                  ? 'Complete your profile setup to enable generation'
                  : profile.pending_plan_change
                  ? 'Plan change in progress - generation will be available shortly'
                  : !hasAccess
                  ? 'Subscribe to a plan to enable generation'
                  : 'Upgrade your plan to continue generating'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
