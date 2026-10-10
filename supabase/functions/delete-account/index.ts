// Edge Function: elimina la cuenta del usuario autenticado y todos sus datos.
//
// Deploy: supabase functions deploy delete-account
// (con verificación de JWT activada por defecto).
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe@19.2.0';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-10-29.clover',
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'No autenticado' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verificamos la sesión del usuario.
  const client = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );
  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'Sesión inválida' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Usamos credentials service_role para actualizar fuera de RLS.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const now = new Date().toISOString();

  // 1. Evitamos que una cuenta eliminada siga renovándose en Stripe.
  const { data: profile } = await admin
    .from('profiles')
    .select('stripe_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (profile?.stripe_subscription_id) {
    try {
      const subscription = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      if (['active', 'trialing', 'past_due'].includes(subscription.status)) {
        await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo cancelar la renovación';
      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // 2. Soft delete en base de datos: marcamos deleted_at y pasamos a rol free
  const { error: profileError } = await admin
    .from('profiles')
    .update({ deleted_at: now, role: 'free' })
    .eq('user_id', user.id);

  if (profileError) {
    return new Response(JSON.stringify({ error: profileError.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Eliminamos los tokens push para que no reciba alertas
  await admin.from('push_tokens').delete().eq('user_id', user.id);

  // 4. Marcamos metadatos en Supabase Auth y revocamos sesiones
  await admin.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...(user.app_metadata ?? {}),
      deleted: true,
      deleted_at: now,
    },
  });

  const token = authHeader.replace(/^Bearer\s+/i, '');
  await admin.auth.admin.signOut(token, 'global').catch(() => {});

  return new Response(
    JSON.stringify({ ok: true, soft_delete: true, deleted_at: now }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
});
