'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function ConfirmedPage() {
  const router = useRouter();

  useEffect(() => {
    // Auto-redirect to dashboard after 2 seconds
    const timer = setTimeout(() => {
      router.push('/dashboard');
    }, 2000);

    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full space-y-6 text-center">
        {/* Success Icon */}
        <div className="flex justify-center">
          <div className="rounded-full bg-green-500/10 p-4">
            <svg className="w-16 h-16 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>

        {/* Message */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">Email Confirmed!</h1>
          <p className="text-muted-foreground">
            Your account has been successfully verified.
          </p>
          <p className="text-sm text-muted-foreground">
            Redirecting to dashboard in 2 seconds...
          </p>
        </div>

        {/* Manual Link */}
        <div className="pt-4">
          <Link
            href="/dashboard"
            className="inline-block bg-primary text-primary-foreground px-6 py-3 rounded-lg hover:bg-primary/80 transition font-medium"
          >
            Go to Dashboard →
          </Link>
        </div>

        {/* Alternative Login */}
        <p className="text-xs text-muted-foreground pt-4">
          Or{' '}
          <Link href="/login" className="underline hover:text-foreground">
            sign in manually
          </Link>
        </p>
      </div>
    </div>
  );
}
