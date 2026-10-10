import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import Constants from 'expo-constants';

import { Database } from '../types/database.types';

// process.env vale en desarrollo (.env); en builds EAS/APK el .env no se incluye
// (está en .gitignore), por eso se usa `extra` de app.json como respaldo.
const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
const fromExtra = (name: string): string | undefined =>
  typeof extra[name] === 'string' ? (extra[name] as string) : undefined;

const url = (process.env.EXPO_PUBLIC_SUPABASE_URL || fromExtra('EXPO_PUBLIC_SUPABASE_URL'))?.trim();
const publishableKey = (
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || fromExtra('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
)?.trim();
const anonKey = (
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || fromExtra('EXPO_PUBLIC_SUPABASE_ANON_KEY')
)?.trim();
const key = publishableKey || anonKey;

function validateConfiguration(): string | null {
  if (!url) {
    return 'Falta EXPO_PUBLIC_SUPABASE_URL en la configuración de la aplicación.';
  }

  if (!key) {
    return 'Falta EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY (o EXPO_PUBLIC_SUPABASE_ANON_KEY) en la configuración de la aplicación.';
  }

  try {
    const parsedUrl = new URL(url);
    const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
      parsedUrl.hostname
    );
    if (
      !['http:', 'https:'].includes(parsedUrl.protocol) ||
      (parsedUrl.protocol === 'http:' && !isLoopback) ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      return 'EXPO_PUBLIC_SUPABASE_URL no es una URL válida de Supabase.';
    }
  } catch {
    return 'EXPO_PUBLIC_SUPABASE_URL no es una URL válida de Supabase.';
  }

  const hasPlaceholder = /TU[-_ ]?(PROYECTO|ANON|KEY)|YOUR[-_ ]?(PROJECT|KEY)/i;
  if (hasPlaceholder.test(url) || hasPlaceholder.test(key)) {
    return 'Las credenciales de Supabase todavía contienen valores de ejemplo.';
  }

  if (key.startsWith('sb_secret_')) {
    return 'La aplicación no puede usar una clave secreta de Supabase. Configurá una clave pública.';
  }

  const isPublishableKey = /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key);
  const isLegacyAnonKey = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key);
  if (!isPublishableKey && !isLegacyAnonKey) {
    return 'La clave pública de Supabase tiene un formato inválido.';
  }

  return null;
}

let configurationError = validateConfiguration();
let client: SupabaseClient<Database> | null = null;

if (!configurationError) {
  try {
    client = createClient<Database>(url as string, key as string, {
      auth: {
        ...(Platform.OS !== 'web' ? { storage: AsyncStorage } : {}),
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
  } catch {
    configurationError = 'No se pudo inicializar el cliente de Supabase. Revisá la configuración.';
  }
}

export const supabase = client;
export const supabaseConfigurationError = configurationError;
export const isSupabaseConfigured = supabase !== null;

if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
