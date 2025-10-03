import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-16 sm:py-24">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          {/* Hero Section */}
          <div className="space-y-4">
            <h1 className="text-5xl sm:text-6xl font-bold tracking-tight">
              Welcome to <span className="text-primary">LUVO</span>
            </h1>
            <p className="text-xl sm:text-2xl text-muted-foreground">
              AI-powered content generation for e-commerce and agencies
            </p>
          </div>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center pt-8">
            <Link
              href="/signup"
              className="bg-primary text-primary-foreground px-8 py-3 rounded-lg hover:bg-primary/80 transition font-medium w-full sm:w-auto"
            >
              Get Started →
            </Link>
            <Link
              href="/pricing"
              className="border border-border px-8 py-3 rounded-lg hover:bg-accent transition font-medium w-full sm:w-auto"
            >
              View Pricing
            </Link>
          </div>

          {/* Features */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-16">
            <div className="bg-card border border-border rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-2">AI-Powered</h3>
              <p className="text-muted-foreground text-sm">
                Generate high-quality content with advanced AI models
              </p>
            </div>
            <div className="bg-card border border-border rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-2">Flexible Plans</h3>
              <p className="text-muted-foreground text-sm">
                Choose the plan that fits your needs, from Basic to Agency
              </p>
            </div>
            <div className="bg-card border border-border rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-2">Easy to Use</h3>
              <p className="text-muted-foreground text-sm">
                Simple dashboard to manage your generations and subscription
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
