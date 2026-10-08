import { supabase } from './supabase';

export type Role = 'free' | 'pro';

export async function getProfileRole(userId: string | null): Promise<Role | null> {
  if (!userId || !supabase) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return null;
  return (data?.role as Role | undefined) ?? 'free';
}

/** Crea una sesión de Stripe Checkout y devuelve la URL para abrir el navegador. */
export async function startCheckout(): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.functions.invoke('checkout');
  if (error || !data || typeof (data as { url?: unknown }).url !== 'string') return null;
  return (data as { url: string }).url;
}

/** Elimina la cuenta de Supabase y todos sus registros (requiere desplegar la Edge Function). */
export async function deleteAccount(): Promise<void> {
  if (!supabase) return;
  await supabase.functions.invoke('delete-account');
}