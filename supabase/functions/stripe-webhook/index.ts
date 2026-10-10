// Edge Function: sincroniza el ciclo de vida de Stripe con los permisos Pro.
// Secretos requeridos: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY
import Stripe from 'npm:stripe@19.2.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-10-29.clover',
});
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getCurrentPeriodEnd(subscription: Stripe.Subscription): number | null {
  const itemEnds = subscription.items.data
    .map((item) => (item as Stripe.SubscriptionItem & { current_period_end?: number }).current_period_end)
    .filter((value): value is number => typeof value === 'number');
  const legacyEnd = (subscription as Stripe.Subscription & { current_period_end?: number })
    .current_period_end;
  if (typeof legacyEnd === 'number') itemEnds.push(legacyEnd);
  return itemEnds.length ? Math.max(...itemEnds) : null;
}

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return json({ error: 'Falta firma' }, 400);

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Firma inválida' },
      400
    );
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const persistSubscription = async (
    subscription: Stripe.Subscription,
    fallbackUserId?: string | null
  ) => {
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;
    let userId = subscription.metadata?.user_id ?? fallbackUserId ?? null;

    if (!userId) {
      const { data: profile } = await admin
        .from('profiles')
        .select('user_id')
        .or(`stripe_subscription_id.eq.${subscription.id},stripe_customer_id.eq.${customerId}`)
        .limit(1)
        .maybeSingle();
      userId = profile?.user_id ?? null;
    }
    if (!userId) throw new Error('No se pudo asociar la suscripción con un usuario.');

    const incomingIsActive = ACTIVE_STATUSES.has(subscription.status);
    if (!incomingIsActive) {
      const { data: currentProfile } = await admin
        .from('profiles')
        .select('stripe_subscription_id')
        .eq('user_id', userId)
        .maybeSingle();
      const currentSubscriptionId = currentProfile?.stripe_subscription_id;

      if (currentSubscriptionId && currentSubscriptionId !== subscription.id) {
        try {
          const currentSubscription = await stripe.subscriptions.retrieve(currentSubscriptionId);
          if (ACTIVE_STATUSES.has(currentSubscription.status)) return;
        } catch {
          // If Stripe no longer knows the stored subscription, persist the incoming source of truth.
        }
      }
    }

    const periodEnd = getCurrentPeriodEnd(subscription);
    const { error } = await admin.from('profiles').upsert(
      {
        user_id: userId,
        role: incomingIsActive ? 'pro' : 'free',
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status,
        subscription_current_period_end: periodEnd
          ? new Date(periodEnd * 1000).toISOString()
          : null,
        subscription_cancel_at_period_end: subscription.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (typeof session.subscription === 'string') {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await persistSubscription(
            subscription,
            session.client_reference_id ?? session.metadata?.user_id
          );
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const eventSubscription = event.data.object as Stripe.Subscription;
        // Read Stripe's current state so a delayed event cannot restore stale Pro access.
        const current = await stripe.subscriptions.retrieve(eventSubscription.id);
        await persistSubscription(current);
        break;
      }
      case 'customer.subscription.deleted': {
        await persistSubscription(event.data.object as Stripe.Subscription);
        break;
      }
    }
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'No se pudo actualizar el perfil' },
      500
    );
  }

  return json({ ok: true });
});
