'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase-client';
import type { User } from '@supabase/supabase-js';

export default function Navbar() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createSupabaseBrowserClient();

  useEffect(() => {
    // Get initial session
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      setLoading(false);
    };

    getUser();

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [supabase]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    router.push('/');
    router.refresh();
  };

  const isActive = (path: string) => pathname === path;

  return (
    <nav className="border-b border-border bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16 items-center">
          {/* Logo / Brand */}
          <div className="flex items-center gap-8">
            <Link href="/" className="text-xl font-bold">
              LUVO
            </Link>

            {/* Navigation Links */}
            <div className="hidden md:flex items-center gap-6">
              <Link
                href="/"
                className={`text-sm font-medium transition-colors hover:text-foreground ${
                  isActive('/') ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                Home
              </Link>
              <Link
                href="/pricing"
                className={`text-sm font-medium transition-colors hover:text-foreground ${
                  isActive('/pricing') ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                Pricing
              </Link>
              {user && (
                <Link
                  href="/dashboard"
                  className={`text-sm font-medium transition-colors hover:text-foreground ${
                    isActive('/dashboard') ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  Dashboard
                </Link>
              )}
            </div>
          </div>

          {/* Auth Buttons */}
          <div className="flex items-center gap-4">
            {loading ? (
              <div className="h-9 w-20 bg-muted animate-pulse rounded-md" />
            ) : user ? (
              <>
                <span className="text-sm text-muted-foreground hidden sm:inline">
                  {user.email}
                </span>
                <button
                  onClick={handleLogout}
                  className="px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-md transition-colors"
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="px-4 py-2 text-sm font-medium text-foreground hover:text-foreground/80 transition-colors"
                >
                  Login
                </Link>
                <Link
                  href="/signup"
                  className="px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-md transition-colors"
                >
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
