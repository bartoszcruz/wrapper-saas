import { createSupabaseServerClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export default async function PricingPage() {
  const supabase = await createSupabaseServerClient();

  // Check if user is authenticated
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Get locale from cookie
  const cookieStore = await cookies();
  const locale = cookieStore.get('locale')?.value || 'en';
  const isPl = locale === 'pl';

  console.log('[Pricing] Locale:', locale, 'isPl:', isPl);

  // Fetch plans from Supabase
  const { data: plans, error } = await supabase
    .from('plans')
    .select('plan_id, name, price_pln, price_usd, monthly_limit, stripe_price_id_pln, stripe_price_id_usd')
    .order('price_pln', { ascending: true });

  if (error || !plans) {
    console.error('[Pricing] Error fetching plans:', error);
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-600">Error loading plans</h1>
          <p className="text-muted-foreground mt-2">Please try again later.</p>
        </div>
      </div>
    );
  }

  // Get user's current plan
  const { data: currentProfile } = await supabase
    .from('profiles')
    .select('plan_id, active')
    .eq('id', user.id)
    .single();

  console.log('[Pricing] User current plan:', currentProfile?.plan_id);

  // Currency settings
  const currency = isPl ? 'PLN' : 'USD';
  const currencySymbol = isPl ? 'zł' : '$';

  return (
    <div className="min-h-screen bg-background py-8 sm:py-12">
      <div className="container mx-auto px-4">
        {/* Header */}
        <div className="text-center mb-8 sm:mb-12">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            {isPl ? 'Wybierz swój plan' : 'Choose Your Plan'}
          </h1>
          <p className="text-base sm:text-lg text-muted-foreground">
            {isPl
              ? 'Wybierz idealny plan dla swoich potrzeb. Zmień lub anuluj w każdej chwili.'
              : 'Select the perfect plan for your needs. Upgrade or downgrade anytime.'}
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            {isPl ? `Ceny w ${currency}` : `Prices in ${currency}`}
          </p>
        </div>

        {/* Plans Grid - Mobile: 1 column, Desktop: 3 columns */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {plans.map((plan) => {
            const isPopular = plan.name.toLowerCase() === 'pro';
            const price = isPl ? plan.price_pln : plan.price_usd;
            const priceId = isPl ? plan.stripe_price_id_pln : plan.stripe_price_id_usd;
            const isAvailable = !!priceId;
            const isCurrentPlan = currentProfile?.plan_id === plan.plan_id;

            // Capitalize plan name
            const displayName = plan.name.charAt(0).toUpperCase() + plan.name.slice(1);

            return (
              <div
                key={plan.plan_id}
                className={`relative bg-card border rounded-lg p-8 flex flex-col ${
                  isPopular
                    ? 'border-foreground shadow-lg scale-105'
                    : 'border-border'
                }`}
              >
                {/* Current Plan Badge */}
                {isCurrentPlan && (
                  <div className="absolute -top-4 left-4">
                    <span className="bg-green-500 text-white px-3 py-1 rounded-full text-xs font-medium">
                      {isPl ? 'Aktualny plan' : 'Current Plan'}
                    </span>
                  </div>
                )}

                {/* Popular Badge */}
                {isPopular && !isCurrentPlan && (
                  <div className="absolute -top-4 left-1/2 transform -translate-x-1/2">
                    <span className="bg-foreground text-background px-4 py-1 rounded-full text-sm font-medium">
                      {isPl ? 'Najpopularniejszy' : 'Most Popular'}
                    </span>
                  </div>
                )}

                {/* Plan Header */}
                <div className="text-center mb-6">
                  <h2 className="text-2xl font-bold mb-2">{displayName}</h2>
                  <div className="flex items-baseline justify-center gap-1">
                    <span className="text-4xl font-bold">{price}</span>
                    <span className="text-muted-foreground">{currencySymbol}</span>
                    <span className="text-muted-foreground">
                      {isPl ? '/mies' : '/mo'}
                    </span>
                  </div>
                </div>

                {/* Plan Features */}
                <div className="flex-1 mb-6">
                  <ul className="space-y-3">
                    <li className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span>
                        {plan.monthly_limit > 0
                          ? isPl
                            ? `${plan.monthly_limit} generacji/miesiąc`
                            : `${plan.monthly_limit} generations/month`
                          : isPl
                          ? 'Nielimitowane generacje'
                          : 'Unlimited generations'}
                      </span>
                    </li>
                    <li className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span>
                        {isPl ? 'Priorytetowe wsparcie' : 'Priority support'}
                      </span>
                    </li>
                    {plan.name.toLowerCase() === 'agency' && (
                      <>
                        <li className="flex items-center gap-2">
                          <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          <span>
                            {isPl ? 'Niestandardowe integracje' : 'Custom integrations'}
                          </span>
                        </li>
                        <li className="flex items-center gap-2">
                          <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          <span>
                            {isPl ? 'Dedykowany opiekun konta' : 'Dedicated account manager'}
                          </span>
                        </li>
                      </>
                    )}
                  </ul>
                </div>

                {/* Subscribe Button */}
                <form action="/api/checkout" method="POST">
                  <input type="hidden" name="plan" value={plan.name} />
                  <input type="hidden" name="currency" value={currency} />
                  <button
                    type="submit"
                    disabled={!isAvailable || isCurrentPlan}
                    className="bg-primary text-primary-foreground w-full py-3 rounded-lg hover:bg-primary/80 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                  >
                    {isCurrentPlan
                      ? isPl
                        ? 'Aktywny'
                        : 'Active'
                      : isAvailable
                      ? isPl
                        ? 'Subskrybuj'
                        : 'Subscribe'
                      : isPl
                      ? 'Wkrótce'
                      : 'Coming Soon'}
                  </button>
                </form>

                {/* Price ID Missing Warning */}
                {!isAvailable && (
                  <p className="text-xs text-red-500 text-center mt-2">
                    {isPl
                      ? `Plan niedostępny w ${currency}`
                      : `Plan unavailable in ${currency}`}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* FAQ / Notice */}
        <div className="mt-16 text-center text-sm text-muted-foreground">
          <p>
            {isPl
              ? `Wszystkie ceny w ${currency}. Anuluj w dowolnym momencie. Bez ukrytych opłat.`
              : `All prices in ${currency}. Cancel anytime. No hidden fees.`}
          </p>
          <p className="mt-2">
            {isPl ? 'Potrzebujesz pomocy w wyborze?' : 'Need help choosing?'}{' '}
            <a href="mailto:support@example.com" className="underline hover:text-foreground">
              {isPl ? 'Skontaktuj się z nami' : 'Contact us'}
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
