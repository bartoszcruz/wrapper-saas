import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { CookieOptions } from '@supabase/ssr';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

  // 1. Get token from query params (Supabase sends token_hash or code)
  const token = requestUrl.searchParams.get('token');
  const tokenHash = requestUrl.searchParams.get('token_hash');
  const code = requestUrl.searchParams.get('code');
  const type = requestUrl.searchParams.get('type') || 'signup';

  // Get redirect destination (default to /dashboard)
  const redirectTo = requestUrl.searchParams.get('redirect_to') || '/dashboard';

  console.log('[Auth Confirm] Received request:', {
    hasToken: !!token,
    hasTokenHash: !!tokenHash,
    hasCode: !!code,
    type,
    redirectTo,
  });

  // Validate that we have some form of token
  if (!token && !tokenHash && !code) {
    console.error('[Auth Confirm] No token provided in URL');
    return NextResponse.redirect(new URL('/login?error=missing_token', requestUrl.origin));
  }

  try {
    const cookieStore = await cookies();

    // 2. Create Supabase server client with proper cookie handling
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value;
          },
          set(name: string, value: string, options: CookieOptions) {
            cookieStore.set(name, value, options);
          },
          remove(name: string, options: CookieOptions) {
            cookieStore.set(name, '', options);
          },
        },
      }
    );

    // 3. Exchange token for session
    let error = null;

    if (code) {
      // Using PKCE flow (newer Supabase versions)
      console.log('[Auth Confirm] Exchanging code for session...');
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      error = exchangeError;
    } else if (tokenHash) {
      // Using token_hash (email confirmation)
      console.log('[Auth Confirm] Verifying OTP with token_hash...');
      const { error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type as 'email' | 'signup',
      });
      error = verifyError;
    } else if (token) {
      // Fallback: old token format
      console.log('[Auth Confirm] Verifying OTP with token...');
      const { error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: token,
        type: type as 'email' | 'signup',
      });
      error = verifyError;
    }

    if (error) {
      console.error('[Auth Confirm] Error verifying token:', error.message);
      return NextResponse.redirect(
        new URL(`/login?error=${encodeURIComponent(error.message)}`, requestUrl.origin)
      );
    }

    // 4. Verify session was created successfully
    const { data: { user }, error: getUserError } = await supabase.auth.getUser();

    if (getUserError || !user) {
      console.error('[Auth Confirm] Failed to get user after confirmation:', getUserError?.message);
      return NextResponse.redirect(
        new URL('/login?error=session_failed', requestUrl.origin)
      );
    }

    console.log('[Auth Confirm] ✅ User confirmed successfully:', user.id, user.email);

    // 5. Redirect to dashboard (or custom redirect_to)
    const redirectUrl = new URL(redirectTo, requestUrl.origin);

    console.log('[Auth Confirm] Redirecting to:', redirectUrl.toString());

    return NextResponse.redirect(redirectUrl);

  } catch (err) {
    console.error('[Auth Confirm] Unexpected error:', err);
    return NextResponse.redirect(
      new URL('/login?error=unexpected_error', requestUrl.origin)
    );
  }
}
