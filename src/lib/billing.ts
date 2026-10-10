import { supabase } from './supabase';

export type Role = 'free' | 'pro';

export interface SubscriptionInfo {
  role: Role;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export async function getSubscriptionInfo(
  userId: string | null
): Promise<SubscriptionInfo | null> {
  if (!userId || !supabase) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select(
      'role, deleted_at, subscription_status, subscription_current_period_end, subscription_cancel_at_period_end'
    )
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data || data.deleted_at) return null;

  const periodExpired =
    data.subscription_cancel_at_period_end &&
    data.subscription_current_period_end !== null &&
    new Date(data.subscription_current_period_end).getTime() <= Date.now();
  return {
    role: periodExpired ? 'free' : data.role,
    status: data.subscription_status,
    currentPeriodEnd: data.subscription_current_period_end,
    cancelAtPeriodEnd: data.subscription_cancel_at_period_end,
  };
}

export async function getProfileRole(userId: string | null): Promise<Role | null> {
  return (await getSubscriptionInfo(userId))?.role ?? null;
}

export type CheckoutResult = { ok: true; url: string } | { ok: false; message: string };

/** Crea una sesión de Stripe Checkout y devuelve la URL para abrir el navegador. */
export async function startCheckout(): Promise<CheckoutResult> {
  if (!supabase) return { ok: false, message: 'Supabase no está configurado.' };
  const { data, error } = await supabase.functions.invoke('checkout', { method: 'POST' });
  if (error) {
    let detail = error.message;
    const response = (error as { context?: unknown }).context;
    if (response instanceof Response) {
      try {
        const body = (await response.json()) as { error?: string };
        if (body?.error) detail = body.error;
      } catch {}
    }
    return { ok: false, message: `No se pudo crear la sesión de pago: ${detail}` };
  }
  const url = (data as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || !url) {
    return { ok: false, message: 'El servidor no devolvió una URL de pago.' };
  }
  return { ok: true, url };
}

/** Elimina la cuenta de Supabase y todos sus registros (requiere desplegar la Edge Function). */
export async function deleteAccount(): Promise<void> {
  if (!supabase) throw new Error('Supabase no está configurado.');
  const { error } = await supabase.functions.invoke('delete-account');
  if (error) throw error;
}

export type SubscriptionVerificationResult =
  | { ok: true; role: Role; message?: string }
  | { ok: false; role: Role; message: string };

/** Verifica directamente con Stripe si el usuario tiene una suscripción o pago completado. */
export async function verifySubscription(
  sessionId?: string | null
): Promise<SubscriptionVerificationResult> {
  if (!supabase) return { ok: false, role: 'free', message: 'Supabase no está configurado.' };
  try {
    const { data, error } = await supabase.functions.invoke('checkout', {
      body: { action: 'verify', session_id: sessionId ?? undefined },
    });
    if (error) {
      return { ok: false, role: 'free', message: error.message };
    }
    const result = data as { ok?: boolean; role?: Role; message?: string } | null;
    if (result?.ok && result.role === 'pro') {
      return { ok: true, role: 'pro', message: result.message };
    }
    return {
      ok: false,
      role: 'free',
      message: result?.message ?? 'No se detectó una suscripción activa.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Error al verificar con el servidor';
    return { ok: false, role: 'free', message: msg };
  }
}

export type CancellationResult =
  | { ok: true; currentPeriodEnd: string | null; message: string }
  | { ok: false; message: string };

/** Cancela la renovación, pero conserva Pro hasta terminar el período ya pagado. */
export async function cancelSubscriptionRenewal(): Promise<CancellationResult> {
  if (!supabase) return { ok: false, message: 'Supabase no está configurado.' };
  try {
    const { data, error } = await supabase.functions.invoke('checkout', {
      body: { action: 'cancel' },
    });
    if (error) {
      let detail = error.message;
      const response = (error as { context?: unknown }).context;
      if (response instanceof Response) {
        try {
          const body = (await response.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {}
      }
      return { ok: false, message: detail };
    }
    const result = data as {
      ok?: boolean;
      subscription_current_period_end?: string | null;
      message?: string;
    } | null;
    if (!result?.ok) {
      return { ok: false, message: result?.message ?? 'No se pudo cancelar la renovación.' };
    }
    return {
      ok: true,
      currentPeriodEnd: result.subscription_current_period_end ?? null,
      message: result.message ?? 'La renovación fue cancelada.',
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'No se pudo cancelar la renovación.',
    };
  }
}
