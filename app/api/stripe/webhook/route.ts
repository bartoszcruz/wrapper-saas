import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-09-30.clover',
})

export async function POST(req: Request) {
  const body = await req.text()
  const sig = headers().get('stripe-signature')!

  try {
    const event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )

    switch (event.type) {
      case 'checkout.session.completed':
        console.log('✅ Session completed', event.data.object)
        break
      case 'customer.subscription.updated':
        console.log('🔄 Subscription updated', event.data.object)
        break
      default:
        console.log('Unhandled event type', event.type)
    }

    return NextResponse.json({ received: true })
  } catch (err) {
    console.error(err)
    return NextResponse.json({ error: 'Webhook error' }, { status: 400 })
  }
}
