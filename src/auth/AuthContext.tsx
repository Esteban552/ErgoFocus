import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Session } from '@supabase/supabase-js';
import {
  isSupabaseConfigured,
  supabase,
  supabaseConfigurationError,
} from '../lib/supabase';
import { unregisterPushTokenAsync } from '../notifications';

export type AuthActionResult =
  | { ok: true; confirmationRequired?: boolean }
  | { ok: false; message: string };

interface AuthContextValue {
  session: Session | null;
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
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  const retryInitialization = useCallback(async () => {
    setInitializing(true);
    setInitError(null);

    if (!supabase) {
      setSession(null);
      setInitializing(false);
      return;
    }

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
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

    if (!supabase) return;

    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => data.subscription.unsubscribe();
  }, [retryInitialization]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthActionResult> => {
    if (!supabase) return unavailableResult();

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: normalizeEmail(email),
        password,
      });
      if (error) {
        return {
          ok: false,
          message: normalizeAuthError(error, 'No se pudo iniciar sesión. Intentá nuevamente.'),
        };
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
      const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email));
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
