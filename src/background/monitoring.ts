import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { getNotificationPermission } from '../notifications';
import NativeMonitoring, {
  BackgroundMonitoringSnapshot,
} from '../../modules/ergofocus-background-monitoring/src/ErgoFocusBackgroundMonitoringModule';

const STORAGE_KEY_PREFIX = 'ergofocus:background-monitoring';

const EMPTY_SNAPSHOT: BackgroundMonitoringSnapshot = {
  running: false,
  lux: null,
  decibels: null,
  accelerationMagnitude: null,
  rotationSpeed: null,
  lastMovementAt: 0,
  microphoneAvailable: false,
  lightAvailable: false,
  movementAvailable: false,
  gyroAvailable: false,
  lightWakeUp: false,
  movementWakeUp: false,
  gyroWakeUp: false,
  error: null,
};

export function isMonitoringSupported(): boolean {
  return Platform.OS === 'android' && NativeMonitoring !== null;
}

async function startService(): Promise<void> {
  if (!NativeMonitoring || (await NativeMonitoring.isRunningAsync())) return;
  await NativeMonitoring.startAsync();
}

async function stopService(): Promise<void> {
  if (NativeMonitoring) await NativeMonitoring.stopAsync();
}

export interface BackgroundMonitoring {
  supported: boolean;
  enabled: boolean;
  busy: boolean;
  error: string | null;
  snapshot: BackgroundMonitoringSnapshot;
  setEnabled: (value: boolean) => Promise<void>;
}

/**
 * Persistent toggle for monitoring with the screen off / app in background.
 * The preference is scoped per user and restored only while that user is signed in.
 */
export function useBackgroundMonitoring(userId: string | null): BackgroundMonitoring {
  const supported = isMonitoringSupported();
  const active = Boolean(userId);
  const storageKey = userId ? `${STORAGE_KEY_PREFIX}:${userId}` : null;
  const [enabled, setEnabledState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<BackgroundMonitoringSnapshot>(EMPTY_SNAPSHOT);

  const enable = useCallback(async (): Promise<boolean> => {
    let mic = await getRecordingPermissionsAsync();
    if (!mic.granted && mic.canAskAgain) mic = await requestRecordingPermissionsAsync();
    if (!mic.granted) {
      setError('Se necesita el permiso de micrófono para medir el ruido en segundo plano.');
      return false;
    }
    if (!(await getNotificationPermission())) {
      setError('Activá las notificaciones de ErgoFocus para usar el monitoreo en segundo plano.');
      return false;
    }
    await startService();
    if (!NativeMonitoring) return false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const current = await NativeMonitoring.getSnapshotAsync().catch(() => null);
      if (current?.error) {
        setError(current.error);
        await stopService().catch(() => undefined);
        return false;
      }
      if (current?.running && current.microphoneAvailable) {
        setSnapshot(current);
        return true;
      }
    }
    setError('El servicio nativo no pudo iniciar correctamente.');
    await stopService().catch(() => undefined);
    return false;
  }, []);

  useEffect(() => {
    if (!supported || !enabled || !NativeMonitoring) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }

    const nativeMonitoring = NativeMonitoring;
    let cancelled = false;
    const refresh = async () => {
      const current = await nativeMonitoring.getSnapshotAsync().catch(() => null);
      if (!cancelled && current) {
        setSnapshot(current);
        if (current.error) setError(current.error);
        if (!current.running) {
          setEnabledState(false);
          setError('Android detuvo el monitoreo. Volvé a activarlo desde Perfil.');
        }
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, supported]);

  // Restore the saved preference and (re)start the service on launch / login.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      const saved = storageKey ? (await AsyncStorage.getItem(storageKey)) === '1' : false;
      if (cancelled) return;
      if (!active) {
        await stopService().catch(() => undefined);
        setEnabledState(false);
        return;
      }
      if (!saved) {
        setEnabledState(false);
        return;
      }
      try {
        const ok = await enable();
        if (!cancelled) setEnabledState(ok);
      } catch {
        if (!cancelled) setEnabledState(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, storageKey, supported, enable]);

  const setEnabled = useCallback(
    async (value: boolean) => {
      if (!supported || busy) return;
      setBusy(true);
      setError(null);
      try {
        if (value) {
          const ok = await enable();
          setEnabledState(ok);
          if (storageKey) await AsyncStorage.setItem(storageKey, ok ? '1' : '0');
        } else {
          await stopService();
          setEnabledState(false);
          if (storageKey) await AsyncStorage.setItem(storageKey, '0');
        }
      } catch {
        setError('No se pudo cambiar el monitoreo en segundo plano.');
        setEnabledState(false);
      } finally {
        setBusy(false);
      }
    },
    [busy, enable, storageKey, supported]
  );

  return { supported, enabled, busy, error, snapshot, setEnabled };
}

export async function canScheduleExactAlarms(): Promise<boolean> {
  if (Platform.OS !== 'android' || !NativeMonitoring) return true;
  return NativeMonitoring.canScheduleExactAlarmsAsync();
}

export async function openExactAlarmSettings(): Promise<void> {
  if (Platform.OS === 'android' && NativeMonitoring) {
    await NativeMonitoring.openExactAlarmSettingsAsync();
  }
}
