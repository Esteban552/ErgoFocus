// Edge Function: webhook de Stripe que actualiza el rol Pro de los usuarios.
// Secreto requerido: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY
import Stripe from 'npm:stripe@18';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-11-20.acacia',
});
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

async function setRole(userId: string, role: 'free' | 'pro', customerId?: string | null) {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );
  await admin.from('profiles').upsert(
    {
      user_id: userId,
      role,
      stripe_customer_id: customerId ?? undefined,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
}

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response(JSON.stringify({ error: 'Falta firma' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Firma inválida';
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id ?? session.metadata?.user_id;
      if (userId) {
        await setRole(userId, 'pro', session.customer as string);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      let userId = subscription.metadata?.user_id;
      const customerId = subscription.customer as string;

      // Fallback por stripe_customer_id si no vino metadata.user_id
      if (!userId && customerId) {
        const admin = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );
        const { data: profile } = await admin
          .from('profiles')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (profile?.user_id) {
          userId = profile.user_id;
        }
      }

      if (userId) {
        await setRole(userId, 'free', customerId);
      }
      break;
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});