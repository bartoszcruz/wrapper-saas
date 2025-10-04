import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { CookieOptions } from '@supabase/ssr';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);

  // Get token and type from Supabase email link
  const token = requestUrl.searchParams.get('token');
  const tokenHash = requestUrl.searchParams.get('token_hash');
  const code = requestUrl.searchParams.get('code');
  const type = requestUrl.searchParams.get('type') || 'signup';

  console.log('[Auth Confirm] Request:', {
    hasToken: !!token,
    hasTokenHash: !!tokenHash,
    hasCode: !!code,
    type,
  });

  // If no token, show error page
  if (!token && !tokenHash && !code) {
    return NextResponse.redirect(
      new URL('/auth/error?message=Invalid confirmation link', requestUrl.origin)
    );
  }

  try {
    const cookieStore = await cookies();

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

    // Exchange token for session
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
    } else if (tokenHash) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: type as 'email' | 'signup',
      });
      if (error) throw error;
    } else if (token) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: token,
        type: type as 'email' | 'signup',
      });
      if (error) throw error;
    }

    // Verify session created
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      console.log('[Auth Confirm] ✅ User confirmed:', user.email);
      // Redirect to success page (will auto-redirect to dashboard)
      return NextResponse.redirect(new URL('/auth/confirmed', requestUrl.origin));
    } else {
      throw new Error('Session not created');
    }

  } catch (error) {
    console.error('[Auth Confirm] Error:', error);
    return NextResponse.redirect(
      new URL('/auth/error?message=Confirmation failed', requestUrl.origin)
    );
  }
}
