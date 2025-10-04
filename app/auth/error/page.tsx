'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

function AuthErrorContent() {
  const searchParams = useSearchParams();
  const message = searchParams.get('message') || 'An error occurred during authentication';

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full space-y-6 text-center">
        {/* Error Icon */}
        <div className="flex justify-center">
          <div className="rounded-full bg-red-500/10 p-4">
            <svg className="w-16 h-16 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        </div>

        {/* Message */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">Confirmation Failed</h1>
          <p className="text-muted-foreground">
            {message}
          </p>
        </div>

        {/* Actions */}
        <div className="space-y-3 pt-4">
          <Link
            href="/login"
            className="block bg-primary text-primary-foreground px-6 py-3 rounded-lg hover:bg-primary/80 transition font-medium"
          >
            Go to Login
          </Link>
          <Link
            href="/signup"
            className="block border border-border px-6 py-3 rounded-lg hover:bg-accent transition font-medium"
          >
            Sign Up Again
          </Link>
        </div>

        <p className="text-xs text-muted-foreground pt-4">
          Need help?{' '}
          <a href="mailto:support@example.com" className="underline hover:text-foreground">
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <AuthErrorContent />
    </Suspense>
  );
}
