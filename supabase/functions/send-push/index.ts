// Edge Function: envía una notificación push a un usuario vía Expo Push API.
// Incluye limpieza automática de tokens caducados (DeviceNotRegistered).
import { createClient } from 'npm:@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const authHeader = req.headers.get('Authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader ?? '' } },
  });

  const {
    data: { user },
  } = await client.auth.getUser();

  const bodyData = await req.json().catch(() => ({}));
  const { title, body, token, user_id } = bodyData;

  const targetUserId = user?.id ?? user_id;

  if (!title || !body) {
    return new Response(JSON.stringify({ error: 'Faltan campos (title, body)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  let tokensToUse: string[] = [];
  if (token) {
    tokensToUse = [token];
  } else if (targetUserId) {
    const { data: stored } = await admin
      .from('push_tokens')
      .select('token')
      .eq('user_id', targetUserId);
    tokensToUse = (stored ?? []).map((row: { token: string }) => row.token);
  }

  if (tokensToUse.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, sent: 0, message: 'Sin tokens activos' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const pushChannel = bodyData.channelId || 'ergofocus-alerts';

  const messages = tokensToUse.map((t) => ({
    to: t,
    title,
    body,
    sound: 'default',
    channelId: pushChannel,
    priority: 'high',
    _displayInForeground: true,
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
  const result = await response.json();

  // Limpieza de tokens que ya no son válidos en Expo
  if (result?.data && Array.isArray(result.data)) {
    const invalidTokens: string[] = [];
    result.data.forEach((ticket: { status: string; details?: { error?: string } }, index: number) => {
      if (
        ticket.status === 'error' &&
        ticket.details?.error === 'DeviceNotRegistered'
      ) {
        invalidTokens.push(tokensToUse[index]);
      }
    });

    if (invalidTokens.length > 0) {
      await admin.from('push_tokens').delete().in('token', invalidTokens);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, sent: messages.length, expo: result }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
});