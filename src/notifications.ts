import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { supabase } from './lib/supabase';

function getProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId
  );
}

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
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      showBadge: true,
    });
    // Canal por defecto también con MAX importancia para push genérico
    await Notifications.setNotificationChannelAsync('default', {
      name: 'General ErgoFocus',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      enableVibrate: true,
      showBadge: true,
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
): Promise<boolean> {
  const granted = await ensureReady();
  if (!granted) return false;
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
    return true;
  } catch {
    return false;
  }
}

/** Cancela una notificación local programada (pausa/reinicio del bloque). */
export async function cancelLocalNotification(id: string | null): Promise<void> {
  if (!id) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {}
}

/** Agenda una notificación local que se repite cada `seconds` segundos (la gestiona el SO). */
export async function scheduleRepeatingLocalNotification(
  id: string,
  title: string,
  body: string,
  seconds: number
): Promise<void> {
  const granted = await ensureReady();
  if (!granted) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
    await Notifications.scheduleNotificationAsync({
      identifier: id,
      content: { title, body, sound: 'default' },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
        seconds,
        repeats: true,
      },
    });
  } catch {}
}

/**
 * Envío exclusivamente remoto vía Edge Function `send-push` y Expo Push API.
 * No muestra notificación local: se usa como complemento de la programada.
 */
let lastRegisteredToken: string | null = null;

export async function sendRemotePushNotification(
  userId: string | null,
  title: string,
  body: string
): Promise<void> {
  if (!userId || !supabase || !canUseRemotePushNotifications()) return;
  try {
    if (!(await getNotificationPermission())) return;

    const projectId = getProjectId();
    const tokenData = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    if (!tokenData?.data) return;
    await supabase.functions.invoke('send-push', {
      body: { user_id: userId, title, body, token: tokenData.data, channelId: CHANNEL_ID },
    });
  } catch {
    // Si el push falla, la notificación local programada ya garantiza el aviso.
  }
}

export type PushRegistrationResult =
  | { ok: true }
  | { ok: false; message: string };

export async function registerForPushNotificationsAsync(
  userId: string | null
): Promise<PushRegistrationResult> {
  if (!canUseRemotePushNotifications()) {
    return { ok: false, message: 'Las notificaciones push remotas no están disponibles en este entorno.' };
  }
  try {
    await ensureChannel();
    if (!(await getNotificationPermission())) {
      return { ok: false, message: 'Las notificaciones están desactivadas en el sistema.' };
    }

    const projectId = getProjectId();
    if (!projectId) {
      return { ok: false, message: 'Falta vincular la aplicación con un proyecto EAS.' };
    }
    const tokenData = await Notifications.getExpoPushTokenAsync(
      { projectId }
    );
    const token = tokenData?.data;
    if (userId && token && supabase) {
      lastRegisteredToken = token;
      const { error } = await supabase.from('push_tokens').upsert(
        { user_id: userId, token },
        { onConflict: 'token' }
      );
      if (error) throw error;
      return { ok: true };
    }
    return { ok: false, message: 'No se pudo registrar este dispositivo para push remoto.' };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `Push remoto no configurado: ${error.message}`
          : 'No se pudo registrar este dispositivo para push remoto.',
    };
  }
}

/** Desvincula el token actual de Supabase al cerrar sesión. */
export async function unregisterPushTokenAsync(): Promise<void> {
  if (!supabase || !canUseRemotePushNotifications()) return;
  try {
    const projectId = getProjectId();
    const token =
      lastRegisteredToken ??
      (
        await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined
        ).catch(() => null)
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
  sedentarySeconds: number;
  enabled: boolean;
  liveSensorAlertsEnabled: boolean;
  nativeMonitoringRunning: boolean;
}

const TICK_MS = 30_000;
const BREAK_INTERVAL_SECONDS = 60 * 60;
const SEDENTARY_LIMIT_SECONDS = 60 * 60;
const RESCHEDULE_THROTTLE_MS = 30_000;
const SEDENTARY_ID = 'health-sedentary';
const BREAK_ID = 'health-break';

/**
 * Alertas de salud.
 * - Iluminación y ruido: notificación inmediata al cruzar el límite (requiere la app activa,
 *   porque dependen de lecturas en vivo).
 * - Sedentarismo y descanso cada hora: se agendan en el SO como notificaciones locales, por lo
 *   que llegan con la app en segundo plano o el teléfono bloqueado. El aviso de sedentarismo se
 *   reprograma cada vez que se detecta movimiento.
 */
export function useHealthAlerts(readings: HealthReadings): void {
  const ref = useRef({
    lightWarned: false,
    noiseWarned: false,
    lastSedentarySchedule: 0,
  });

  const readingsRef = useRef(readings);
  readingsRef.current = readings;

  const { enabled, sedentarySeconds } = readings;
  const { nativeMonitoringRunning } = readings;

  // Recordatorio horario de descanso, repetido y gestionado por el SO.
  useEffect(() => {
    if (!enabled || nativeMonitoringRunning) {
      void cancelLocalNotification(BREAK_ID);
      void cancelLocalNotification(SEDENTARY_ID);
      return;
    }
    void scheduleRepeatingLocalNotification(
      BREAK_ID,
      'Momento de descansar',
      'Llevás una hora de trabajo. Hacé una pausa breve y movete.',
      BREAK_INTERVAL_SECONDS
    );
  }, [enabled, nativeMonitoringRunning]);

  // Aviso de sedentarismo: se agenda a (último movimiento + 1 h) y se corre con cada movimiento.
  useEffect(() => {
    if (!enabled || nativeMonitoringRunning) return;
    const now = Date.now();
    const neverScheduled = ref.current.lastSedentarySchedule === 0;
    const justMoved = sedentarySeconds < 5;
    if (!neverScheduled && !(justMoved && now - ref.current.lastSedentarySchedule > RESCHEDULE_THROTTLE_MS)) {
      return;
    }
    ref.current.lastSedentarySchedule = now;
    const remaining = Math.max(1, SEDENTARY_LIMIT_SECONDS - sedentarySeconds);
    void scheduleLocalNotification(
      SEDENTARY_ID,
      'Sedentarismo detectado',
      'Llevás una hora sin moverte. Levantate, estirá las piernas y descansá la vista.',
      new Date(now + remaining * 1000)
    );
  }, [enabled, nativeMonitoringRunning, sedentarySeconds]);

  useEffect(() => {
    const interval = setInterval(() => {
      const acc = ref.current;
      const {
        lux,
        luxAvailable,
        decibels,
        enabled: on,
        liveSensorAlertsEnabled,
      } = readingsRef.current;
      if (!on || !liveSensorAlertsEnabled) return;

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
    }, TICK_MS);

    return () => clearInterval(interval);
  }, []);
}
