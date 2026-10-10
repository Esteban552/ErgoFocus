import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Linking, AppState, Alert, TextInput } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Play,
  Pause,
  RotateCcw,
  ArrowUpRight,
  Crown,
  CheckCircle2,
  Sun,
  Volume2,
  Rotate3d,
  Footprints,
} from 'lucide-react-native';
import { SensorState } from '../sensors/useSensors';
import { Gradient } from './Gradient';
import { soundService } from '../utils/audio';
import { useAuth } from '../auth/AuthContext';
import {
  cancelLocalNotification,
  scheduleLocalNotification,
  sendLocalNotification,
  getNotificationPermission,
} from '../notifications';
import { startCheckout, verifySubscription } from '../lib/billing';
import { formatDuration } from '../lib/format';
import {
  canScheduleExactAlarms,
  openExactAlarmSettings,
} from '../background/monitoring';

const DURATION_PRESETS = [15, 25, 45, 60];
const MIN_DURATION_MIN = 1;
const MAX_DURATION_MIN = 240;
const FOCUS_STORAGE_KEY_PREFIX = 'ergofocus:focus-session';

interface PersistedFocusSession {
  active: boolean;
  endAt: number | null;
  remainingMs: number;
  focusMinutes: number;
  distractions: number;
  blockMinutes: number;
  notificationId: string | null;
}

export type NoiseStatus = 'sin-medicion' | 'silencioso' | 'moderado' | 'ruidoso';

interface Props {
  sensors: SensorState;
  decibels: number | null;
  noiseStatus: NoiseStatus;
  onNavigateToAmbient: () => void;
}

