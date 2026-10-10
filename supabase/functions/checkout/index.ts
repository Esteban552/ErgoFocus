// Edge Function: crea, verifica y cancela al fin del período la suscripción Pro.
// Secretos requeridos: STRIPE_SECRET_KEY, STRIPE_PRICE_ID
// Opcional: APP_RETURN_SCHEME (deep link de retorno, default "ergofocus")
import Stripe from 'npm:stripe@19.2.0';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripeSecret = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const stripe = new Stripe(stripeSecret, {
  apiVersion: '2025-10-29.clover',
});
const rawPriceId = (Deno.env.get('STRIPE_PRICE_ID') ?? '').trim();
const returnScheme = Deno.env.get('APP_RETURN_SCHEME') ?? 'ergofocus';

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

function subscriptionPayload(subscription: Stripe.Subscription) {
  const periodEnd = getCurrentPeriodEnd(subscription);
  const entitled = ACTIVE_STATUSES.has(subscription.status);
  return {
    role: entitled ? 'pro' as const : 'free' as const,
    stripe_customer_id:
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id,
    stripe_subscription_id: subscription.id,
    subscription_status: subscription.status,
    subscription_current_period_end: periodEnd
      ? new Date(periodEnd * 1000).toISOString()
      : null,
    subscription_cancel_at_period_end: subscription.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
  );
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return json({ error: 'No autenticado' }, 401);

  const bodyData = await req.json().catch(() => ({}));

  const { data: profile } = await admin
    .from('profiles')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();

  const persistSubscription = async (subscription: Stripe.Subscription) => {
    const payload = subscriptionPayload(subscription);
    const { error } = await admin.from('profiles').upsert(
      { user_id: user.id, ...payload },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
    return payload;
  };

  const resolveSubscription = async (): Promise<Stripe.Subscription | null> => {
    const requestedSessionId =
      typeof bodyData.session_id === 'string' ? bodyData.session_id.trim() : '';

    if (requestedSessionId) {
      const session = await stripe.checkout.sessions.retrieve(requestedSessionId);
      const belongsToUser =
        session.client_reference_id === user.id || session.metadata?.user_id === user.id;
      if (!belongsToUser) throw new Error('La sesión de pago no pertenece al usuario autenticado.');
      if (typeof session.subscription === 'string') {
        return stripe.subscriptions.retrieve(session.subscription);
      }
    }

    if (profile?.stripe_subscription_id) {
      return stripe.subscriptions.retrieve(profile.stripe_subscription_id);
    }

    const sessions = await stripe.checkout.sessions.list({ limit: 100 });
    const matchedSession = sessions.data.find(
      (session) =>
        (session.client_reference_id === user.id || session.metadata?.user_id === user.id) &&
        typeof session.subscription === 'string'
    );
    if (typeof matchedSession?.subscription !== 'string') return null;
    return stripe.subscriptions.retrieve(matchedSession.subscription);
  };

  if (bodyData.action === 'verify') {
    try {
      const subscription = await resolveSubscription();
      if (!subscription) {
        return json({
          ok: false,
          role: 'free',
          message: 'No se encontró una suscripción asociada a esta cuenta.',
        });
      }

      const payload = await persistSubscription(subscription);
      const active = payload.role === 'pro';
      return json({
        ok: active,
        ...payload,
        message: active
          ? 'Suscripción Pro verificada con éxito.'
          : 'La suscripción no está activa.',
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : 'Error al verificar con Stripe' },
        400
      );
    }
  }

  if (bodyData.action === 'cancel') {
    try {
      const current = await resolveSubscription();
      if (!current || !ACTIVE_STATUSES.has(current.status)) {
        return json({ error: 'No hay una suscripción activa para cancelar.' }, 400);
      }

      const subscription = await stripe.subscriptions.update(current.id, {
        cancel_at_period_end: true,
      });
      const payload = await persistSubscription(subscription);
      return json({
        ok: true,
        ...payload,
        message: payload.subscription_current_period_end
          ? `La renovación fue cancelada. El acceso Pro continúa hasta ${payload.subscription_current_period_end}.`
          : 'La renovación fue cancelada. El acceso Pro continúa hasta el fin del período pagado.',
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : 'Error al cancelar la renovación' },
        400
      );
    }
  }

  if (!rawPriceId) {
    return json({ error: 'Falta STRIPE_PRICE_ID en las variables de Supabase' }, 500);
  }

  try {
    if (profile?.stripe_subscription_id) {
      const existing = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      if (ACTIVE_STATUSES.has(existing.status)) {
        await persistSubscription(existing);
        return json({ error: 'Ya existe una suscripción Pro activa para esta cuenta.' }, 409);
      }
    }

    let effectivePriceId = rawPriceId;
    if (rawPriceId.startsWith('prod_')) {
      const prices = await stripe.prices.list({ product: rawPriceId, active: true, limit: 1 });
      if (!prices.data.length) {
        return json(
          { error: `El producto ${rawPriceId} no tiene ningún precio recurrente activo.` },
          400
        );
      }
      effectivePriceId = prices.data[0].id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ...(profile?.stripe_customer_id
        ? { customer: profile.stripe_customer_id }
        : { customer_email: user.email ?? undefined }),
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      line_items: [{ price: effectivePriceId, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id } },
      success_url: `${returnScheme}://payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnScheme}://payment/cancel`,
    });

    return json({ url: session.url });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Error al crear sesión en Stripe' },
      400
    );
  }
});
