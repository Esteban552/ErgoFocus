// Edge Function: crea una sesión de Stripe Checkout para la suscripción Pro.
// Secretos requeridos: STRIPE_SECRET_KEY, STRIPE_PRICE_ID
// Opcional: APP_RETURN_SCHEME (deep link de retorno, default "ergofocus")
//
// Deploy: supabase functions deploy checkout --no-verify-jwt
import Stripe from 'npm:stripe@18';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-11-20.acacia',
});
const priceId = Deno.env.get('STRIPE_PRICE_ID') ?? '';
const returnScheme = Deno.env.get('APP_RETURN_SCHEME') ?? 'ergofocus';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
  );

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'No autenticado' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!priceId) {
    return new Response(JSON.stringify({ error: 'Falta STRIPE_PRICE_ID' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: user.email ?? undefined,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: { user_id: user.id } },
    success_url: `${returnScheme}://payment/success`,
    cancel_url: `${returnScheme}://payment/cancel`,
  });

  return new Response(JSON.stringify({ url: session.url }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});