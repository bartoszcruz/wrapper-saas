-- Create webhook_events table for Stripe webhook logging and debugging
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id ON public.webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_user_id ON public.webhook_events(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON public.webhook_events(event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON public.webhook_events(created_at DESC);

-- RLS Policies (admin only - no public access)
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Only service role can insert (webhooks)
CREATE POLICY "Service role can insert webhook events"
ON public.webhook_events FOR INSERT
TO service_role
WITH CHECK (true);

-- Only service role can read (for debugging)
CREATE POLICY "Service role can read webhook events"
ON public.webhook_events FOR SELECT
TO service_role
USING (true);

-- Add comment
COMMENT ON TABLE public.webhook_events IS 'Logs all Stripe webhook events for debugging and audit trail';
