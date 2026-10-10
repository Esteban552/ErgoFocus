import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Linking, Alert, AppState } from 'react-native';
import { Session } from '@supabase/supabase-js';
import {
  isSupabaseConfigured,
  supabase,
  supabaseConfigurationError,
} from '../lib/supabase';
import { unregisterPushTokenAsync } from '../notifications';
import { getProfileRole, verifySubscription, Role } from '../lib/billing';

const AUTH_REDIRECT_URL =
  process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL || 'ergofocus://auth-callback';

async function checkIsSoftDeleted(userId: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { data } = await supabase
      .from('profiles')
      .select('deleted_at')
      .eq('user_id', userId)
      .maybeSingle();
    return Boolean(data?.deleted_at);
  } catch {
    return false;
  }
}

export type AuthActionResult =
  | { ok: true; confirmationRequired?: boolean }
  | { ok: false; message: string };

interface AuthContextValue {
  session: Session | null;
  role: Role | null;
  isPro: boolean;
  refreshRole: () => Promise<Role | null>;
  initializing: boolean;
  initError: string | null;
  configurationError: string | null;
  configured: boolean;
  userId: string | null;
  retryInitialization: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<AuthActionResult>;
  signUp: (email: string, password: string) => Promise<AuthActionResult>;
  signOut: () => Promise<AuthActionResult>;
  resetPassword: (email: string) => Promise<AuthActionResult>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeAuthError(error: unknown, fallback: string): string {
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const status = typeof candidate?.status === 'number' ? candidate.status : 0;

  switch (code) {
    case 'invalid_credentials':
      return 'El email o la contraseña son incorrectos.';
    case 'email_not_confirmed':
      return 'Confirmá tu email antes de iniciar sesión.';
    case 'user_already_exists':
    case 'email_exists':
    case 'user_already_registered':
      return 'Ya existe una cuenta con ese email.';
    case 'weak_password':
      return 'La contraseña no cumple los requisitos de seguridad.';
    case 'over_email_send_rate_limit':
      return 'Se enviaron demasiados emails. Esperá unos minutos e intentá nuevamente.';
    case 'over_request_rate_limit':
    case 'request_timeout':
      return 'Hay demasiadas solicitudes. Esperá un momento e intentá nuevamente.';
    case 'validation_failed':
      return 'Revisá los datos ingresados e intentá nuevamente.';
  }

  if (status === 429) {
    return 'Hay demasiadas solicitudes. Esperá un momento e intentá nuevamente.';
  }

  if (error instanceof TypeError) {
    return 'No se pudo conectar con Supabase. Revisá tu conexión a internet.';
  }

  return fallback;
}

function unavailableResult(): AuthActionResult {
  return {
    ok: false,
    message:
      supabaseConfigurationError ??
      'La autenticación no está disponible. Revisá la configuración de Supabase.',
  };
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  const refreshRole = useCallback(async (): Promise<Role | null> => {
    const uid = session?.user.id;
    if (!uid) {
      setRole(null);
      return null;
    }
    const current = await getProfileRole(uid);
    setRole(current);
    return current;
  }, [session?.user.id]);

  useEffect(() => {
    void refreshRole();
  }, [refreshRole]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshRole();
    });
    return () => subscription.remove();
  }, [refreshRole]);

  const retryInitialization = useCallback(async () => {
    setInitializing(true);
    setInitError(null);

    const client = supabase;
    if (!client) {
      setSession(null);
      setInitializing(false);
      return;
    }

    try {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session?.user) {
        const isDeleted =
          Boolean(data.session.user.app_metadata?.deleted) ||
          (await checkIsSoftDeleted(data.session.user.id));
        if (isDeleted) {
          await client.auth.signOut().catch(() => {});
          setSession(null);
          return;
        }
      }
      setSession(data.session);
    } catch (error) {
      setSession(null);
      setInitError(
        normalizeAuthError(
          error,
          'No se pudo recuperar tu sesión. Revisá tu conexión e intentá nuevamente.'
        )
      );
    } finally {
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    void retryInitialization();

    const client = supabase;
    if (!client) return;

    const { data } = client.auth.onAuthStateChange(async (_event, newSession) => {
      if (newSession?.user) {
        const isDeleted =
          Boolean(newSession.user.app_metadata?.deleted) ||
          (await checkIsSoftDeleted(newSession.user.id));
        if (isDeleted) {
          await client.auth.signOut().catch(() => {});
          setSession(null);
          return;
        }
      }
      setSession(newSession);
    });

    return () => data.subscription.unsubscribe();
  }, [retryInitialization]);

  // Deep linking para confirmar email, login mágico o retorno de pago (ergofocus://payment/success)
  useEffect(() => {
    const client = supabase;
    if (!client) return;

    const handleDeepLink = async (url: string | null) => {
      if (!url) return;
      try {
        // 1. Retorno de Stripe Checkout (éxito)
        if (url.includes('payment/success')) {
          const query = url.includes('?') ? url.split('?')[1].split('#')[0] : '';
          const sessionId = new URLSearchParams(query).get('session_id');
          const verification = await verifySubscription(sessionId);
          if (verification.ok && verification.role === 'pro') {
            setRole('pro');
            Alert.alert(
              '¡Suscripción Pro Activada!',
              'Tu pago se confirmó con éxito. Todas las funciones Pro ya están desbloqueadas.'
            );
            return;
          }
          // Polling por si el webhook de Stripe tarda unos segundos.
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const updated = await refreshRole();
            if (updated === 'pro') {
              Alert.alert(
                '¡Suscripción Pro Activada!',
                'Tu suscripción fue confirmada. Ya podés disfrutar de los beneficios Pro.'
              );
              return;
            }
          }
          Alert.alert(
            'Pago en verificación',
            'Stripe todavía no confirmó una suscripción activa. Podés verificar nuevamente desde Perfil en unos segundos.'
          );
          return;
        }

        // 2. Retorno de Stripe Checkout (cancelado)
        if (url.includes('payment/cancel')) {
          Alert.alert('Pago cancelado', 'No se realizó ningún cobro en Stripe.');
          return;
        }

        // 3. Confirmación con token en hash: #access_token=...&refresh_token=...
        if (url.includes('#')) {
          const hash = url.split('#')[1];
          const params = new URLSearchParams(hash);
          const accessToken = params.get('access_token');
          const refreshToken = params.get('refresh_token');
          if (accessToken && refreshToken) {
            const { data, error } = await client.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
            if (!error && data.session) {
              setSession(data.session);
            }
            return;
          }
        }

        // 4. Código PKCE: ?code=...
        if (url.includes('code=')) {
          const query = url.includes('?') ? url.split('?')[1] : '';
          const params = new URLSearchParams(query);
          const code = params.get('code');
          if (code) {
            const { data, error } = await client.auth.exchangeCodeForSession(code);
            if (!error && data.session) {
              setSession(data.session);
            }
            return;
          }
        }
      } catch (err) {
        console.warn('Error al procesar el deep link:', err);
        Alert.alert(
          'No se pudo procesar el enlace',
          'Volvé a intentarlo desde el correo o verificá el pago desde Perfil.'
        );
      }
    };

    void Linking.getInitialURL().then(handleDeepLink);
    const sub = Linking.addEventListener('url', (event) => {
      void handleDeepLink(event.url);
    });

    return () => sub.remove();
  }, [refreshRole]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthActionResult> => {
    const client = supabase;
    if (!client) return unavailableResult();

    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: normalizeEmail(email),
        password,
      });
      if (error) {
        return {
          ok: false,
          message: normalizeAuthError(error, 'No se pudo iniciar sesión. Intentá nuevamente.'),
        };
      }
      if (data.user) {
        const isDeleted =
          Boolean(data.user.app_metadata?.deleted) ||
          (await checkIsSoftDeleted(data.user.id));
        if (isDeleted) {
          await client.auth.signOut().catch(() => {});
          setSession(null);
          return {
            ok: false,
            message: 'Esta cuenta fue dada de baja. Si necesitás reactivarla, contactá a soporte.',
          };
        }
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: normalizeAuthError(error, 'No se pudo iniciar sesión. Intentá nuevamente.'),
      };
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<AuthActionResult> => {
    if (!supabase) return unavailableResult();

    try {
      const { data, error } = await supabase.auth.signUp({
        email: normalizeEmail(email),
        password,
        options: {
          emailRedirectTo: AUTH_REDIRECT_URL,
        },
      });
      if (error) {
        return {
          ok: false,
          message: normalizeAuthError(error, 'No se pudo crear la cuenta. Intentá nuevamente.'),
        };
      }
      return { ok: true, confirmationRequired: !data.session };
    } catch (error) {
      return {
        ok: false,
        message: normalizeAuthError(error, 'No se pudo crear la cuenta. Intentá nuevamente.'),
      };
    }
  }, []);

  const signOut = useCallback(async (): Promise<AuthActionResult> => {
    if (!supabase) {
      setSession(null);
      return unavailableResult();
    }

    try {
      await unregisterPushTokenAsync();
      const { error } = await supabase.auth.signOut();
      if (error) {
        return {
          ok: false,
          message: normalizeAuthError(error, 'No se pudo cerrar la sesión. Intentá nuevamente.'),
        };
      }
      setSession(null);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: normalizeAuthError(error, 'No se pudo cerrar la sesión. Intentá nuevamente.'),
      };
    }
  }, []);

  const resetPassword = useCallback(async (email: string): Promise<AuthActionResult> => {
    if (!supabase) return unavailableResult();

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
        redirectTo: AUTH_REDIRECT_URL,
      });
      if (error) {
        return {
          ok: false,
          message: normalizeAuthError(
            error,
            'No se pudo enviar el email de recuperación. Intentá nuevamente.'
          ),
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: normalizeAuthError(
          error,
          'No se pudo enviar el email de recuperación. Intentá nuevamente.'
        ),
      };
    }
  }, []);

  const value: AuthContextValue = {
    session,
    role,
    isPro: role === 'pro',
    refreshRole,
    initializing,
    initError,
    configurationError: supabaseConfigurationError,
    configured: isSupabaseConfigured,
    userId: session?.user.id ?? null,
    retryInitialization,
    signIn,
    signUp,
    signOut,
    resetPassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return ctx;
}
