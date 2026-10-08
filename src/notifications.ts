import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import * as Notifications from 'expo-notifications';
import { supabase } from './lib/supabase';

export function canUseRemotePushNotifications(): boolean {
  if (Platform.OS === 'web') return false;
  if (Platform.OS === 'android' && isRunningInExpoGo()) return false;
  return true;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CHANNEL_ID = 'ergofocus-alerts';
let channelReady = false;

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android' || channelReady) return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Alertas ErgoFocus',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
    });
    channelReady = true;
  } catch {}
}

/**
 * Devuelve true si las notificaciones están (o quedan tras pedirlo) permitidas.
 * En Android 13+ esto pide el permiso POST_NOTIFICATIONS en runtime.
 */
export async function getNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.status === 'granted') return true;
    const requested = await Notifications.requestPermissionsAsync();
    return requested.status === 'granted';
  } catch {
    return false;
  }
}

/** Prepara canal (Android) y permiso antes de enviar/agendar. */
async function ensureReady(): Promise<boolean> {
  await ensureChannel();
  return getNotificationPermission();
}

function androidImmediateTrigger(): Notifications.NotificationTriggerInput {
  if (Platform.OS !== 'android') return null;
  return { channelId: CHANNEL_ID };
}

export async function sendLocalNotification(title: string, body: string): Promise<void> {
  const granted = await ensureReady();
  if (!granted) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: androidImmediateTrigger(),
    });
  } catch {
    // Las notificaciones pueden no estar disponibles (web, sin permiso).
  }
}

/** Crea los canales de Android al iniciar la app. */
export async function configureNotifications(): Promise<void> {
  await ensureChannel();
}

/**
 * Agenda una notificación local con fecha exacta. El SO la muestra aunque la
 * app esté en segundo plano o cerrada. `id` permite cancelarla luego.
 */
export async function scheduleLocalNotification(
  id: string,
  title: string,
  body: string,
  date: Date
): Promise<void> {
  const granted = await ensureReady();
  if (!granted) return;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: { title, body, sound: 'default' },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
        date: date instanceof Date ? date : new Date(date),
      },
    });
  } catch {
    // Sin permisos o en web: se ignora.
  }
}

/** Cancela una notificación local programada (pausa/reinicio del bloque). */
export async function cancelLocalNotification(id: string | null): Promise<void> {
  if (!id) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {}
}

/**
 * Envío exclusivamente remoto vía Edge Function `send-push` y Expo Push API.
 * No muestra notificación local: se usa como complemento de la programada.
 */
const EAS_PROJECT_ID = '5c793a31-5b87-4729-a8f3-5da3d12fe273';
let lastRegisteredToken: string | null = null;

export async function sendRemotePushNotification(
  userId: string | null,
  title: string,
  body: string
): Promise<void> {
  if (!userId || !supabase || !canUseRemotePushNotifications()) return;
  try {
    if (!(await getNotificationPermission())) return;

    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: EAS_PROJECT_ID,
    });
    if (!tokenData?.data) return;
    await supabase.functions.invoke('send-push', {
      body: { user_id: userId, title, body, token: tokenData.data },
    });
  } catch {
    // Si el push falla, la notificación local programada ya garantiza el aviso.
  }
}

export async function registerForPushNotificationsAsync(userId: string | null): Promise<void> {
  if (!canUseRemotePushNotifications()) return;
  try {
    if (!(await getNotificationPermission())) return;

    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: EAS_PROJECT_ID,
    });
    const token = tokenData?.data;
    if (userId && token && supabase) {
      lastRegisteredToken = token;
      await supabase.from('push_tokens').upsert(
        { user_id: userId, token },
        { onConflict: 'token' }
      );
    }
  } catch {
    // Si falla la obtención del token, las alertas locales siguen funcionando.
  }
}

/** Desvincula el token actual de Supabase al cerrar sesión. */
export async function unregisterPushTokenAsync(): Promise<void> {
  if (!supabase || !canUseRemotePushNotifications()) return;
  try {
    const token =
      lastRegisteredToken ??
      (
        await Notifications.getExpoPushTokenAsync({
          projectId: EAS_PROJECT_ID,
        }).catch(() => null)
      )?.data;

    if (token) {
      await supabase.from('push_tokens').delete().eq('token', token);
      lastRegisteredToken = null;
    }
  } catch {
    // Silencioso si falla
  }
}

interface HealthReadings {
  lux: number | null;
  luxAvailable: boolean;
  decibels: number | null;
  sedentaryAlert: boolean;
}

const TICK_MS = 30_000;
const BREAK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Envía una notificación local cuando alguno de los sensores llega a su límite
 * recomendado: iluminación fuera de 300-500 lux, ruido >= 70 dB, sedenterismo
 * (1 h sin movimiento). También recuerda un descanso cada hora. Con histéresis
 * por borde para no repetir el aviso continuamente.
 */
export function useHealthAlerts(readings: HealthReadings): void {
  const ref = useRef({
    lightWarned: false,
    noiseWarned: false,
    lastBreakAt: Date.now(),
    sedentaryHandled: false,
  });

  const readingsRef = useRef(readings);
  readingsRef.current = readings;

  useEffect(() => {
    const interval = setInterval(() => {
      const acc = ref.current;
      const { lux, luxAvailable, decibels, sedentaryAlert } = readingsRef.current;

      const lightBad = luxAvailable && lux !== null && (lux < 300 || lux > 500);
      if (lightBad && !acc.lightWarned) {
        acc.lightWarned = true;
        void sendLocalNotification(
          'Iluminación fuera de rango',
          'La luz recomendada es entre 300 y 500 lux. Ajustá tu iluminación para cuidar la vista.'
        );
      } else if (!lightBad && acc.lightWarned) {
        acc.lightWarned = false;
      }

      const noiseBad = decibels !== null && decibels >= 70;
      if (noiseBad && !acc.noiseWarned) {
        acc.noiseWarned = true;
        void sendLocalNotification(
          'Ruido por encima del límite',
          'El ambiente superó los 70 dB. Considerá aislarte del ruido para mantener la concentración.'
        );
      } else if (!noiseBad && acc.noiseWarned) {
        acc.noiseWarned = false;
      }

      if (Date.now() - acc.lastBreakAt >= BREAK_INTERVAL_MS) {
        acc.lastBreakAt = Date.now();
        void sendLocalNotification(
          'Momento de descansar',
          'Llevás una hora de trabajo. Hacé una pausa breve y movete.'
        );
      }

      if (sedentaryAlert && !acc.sedentaryHandled) {
        acc.sedentaryHandled = true;
        void sendLocalNotification(
          'Sedentarismo detectado',
          'Llevás una hora sin moverte. Levantate, estirá las piernas y descansá la vista.'
        );
      } else if (!sedentaryAlert && acc.sedentaryHandled) {
        acc.sedentaryHandled = false;
      }
    }, TICK_MS);

    return () => clearInterval(interval);
  }, []);
}