export const DashboardTab: React.FC<Props> = ({ sensors, decibels, noiseStatus, onNavigateToAmbient }) => {
  const { session, userId, role, isPro, refreshRole } = useAuth();
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const [remainingMs, setRemainingMs] = useState(25 * 60 * 1000);
  const [active, setActive] = useState(false);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [distractions, setDistractions] = useState(0);
  const [focusMinutes, setFocusMinutes] = useState(25);
  const [durationText, setDurationText] = useState('25');
  const [focusBusy, setFocusBusy] = useState(false);
  const endedRef = useRef<number | null>(null);
  const blockMinutesRef = useRef(25);
  const lastPresetRef = useRef(25);
  const scheduledNotificationIdRef = useRef<string | null>(null);
  const manipulationHandledRef = useRef(false);
  const focusActionRef = useRef(0);
  const focusStorageKey = userId ? `${FOCUS_STORAGE_KEY_PREFIX}:${userId}` : null;

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshRole();
    });
    return () => sub.remove();
  }, [refreshRole]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!focusStorageKey) return;
    let cancelled = false;
    void AsyncStorage.getItem(focusStorageKey)
      .then((raw) => {
        if (cancelled || !raw) return;
        const saved = JSON.parse(raw) as Partial<PersistedFocusSession>;
        const savedMinutes = Math.min(
          MAX_DURATION_MIN,
          Math.max(MIN_DURATION_MIN, Number(saved.focusMinutes) || 25)
        );
        setFocusMinutes(savedMinutes);
        setDurationText(String(savedMinutes));
        setDistractions(Math.max(0, Number(saved.distractions) || 0));
        blockMinutesRef.current = Math.max(1, Number(saved.blockMinutes) || savedMinutes);
        scheduledNotificationIdRef.current = saved.notificationId ?? null;

        if (saved.active && typeof saved.endAt === 'number' && saved.endAt > Date.now()) {
          setEndAt(saved.endAt);
          setRemainingMs(saved.endAt - Date.now());
          setActive(true);
          setClockNow(Date.now());
        } else {
          setEndAt(null);
          const expired = saved.active && typeof saved.endAt === 'number';
          setRemainingMs(expired ? 0 : Math.max(0, Number(saved.remainingMs) || savedMinutes * 60_000));
          setActive(false);
          if (expired) void AsyncStorage.removeItem(focusStorageKey);
        }
      })
      .catch(() => undefined)
      .finally(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [focusStorageKey]);

  const isActive = active && endAt !== null;
  const displayRemaining = isActive ? Math.max(0, endAt! - clockNow) : remainingMs;
  const totalSeconds = Math.ceil(displayRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  useEffect(() => {
    if (!isActive || endAt === null || endAt > clockNow) return;
    if (endedRef.current === endAt) return;
    endedRef.current = endAt;
    setActive(false);
    setRemainingMs(0);
    setEndAt(null);
    if (scheduledNotificationIdRef.current) {
      void cancelLocalNotification(scheduledNotificationIdRef.current);
      scheduledNotificationIdRef.current = null;
    }
    soundService.playSuccessChime();
    if (focusStorageKey) void AsyncStorage.removeItem(focusStorageKey);
  }, [clockNow, endAt, focusStorageKey, isActive]);

  // Distracción del Modo Enfoque: si el giroscopio detecta que tomás el celular
  // durante una sesión activa, se cuenta una distracción (se muestra como texto).
  useEffect(() => {
    if (!isActive) {
      manipulationHandledRef.current = false;
      return;
    }
    if (sensors.manipulated && !manipulationHandledRef.current) {
      manipulationHandledRef.current = true;
      setDistractions((d) => d + 1);
      void sendLocalNotification(
        'Distracción en tu bloque',
        'Se detectó que tomaste el teléfono durante la sesión de enfoque.'
      );
    } else if (!sensors.manipulated && manipulationHandledRef.current) {
      manipulationHandledRef.current = false;
    }
  }, [isActive, sensors.manipulated]);

  const toggleFocus = async () => {
    if (isActive) {
      focusActionRef.current += 1;
      const left = Math.max(0, endAt! - Date.now());
      setRemainingMs(left);
      setActive(false);
      setEndAt(null);
      if (scheduledNotificationIdRef.current) {
        void cancelLocalNotification(scheduledNotificationIdRef.current);
        scheduledNotificationIdRef.current = null;
      }
      if (focusStorageKey) {
        const paused: PersistedFocusSession = {
          active: false,
          endAt: null,
          remainingMs: left,
          focusMinutes,
          distractions,
          blockMinutes: blockMinutesRef.current,
          notificationId: null,
        };
        await AsyncStorage.setItem(focusStorageKey, JSON.stringify(paused));
      }
      return;
    }
    if (focusBusy) return;

    const base = remainingMs > 0 ? remainingMs : focusMinutes * 60 * 1000;
    const blockMinutes = Math.max(1, Math.round(base / 60_000));
    const deadline = Date.now() + base;
    const action = ++focusActionRef.current;
    setFocusBusy(true);
    try {
      const granted = await getNotificationPermission();
      if (action !== focusActionRef.current) return;
      if (!granted) {
        Alert.alert(
          'Notificaciones desactivadas',
          'Activá las notificaciones de ErgoFocus en los ajustes del sistema para recibir el aviso del fin de bloque.'
        );
        return;
      }
      const exact = await canScheduleExactAlarms();
      if (action !== focusActionRef.current) return;
      if (!exact) {
        Alert.alert(
          'Avisos puntuales desactivados',
          'Android puede demorar el aviso del fin del bloque. Permití alarmas exactas para recibirlo a horario.',
          [
            { text: 'Ahora no', style: 'cancel' },
            {
              text: 'Abrir ajustes',
              onPress: () => void openExactAlarmSettings(),
            },
          ]
        );
      }
      const scheduledId = `focus-${Date.now()}`;
      const scheduled = await scheduleLocalNotification(
        scheduledId,
        'Sesión de enfoque completada',
        `Terminaste tu bloque de ${blockMinutes} minutos. Levantate, movete y descansá la vista.`,
        new Date(deadline)
      );
      if (action !== focusActionRef.current) {
        if (scheduled) await cancelLocalNotification(scheduledId);
        return;
      }
      if (!scheduled) {
        Alert.alert(
          'No se pudo iniciar el bloque',
          'No fue posible programar el aviso de finalización. Revisá los permisos e intentá nuevamente.'
        );
        return;
      }

      blockMinutesRef.current = blockMinutes;
      scheduledNotificationIdRef.current = scheduledId;
      endedRef.current = null;
      setDistractions(0);
      setEndAt(deadline);
      setRemainingMs(base);
      setActive(true);
      const state: PersistedFocusSession = {
        active: true,
        endAt: deadline,
        remainingMs: base,
        focusMinutes,
        distractions: 0,
        blockMinutes,
        notificationId: scheduledId,
      };
      if (focusStorageKey) await AsyncStorage.setItem(focusStorageKey, JSON.stringify(state));
    } finally {
      if (action === focusActionRef.current) setFocusBusy(false);
    }
  };

  const resetFocus = () => {
    focusActionRef.current += 1;
    setFocusBusy(false);
    setActive(false);
    setEndAt(null);
    setDistractions(0);
    setRemainingMs(focusMinutes * 60 * 1000);
    if (scheduledNotificationIdRef.current) {
      void cancelLocalNotification(scheduledNotificationIdRef.current);
      scheduledNotificationIdRef.current = null;
    }
    if (focusStorageKey) void AsyncStorage.removeItem(focusStorageKey);
  };

  const applyDuration = (minutes: number) => {
    const clamped = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, Math.round(minutes)));
    setFocusMinutes(clamped);
    setDurationText(String(clamped));
    if (DURATION_PRESETS.includes(clamped)) lastPresetRef.current = clamped;
    if (!isActive) {
      setRemainingMs(clamped * 60 * 1000);
      if (focusStorageKey) void AsyncStorage.removeItem(focusStorageKey);
    }
  };

  const handleDurationText = (text: string) => {
    const cleaned = text.replace(/[^0-9]/g, '');
    setDurationText(cleaned);
    if (cleaned === '') return;
    const clamped = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, parseInt(cleaned, 10)));
    setFocusMinutes(clamped);
    if (!isActive) {
      setRemainingMs(clamped * 60 * 1000);
      if (focusStorageKey) void AsyncStorage.removeItem(focusStorageKey);
    }
  };

  const handleDurationBlur = () => {
    if (durationText.trim() === '') {
      // Si queda vacío, se restaura el último tiempo seleccionado arriba.
      applyDuration(lastPresetRef.current);
    } else {
      setDurationText(String(focusMinutes));
    }
  };

  const isPresetSelected = DURATION_PRESETS.includes(focusMinutes);

  const handleUpgrade = async () => {
    if (checkoutBusy) return;
    setCheckoutBusy(true);
    setCheckoutError(null);
    try {
      const result = await startCheckout();
      if (!result.ok) {
        setCheckoutError(result.message);
        return;
      }
      await Linking.openURL(result.url);
    } catch {
      setCheckoutError('No se pudo abrir el navegador de pago.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleVerify = async () => {
    if (checkoutBusy) return;
    setCheckoutBusy(true);
    setCheckoutError(null);
    try {
      const res = await verifySubscription();
      await refreshRole();
      if (res.ok && res.role === 'pro') {
        Alert.alert(
          '¡Suscripción Pro Activa!',
          'Se confirmó tu suscripción en Stripe. Ya podés disfrutar de los beneficios Pro.'
        );
      } else {
        Alert.alert(
          'Estado de suscripción',
          res.message || 'No se detectó un pago completado reciente en Stripe.'
        );
      }
    } catch {
      setCheckoutError('No se pudo verificar la suscripción.');
    } finally {
      setCheckoutBusy(false);
    }
  };

  const metadataName = session?.user.user_metadata as
    | { full_name?: unknown; name?: unknown }
    | undefined;
  const rawName = metadataName?.full_name ?? metadataName?.name;
  const greetingName =
    (typeof rawName === 'string' && rawName.trim()) ||
    session?.user.email?.split('@')[0] ||
    'usuario';

  const luxDescriptor =
    sensors.lux === null
      ? 'Sin lectura'
      : sensors.lux < 300
      ? 'Luz insuficiente'
      : sensors.lux <= 500
      ? 'Rango óptimo'
      : 'Luz excesiva';
  const noiseDescriptor =
    noiseStatus === 'sin-medicion'
      ? 'Sin medición'
      : noiseStatus === 'silencioso'
      ? 'Ambiente silencioso'
      : noiseStatus === 'moderado'
      ? 'Ruido moderado'
      : 'Ambiente ruidoso';

  return (
    <View className="gap-6">
      {/* Welcome Banner */}
      <View className="bg-white rounded-2xl p-5 border border-slate-200/80 flex-col items-start justify-between gap-4">
        <View>
          <View className="flex-row items-center gap-2 mb-1">
            <View className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            <Text className="text-xs font-sans-semibold text-[#00687a] tracking-wide uppercase">
              Monitoreo ambiental en tiempo real
            </Text>
          </View>
          <Text className="text-2xl font-sans-extrabold text-[#131b2e] tracking-tight">
            Hola, {greetingName}
          </Text>
          <Text className="text-xs text-[#434655] font-sans mt-0.5">
            Tus sensores miden luz, ruido, presión y movimiento mientras trabajás.
          </Text>
        </View>

        <View className="flex-row items-center gap-3 w-full">
          <Pressable
            onPress={onNavigateToAmbient}
            className="flex-1 flex-row items-center justify-center gap-2 px-4 py-2.5 rounded-full border border-slate-200 bg-[#faf8ff]"
          >
            <ArrowUpRight size={16} color="#2563eb" />
            <Text className="text-xs font-sans-semibold text-[#434655]">Ver Sensores</Text>
          </Pressable>
        </View>
      </View>

      {/* Focus Session (Modo Enfoque) */}
      <Gradient
        direction="br"
        from="#ffffff"
        to="#f2f3ff"
        className="rounded-2xl p-6 border border-slate-200/80 flex-col justify-between"
      >
        <View>
          <View className="flex-row items-center justify-between mb-2">
            <View className="flex-row items-center gap-1">
              <Text className="text-xs font-sans-semibold text-[#004ac6] uppercase tracking-wider">
                Enfoque Ergonómico
              </Text>
            </View>
            <Text className="text-[11px] font-sans-bold px-2 py-0.5 rounded-full bg-[#eaedff] text-[#004ac6]">
              {focusMinutes}m Trabajo
            </Text>
          </View>
          <Text className="text-lg font-sans-bold text-[#131b2e]">Bloque de Concentración</Text>
          <Text className="text-xs text-[#434655] font-sans mt-1">
            Cuando termina el bloque, recibís una notificación de descanso.
          </Text>
        </View>

        <View className="my-6">
          <Text className="text-5xl font-sans-black text-[#004ac6] tracking-tight text-center">
            {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
          </Text>
          <Text className="text-xs font-sans-medium text-slate-500 mt-1 text-center">
            {isActive
              ? 'Enfoque activo...'
              : remainingMs < focusMinutes * 60 * 1000
              ? 'Sesión pausada'
              : 'Listo para comenzar tu intervalo'}
          </Text>
          {distractions > 0 ? (
            <View className="mt-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 items-center">
              <Text className="text-xs font-sans-bold text-amber-800 text-center">
                {distractions === 1
                  ? 'Hubo una distracción durante este bloque'
                  : 'Hubo varias distracciones durante este bloque'}
              </Text>
            </View>
          ) : null}
        </View>

        <View className="flex-row items-center justify-center gap-3">
          <Pressable
            onPress={() => void toggleFocus()}
            disabled={focusBusy}
            className="flex-1 flex-row items-center justify-center gap-2 py-3 px-6 rounded-full bg-[#2563eb] shadow-md"
          >
            {focusBusy ? (
              <Text className="text-sm font-sans-bold text-white">Preparando aviso...</Text>
            ) : isActive ? (
              <>
                <Pause size={16} color="#ffffff" fill="#ffffff" />
                <Text className="text-sm font-sans-bold text-white">Pausar Sesión</Text>
              </>
            ) : (
              <>
                <Play size={16} color="#ffffff" fill="#ffffff" />
                <Text className="text-sm font-sans-bold text-white">Iniciar Enfoque</Text>
              </>
            )}
          </Pressable>

          <Pressable
            onPress={resetFocus}
            accessibilityLabel="Reiniciar temporizador"
            className="p-3 rounded-full border border-slate-200"
          >
            <RotateCcw size={16} color="#475569" />
          </Pressable>
        </View>

        {!isActive && (
          <View className="mt-5 pt-4 border-t border-slate-200/70">
            <View className="flex-row items-center justify-between mb-2">
              <Text className="text-xs font-sans-semibold uppercase tracking-wider text-slate-500">
                Duración del bloque
              </Text>
              <Text className="text-xs font-sans-medium text-slate-400">De 1 a 240 min</Text>
            </View>
            <View className="flex-row flex-wrap items-center gap-2">
              {DURATION_PRESETS.map((minutes) => (
                <Pressable
                  key={minutes}
                  onPress={() => applyDuration(minutes)}
                  className={`px-3 py-1.5 rounded-full border ${
                    focusMinutes === minutes
                      ? 'bg-[#2563eb] border-[#2563eb]'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <Text
                    className={`text-xs font-sans-bold ${
                      focusMinutes === minutes ? 'text-white' : 'text-slate-600'
                    }`}
                  >
                    {minutes} min
                  </Text>
                </Pressable>
              ))}

              <View className="flex-row items-center gap-1 ml-auto">
                <Pressable
                  onPress={() => applyDuration(focusMinutes - 1)}
                  disabled={focusMinutes <= MIN_DURATION_MIN}
                  className="w-8 h-8 items-center justify-center rounded-full border border-slate-200 bg-white"
                  accessibilityLabel="Restar un minuto"
                >
                  <Text className="text-lg font-sans-bold text-slate-600 leading-none">−</Text>
                </Pressable>
                <TextInput
                  value={durationText}
                  onChangeText={handleDurationText}
                  onBlur={handleDurationBlur}
                  keyboardType="number-pad"
                  maxLength={3}
                  selectTextOnFocus
                  textAlignVertical="center"
                  className={`w-20 h-9 px-0 py-0 text-center rounded-xl border font-sans-bold text-sm text-[#131b2e] ${
                    isPresetSelected
                      ? 'border-slate-200 bg-white'
                      : 'border-[#2563eb] bg-[#eef2ff]'
                  }`}
                />
                <Pressable
                  onPress={() => applyDuration(focusMinutes + 1)}
                  disabled={focusMinutes >= MAX_DURATION_MIN}
                  className="w-8 h-8 items-center justify-center rounded-full border border-slate-200 bg-white"
                  accessibilityLabel="Sumar un minuto"
                >
                  <Text className="text-lg font-sans-bold text-slate-700 leading-none">+</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}
      </Gradient>

      {/* 4 Sensor Cards */}
      <View className="flex-col gap-4">
        <View className="bg-white rounded-2xl p-5 border border-slate-200/80">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-xs font-sans-semibold uppercase tracking-wider text-slate-500">
              Iluminación
            </Text>
            <Sun size={16} color="#d97706" />
          </View>
          <Text className="text-3xl font-sans-black text-[#131b2e]">
            {sensors.lux === null ? '—' : `${sensors.lux}`}{' '}
            <Text className="text-sm font-sans-semibold text-slate-400">Lux</Text>
          </Text>
          <View className="mt-2 flex-row items-center justify-between">
            <Text className="text-xs text-slate-500 font-sans">Rango recomendado</Text>
            <Text className={`text-xs font-sans-bold ${sensors.lux !== null && (sensors.lux < 300 || sensors.lux > 500) ? 'text-amber-600' : 'text-emerald-600'}`}>
              {luxDescriptor}
            </Text>
          </View>
        </View>

        <View className="bg-white rounded-2xl p-5 border border-slate-200/80">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-xs font-sans-semibold uppercase tracking-wider text-slate-500">
              Ruido
            </Text>
            <Volume2 size={16} color="#0891b2" />
          </View>
          <Text className="text-3xl font-sans-black text-[#131b2e]">
            {decibels === null ? '—' : `${decibels}`}{' '}
            <Text className="text-sm font-sans-semibold text-slate-400">dB</Text>
          </Text>
          <View className="mt-2 flex-row items-center justify-between">
            <Text className="text-xs text-slate-500 font-sans">Estado actual</Text>
            <Text className={`text-xs font-sans-bold ${noiseStatus === 'ruidoso' ? 'text-amber-600' : 'text-emerald-600'}`}>
              {noiseDescriptor}
            </Text>
          </View>
        </View>

        <View className="bg-white rounded-2xl p-5 border border-slate-200/80">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-xs font-sans-semibold uppercase tracking-wider text-slate-500">
              Estabilidad
            </Text>
            <Rotate3d size={16} color="#7c3aed" />
          </View>
          <Text className="text-3xl font-sans-black text-[#131b2e]">
            {sensors.rotationSpeed === null
              ? '—'
              : `${Math.round(sensors.rotationSpeed * 57.2958)}`}{' '}
            <Text className="text-sm font-sans-semibold text-slate-400">°/s</Text>
          </Text>
          <View className="mt-2 flex-row items-center justify-between">
            <Text className="text-xs text-slate-500 font-sans">Tasas de rotación</Text>
            <Text className={`text-xs font-sans-bold ${sensors.deskVibration ? 'text-amber-600' : 'text-emerald-600'}`}>
              {sensors.manipulated
                ? 'Teléfono en uso'
                : sensors.deskVibration
                ? 'Vibración de mesa'
                : 'En reposo'}
            </Text>
          </View>
        </View>

        <View className="bg-white rounded-2xl p-5 border border-slate-200/80">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-xs font-sans-semibold uppercase tracking-wider text-slate-500">
              Sedentarismo
            </Text>
            <Footprints size={16} color="#059669" />
          </View>
          <Text className="text-3xl font-sans-black text-[#131b2e]">
            {formatDuration(sensors.sedentarySeconds)}{' '}
            <Text className="text-sm font-sans-semibold text-slate-400">sin movimiento</Text>
          </Text>
          <View className="mt-2 flex-row items-center justify-between">
            <Text className="text-xs text-slate-500 font-sans">Tiempo sin movimiento</Text>
            <Text className={`text-xs font-sans-bold ${sensors.sedentaryAlert ? 'text-amber-600' : 'text-emerald-600'}`}>
              {sensors.sedentaryAlert ? 'Alerta de descanso' : sensors.isMoving ? 'En movimiento' : 'Estático'}
            </Text>
          </View>
        </View>
      </View>

      {/* Plan Pro */}
      <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
        <View className="flex-row items-center gap-2 pb-3 border-b border-slate-100 mb-4">
          <Crown size={20} color="#f59e0b" />
          <Text className="text-base font-sans-bold text-[#131b2e]">Plan Pro</Text>
          {role === 'pro' ? (
            <View className="ml-auto flex-row items-center gap-1 bg-emerald-50 px-2.5 py-1 rounded-full">
              <CheckCircle2 size={13} color="#059669" />
              <Text className="text-xs font-sans-bold text-emerald-700">Activo</Text>
            </View>
          ) : (
            <View className="ml-auto bg-slate-100 px-2.5 py-1 rounded-full">
              <Text className="text-xs font-sans-bold text-slate-600">Free</Text>
            </View>
          )}
        </View>

        {role === 'pro' ? (
          <Text className="text-xs font-sans text-[#434655] leading-relaxed">
            Gracias por elegir Pro. Nuestro webhook mantiene tu suscripción al día automáticamente.
          </Text>
        ) : (
          <>
            <Text className="text-xs font-sans text-[#434655] leading-relaxed mb-4">
              Historial de tus datos recopilados (día, semana, mes y año) en PDF por una
              suscripción mensual vía Stripe.
            </Text>
            {checkoutError && (
              <View className="mb-3 p-2.5 bg-amber-50 rounded-xl">
                <Text className="text-xs font-sans text-amber-800">{checkoutError}</Text>
              </View>
            )}
            <Pressable
              onPress={() => void handleUpgrade()}
              disabled={checkoutBusy}
              className="flex-row items-center justify-center gap-2 px-5 py-3 rounded-full bg-[#2563eb] shadow-md"
            >
              <Crown size={16} color="#ffffff" />
              <Text className="text-sm font-sans-bold text-white">
                {checkoutBusy ? 'Abriendo pago...' : 'Mejorar a Pro'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void handleVerify()}
              disabled={checkoutBusy}
              className="mt-3 py-2 items-center"
            >
              <Text className="text-xs font-sans-semibold text-[#2563eb]">
                ¿Ya pagaste? Toca acá para verificar tu suscripción
              </Text>
            </Pressable>
          </>
        )}
      </View>

    </View>
  );
};
