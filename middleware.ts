import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // 1. Handle locale detection (before auth check)
  const localeCookie = request.cookies.get('locale')?.value;

  if (!localeCookie) {
    // Detect locale from headers
    const country = request.headers.get('x-vercel-ip-country');
    const acceptLanguage = request.headers.get('accept-language') || '';

    let detectedLocale = 'en'; // default

    if (country === 'PL' || acceptLanguage.toLowerCase().includes('pl')) {
      detectedLocale = 'pl';
    }

    // Set locale cookie (1 year expiry)
    response.cookies.set('locale', detectedLocale, {
      maxAge: 60 * 60 * 24 * 365, // 1 year
      path: '/',
      sameSite: 'lax',
    });

    console.log('[Middleware] Locale detected and set:', detectedLocale);
  }

  // 2. Auth check for protected routes (dashboard)
  const pathname = request.nextUrl.pathname;

  if (pathname.startsWith('/dashboard')) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return request.cookies.get(name)?.value;
          },
          set(name: string, value: string, options) {
            response.cookies.set({
              name,
              value,
              ...options,
            });
          },
          remove(name: string, options) {
            response.cookies.set({
              name,
              value: '',
              ...options,
            });
          },
        },
      }
    );

    // Verify user session
    const { data: { user }, error } = await supabase.auth.getUser();

    // If no user or error, redirect to login
    if (error || !user) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
  }

  // User is authenticated (or not on protected route), allow request
  return response;
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/pricing', // Also run on pricing to set locale
  ],
};
