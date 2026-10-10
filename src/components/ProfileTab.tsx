import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, Alert, AppState, Linking, Switch } from 'react-native';
import {
  User,
  Crown,
  Lock,
  FileDown,
  CheckCircle2,
  Sun,
  Volume2,
  Rotate3d,
  Footprints,
  Trash2,
} from 'lucide-react-native';
import { SensorId } from '../types';
import { useAuth } from '../auth/AuthContext';
import {
  cancelSubscriptionRenewal,
  deleteAccount,
  getSubscriptionInfo,
  startCheckout,
  SubscriptionInfo,
  verifySubscription,
} from '../lib/billing';
import { deleteLocalUserData, getSensorReadingsBetween, SensorReading } from '../db/repos';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { BackgroundMonitoring } from '../background/monitoring';

type PeriodId = 'day' | 'week' | 'month' | 'year';
type BucketUnit = 'hour' | 'day' | 'month';

interface PeriodMeta {
  id: PeriodId;
  label: string;
  title: string;
  description: string;
  unit: BucketUnit;
  from: () => Date;
}

const PERIODS: PeriodMeta[] = [
  {
    id: 'day',
    label: 'Día',
    title: 'Últimas 24 horas',
    description: 'Historial por hora de los datos recopilados hoy.',
    unit: 'hour',
    from: () => {
      const d = new Date();
      d.setHours(d.getHours() - 24);
      return d;
    },
  },
  {
    id: 'week',
    label: 'Semana',
    title: 'Última semana',
    description: 'Promedios diarios de los últimos 7 días.',
    unit: 'day',
    from: () => {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      d.setHours(0, 0, 0, 0);
      return d;
    },
  },
  {
    id: 'month',
    label: 'Mes',
    title: 'Último mes',
    description: 'Promedios diarios de los últimos 30 días.',
    unit: 'day',
    from: () => {
      const d = new Date();
      d.setDate(d.getDate() - 29);
      d.setHours(0, 0, 0, 0);
      return d;
    },
  },
  {
    id: 'year',
    label: 'Año',
    title: 'Último año',
    description: 'Promedios mensuales de los últimos 12 meses.',
    unit: 'month',
    from: () => {
      const d = new Date();
      d.setMonth(d.getMonth() - 11);
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      return d;
    },
  },
];

const SENSOR_ORDER: SensorId[] = ['light', 'sound', 'gyro', 'movement'];

const SENSOR_META: Record<SensorId, { short: string; label: string; unit: string; icon: React.ElementType }> = {
  light: { short: 'Lux', label: 'Iluminación', unit: 'lux', icon: Sun },
  sound: { short: 'dB', label: 'Ruido', unit: 'dB', icon: Volume2 },
  gyro: { short: '°/s', label: 'Estabilidad', unit: '°/s', icon: Rotate3d },
  movement: { short: 'min', label: 'Sedentarismo', unit: 'min', icon: Footprints },
};

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTH_LABELS = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function bucketKey(date: Date, unit: BucketUnit): string {
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  if (unit === 'hour') return `${y}-${m}-${d} ${pad(date.getHours())}`;
  if (unit === 'month') return `${y}-${m}`;
  return `${y}-${m}-${d}`;
}

function bucketLabel(key: string, unit: BucketUnit): string {
  if (unit === 'month') {
    const [, m] = key.split('-');
    const date = new Date(Number(key.slice(0, 4)), Number(m) - 1, 1);
    return `${MONTH_LABELS[date.getMonth()]} ${date.getFullYear()}`;
  }
  if (unit === 'day') {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return `${DAY_LABELS[date.getDay()]} ${pad(d)}/${pad(m)}`;
  }
  const [, , d, hh] = key.split(/[- ]/);
  const [y, m] = key.split('-').map(Number);
  const date = new Date(y, m - 1, Number(d));
  return `${DAY_LABELS[date.getDay()]} ${hh}:00`;
}

function formatValue(sensor: SensorId, value: number): string {
  if (sensor === 'gyro') return `${Math.round(value * 57.2958)}`;
  return `${Math.round(value)}`;
}

interface ReportRow {
  label: string;
  key: string;
  values: Partial<Record<SensorId, number>>;
}

/** Agrupa los registros locales en buckets (hora/día/mes) con el promedio por sensor. */
function aggregate(
  readings: SensorReading[],
  unit: BucketUnit
): ReportRow[] {
  const buckets = new Map<string, Map<SensorId, { sum: number; count: number }>>();

  for (const r of readings) {
    const key = bucketKey(new Date(r.created_at), unit);
    const sensor = r.sensor as SensorId;
    if (!SENSOR_ORDER.includes(sensor)) continue;
    let perSensor = buckets.get(key);
    if (!perSensor) {
      perSensor = new Map();
      buckets.set(key, perSensor);
    }
    const acc = perSensor.get(sensor) ?? { sum: 0, count: 0 };
    acc.sum += r.value;
    acc.count += 1;
    perSensor.set(sensor, acc);
  }

  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, perSensor]) => {
      const values: Partial<Record<SensorId, number>> = {};
      for (const [sensor, acc] of perSensor) {
        values[sensor] = acc.sum / acc.count;
      }
      return { key, label: bucketLabel(key, unit), values };
    });
}

function buildPdfHtml(period: PeriodMeta, rows: ReportRow[], email: string): string {
  const sensorCells = SENSOR_ORDER.map((sensor) => {
    const m = SENSOR_META[sensor];
    return `<th style="text-align:right;padding:8px 10px;border:1px solid #d5d8e0;background:#f2f3ff;font-weight:700;font-size:12px;">${m.label} (${m.unit})</th>`;
  }).join('');

  const bodyRows = rows
    .map((row) => {
      const cells = SENSOR_ORDER.map((sensor) => {
        const v = row.values[sensor];
        return `<td style="text-align:right;padding:8px 10px;border:1px solid #d5d8e0;font-size:12px;">${v !== undefined ? formatValue(sensor, v) : '—'}</td>`;
      }).join('');
      return `<tr><td style="padding:8px 10px;border:1px solid #d5d8e0;font-weight:600;font-size:12px;">${row.label}</td>${cells}</tr>`;
    })
    .join('');

  const generated = new Date().toLocaleString('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #131b2e; padding: 24px; }
          h1 { font-size: 20px; margin: 0 0 4px; }
          h2 { font-size: 14px; color: #434655; font-weight: 500; margin: 0 0 16px; }
          .meta { font-size: 11px; color: #64748b; margin-bottom: 20px; }
          table { border-collapse: collapse; width: 100%; margin-top: 8px; }
          th, td { text-align: right; }
        </style>
      </head>
      <body>
        <h1>ErgoFocus · Historial de datos</h1>
        <h2>${period.title}</h2>
        <div class="meta">Usuario: ${email || 'local'} · Generado el ${generated}</div>
        <table>
          <thead><tr><th style="text-align:left;padding:8px 10px;border:1px solid #d5d8e0;background:#f2f3ff;font-weight:700;font-size:12px;">Período</th>${sensorCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
        <div style="font-size:10px;color:#94a3b8;margin-top:16px;">
          Los valores son promedios de los registros locales guardados cada 5 minutos mientras la app está abierta.
        </div>
      </body>
    </html>
  `;
}

export const ProfileTab: React.FC<{
  monitoring: BackgroundMonitoring;
  notificationError: string | null;
}> = ({ monitoring, notificationError }) => {
  const { session, userId, signOut, isPro, refreshRole } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const [period, setPeriod] = useState<PeriodId>('week');
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [subscriptionInfo, setSubscriptionInfo] = useState<SubscriptionInfo | null>(null);
  const [cancellingSubscription, setCancellingSubscription] = useState(false);

  const periodMeta = PERIODS.find((p) => p.id === period)!;

  const loadSubscriptionInfo = useCallback(async () => {
    setSubscriptionInfo(await getSubscriptionInfo(userId));
  }, [userId]);

  useEffect(() => {
    void loadSubscriptionInfo();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshRole();
        void loadSubscriptionInfo();
      }
    });
    return () => sub.remove();
  }, [loadSubscriptionInfo, refreshRole]);

  const loadData = useCallback(async () => {
    const activePeriod = PERIODS.find((p) => p.id === period)!;
    const from = activePeriod.from();
    const to = new Date();
    setLoading(true);
    setLoadError(null);
    try {
      const readings = await getSensorReadingsBetween(
        userId ?? '',
        from.toISOString(),
        to.toISOString()
      );
      setRows(aggregate(readings, activePeriod.unit));
    } catch (error) {
      console.warn(error);
      setLoadError('No pudimos cargar los datos locales para este período.');
    } finally {
      setLoading(false);
    }
  }, [period, userId]);

  useEffect(() => {
    if (!isPro) return;
    void loadData();
  }, [isPro, loadData]);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      if (!rows.length) {
        Alert.alert('Sin datos', 'No hay registros locales para exportar en este período.');
        return;
      }
      const html = buildPdfHtml(periodMeta, rows, session?.user.email ?? '');
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Historial ErgoFocus',
        });
      } else {
        Alert.alert('PDF listo', 'El archivo se guardó localmente en: ' + uri);
      }
    } catch (error) {
      console.warn(error);
      Alert.alert('Error', 'No se pudo generar el archivo PDF.');
    } finally {
      setExporting(false);
    }
  };

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
      await loadSubscriptionInfo();
      if (res.ok && res.role === 'pro') {
        Alert.alert(
          '¡Suscripción Pro Activa!',
          'Se confirmó tu suscripción en Stripe. Ya tenés acceso completo a todas las funciones Pro.'
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

  const handleCancelSubscription = async () => {
    if (cancellingSubscription) return;
    setCancellingSubscription(true);
    try {
      const result = await cancelSubscriptionRenewal();
      if (!result.ok) {
        Alert.alert('No se pudo cancelar la renovación', result.message);
        return;
      }
      await refreshRole();
      await loadSubscriptionInfo();
      const endDate = result.currentPeriodEnd
        ? new Date(result.currentPeriodEnd).toLocaleDateString('es-AR', { dateStyle: 'long' })
        : null;
      Alert.alert(
        'Renovación cancelada',
        endDate
          ? `Tu Plan Pro seguirá activo hasta el ${endDate}. No se realizará otro cobro.`
          : 'Tu Plan Pro seguirá activo hasta finalizar el período que ya pagaste.'
      );
    } finally {
      setCancellingSubscription(false);
    }
  };

  const confirmCancelSubscription = () => {
    Alert.alert(
      'Cancelar renovación',
      'No se realizará otro cobro. Vas a conservar todas las funciones Pro hasta que termine el período que ya pagaste.',
      [
        { text: 'Volver', style: 'cancel' },
        {
          text: 'Cancelar renovación',
          style: 'destructive',
          onPress: () => void handleCancelSubscription(),
        },
      ]
    );
  };

  const handleDeleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteAccount();
      if (userId) await deleteLocalUserData(userId);
      await signOut();
    } catch (error) {
      console.warn(error);
      Alert.alert('Error', 'No se pudo eliminar la cuenta. Intentá nuevamente.');
    } finally {
      setDeleting(false);
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      'Eliminar cuenta',
      '¿Seguro que querés dar de baja tu cuenta? Tu perfil quedará desactivado y se cerrará tu sesión.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Dar de baja', style: 'destructive', onPress: () => void handleDeleteAccount() },
      ]
    );
  };

  const hasRows = rows.length > 0;

  return (
    <View className="gap-6">
      {/* Perfil Header */}
      <View className="bg-white rounded-2xl p-5 border border-slate-200/80 flex-col items-start justify-between gap-4">
        <View className="flex-row items-center gap-3 w-full">
          <View className="w-12 h-12 rounded-full bg-[#eaedff] items-center justify-center">
            <User size={22} color="#004ac6" />
          </View>
          <View className="flex-1">
            <Text className="text-base font-sans-bold text-[#131b2e]">
              {session?.user.email?.split('@')[0] ?? 'Usuario local'}
            </Text>
            <Text className="text-xs text-slate-500 font-sans">
              {session?.user.email ?? 'Sin sesión de Supabase'}
            </Text>
          </View>
          {isPro ? (
            <View className="flex-row items-center gap-1 bg-emerald-50 px-2.5 py-1 rounded-full">
              <CheckCircle2 size={13} color="#059669" />
              <Text className="text-xs font-sans-bold text-emerald-700">Pro</Text>
            </View>
          ) : (
            <View className="bg-slate-100 px-2.5 py-1 rounded-full">
              <Text className="text-xs font-sans-bold text-slate-600">Free</Text>
            </View>
          )}
        </View>
      </View>

      {isPro && subscriptionInfo ? (
        <View className="bg-white rounded-2xl p-5 border border-slate-200/80">
          <View className="flex-row items-center gap-2 mb-2">
            <Crown size={18} color="#f59e0b" />
            <Text className="text-base font-sans-bold text-[#131b2e]">Suscripción Pro</Text>
          </View>
          <Text className="text-xs font-sans text-[#434655] leading-relaxed">
            {subscriptionInfo.cancelAtPeriodEnd
              ? subscriptionInfo.currentPeriodEnd
                ? `Renovación cancelada. Conservás Pro hasta el ${new Date(
                    subscriptionInfo.currentPeriodEnd
                  ).toLocaleDateString('es-AR', { dateStyle: 'long' })}.`
                : 'Renovación cancelada. Conservás Pro hasta el final del período pagado.'
              : subscriptionInfo.currentPeriodEnd
                ? `Próxima renovación: ${new Date(
                    subscriptionInfo.currentPeriodEnd
                  ).toLocaleDateString('es-AR', { dateStyle: 'long' })}.`
                : 'Suscripción activa.'}
          </Text>
          {!subscriptionInfo.cancelAtPeriodEnd ? (
            <Pressable
              onPress={confirmCancelSubscription}
              disabled={cancellingSubscription}
              className="mt-4 py-2.5 items-center rounded-full border border-rose-200 bg-rose-50"
            >
              <Text className="text-xs font-sans-bold text-rose-700">
                {cancellingSubscription ? 'Cancelando...' : 'Cancelar renovación'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {isPro ? (
        <>
          {/* Historial Premium */}
          <View className="bg-white rounded-2xl p-5 border border-slate-200/80">
            <View className="flex-row items-center gap-2 pb-3 border-b border-slate-100 mb-4">
              <FileDown size={18} color="#004ac6" />
              <Text className="text-base font-sans-bold text-[#131b2e]">
                Historial de datos
              </Text>
            </View>

            <Text className="text-xs font-sans text-[#434655] leading-relaxed mb-4">
              {periodMeta.description}
            </Text>

            {/* Period Selector */}
            <View className="flex-row flex-wrap gap-2 mb-4">
              {PERIODS.map((p) => {
                const isActive = p.id === period;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => setPeriod(p.id)}
                    className={`flex-row items-center gap-1.5 px-3.5 py-2 rounded-full border ${
                      isActive ? 'bg-[#eaedff] border-[#2563eb]/40' : 'bg-white border-slate-200'
                    }`}
                  >
                    <Text
                      className={`text-xs ${
                        isActive ? 'font-sans-bold text-[#004ac6]' : 'font-sans-medium text-slate-600'
                      }`}
                    >
                      {p.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {loadError ? (
              <View className="mb-4 p-2.5 bg-rose-50 rounded-xl">
                <Text className="text-xs font-sans text-rose-700">{loadError}</Text>
              </View>
            ) : loading ? (
              <Text className="text-xs font-sans text-slate-500 pb-4">
                Cargando datos locales...
              </Text>
            ) : !hasRows ? (
              <Text className="text-xs font-sans text-slate-500 pb-4">
                Sin registros en este período. Los datos se guardan cada 5 minutos mientras la app
                está abierta.
              </Text>
            ) : (
              <>
                {/* Table Header */}
                <View className="flex-row items-center bg-[#f8f9fc] rounded-t-xl border border-slate-200 px-2 py-2">
                  <Text className="w-[86px] text-[10px] font-sans-semibold text-slate-500">
                    Período
                  </Text>
                  {SENSOR_ORDER.map((sensor) => (
                    <Text
                      key={sensor}
                      className="flex-1 text-center text-[10px] font-sans-semibold text-slate-500"
                    >
                      {SENSOR_META[sensor].short}
                    </Text>
                  ))}
                </View>

                {/* Table Rows */}
                <View className="border-x border-b border-slate-200 rounded-b-xl divide-y divide-slate-100">
                  {rows.map((row, index) => (
                    <View
                      key={row.key}
                      className={`flex-row items-center px-2 py-2 ${
                        index % 2 === 0 ? 'bg-white' : 'bg-[#fafbff]'
                      }`}
                    >
                      <Text className="w-[86px] text-[11px] font-sans-medium text-[#131b2e]">
                        {row.label}
                      </Text>
                      {SENSOR_ORDER.map((sensor) => {
                        const v = row.values[sensor];
                        return (
                          <Text
                            key={sensor}
                            className={`flex-1 text-center text-[11px] ${
                              v !== undefined
                                ? 'font-sans-bold text-[#334155]'
                                : 'font-sans text-slate-400'
                            }`}
                          >
                            {v !== undefined ? formatValue(sensor, v) : '—'}
                          </Text>
                        );
                      })}
                    </View>
                  ))}
                </View>

                <Pressable
                  onPress={() => void handleExport()}
                  disabled={exporting}
                  className="flex-row items-center justify-center gap-2 px-5 py-3 rounded-full bg-[#2563eb] shadow-md mt-5"
                >
                  <FileDown size={16} color="#ffffff" />
                  <Text className="text-sm font-sans-bold text-white">
                    {exporting ? 'Generando PDF...' : 'Descargar PDF'}
                  </Text>
                </Pressable>

                <View className="pt-3 flex-row items-center gap-2">
                  <Text className="text-[10px] font-sans text-slate-400 leading-relaxed flex-1">
                    Los valores son promedios de los registros locales guardados cada 5 minutos.
                  </Text>
                </View>
              </>
            )}
          </View>
        </>
      ) : (
        /* Bloqueo para usuarios Free: sin tabla de datos visible */
        <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
          <View className="flex-row items-center gap-2 pb-3 border-b border-slate-100 mb-4">
            <Crown size={20} color="#f59e0b" />
            <Text className="text-base font-sans-bold text-[#131b2e]">Plan Pro</Text>
          </View>

          <View className="flex-col items-center py-6">
            <View className="w-14 h-14 rounded-full bg-[#fef3c7] items-center justify-center mb-4">
              <Lock size={26} color="#f59e0b" />
            </View>
            <Text className="text-base font-sans-bold text-[#131b2e] mb-1">
              Historial descargable en PDF
            </Text>
            <Text className="text-xs font-sans text-[#434655] leading-relaxed text-center max-w-[280px]">
              El historial de tus datos recopilados (día, semana, mes y año) en PDF está disponible
              únicamente con el Plan Pro.
            </Text>
          </View>

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
              ¿Ya realizaste el pago? Toca acá para verificar tu suscripción
            </Text>
          </Pressable>
        </View>
      )}

      {/* Monitoreo en segundo plano */}
      {monitoring.supported && (
        <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1">
              <Text className="text-base font-sans-bold text-[#131b2e] mb-1">
                Monitoreo en segundo plano
              </Text>
              <Text className="text-xs font-sans text-[#434655] leading-relaxed">
                Usa un servicio nativo para intentar medir luz, ruido y movimiento con la pantalla
                bloqueada. La disponibilidad depende del hardware; muestra una notificación
                permanente y consume más batería.
              </Text>
            </View>
            <Switch
              value={monitoring.enabled}
              disabled={monitoring.busy}
              onValueChange={(value) => void monitoring.setEnabled(value)}
            />
          </View>
          {monitoring.error && (
            <Text className="text-xs font-sans text-rose-700 mt-3">{monitoring.error}</Text>
          )}
          {!monitoring.error && monitoring.enabled && (
            <>
              <Text className="text-xs font-sans-semibold text-emerald-700 mt-3">
                Servicio activo · micrófono conectado
              </Text>
              {!monitoring.snapshot.movementWakeUp && (
                <Text className="text-xs font-sans text-amber-800 mt-1">
                  El acelerómetro no es de tipo wake-up; Android puede limitar sus lecturas en reposo profundo.
                </Text>
              )}
            </>
          )}
        </View>
      )}

      {notificationError && (
        <View className="bg-amber-50 rounded-2xl p-5 border border-amber-200">
          <Text className="text-sm font-sans-bold text-amber-900 mb-1">
            Push remoto no disponible
          </Text>
          <Text className="text-xs font-sans text-amber-800 leading-relaxed">
            {notificationError} Los avisos locales del cronómetro siguen funcionando.
          </Text>
        </View>
      )}

      {/* Cuenta */}
      <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
        <Text className="text-base font-sans-bold text-[#131b2e] mb-1">Mi cuenta</Text>
        <Text className="text-xs font-sans text-[#434655] mb-4">
          Al eliminar la cuenta se borran todos tus registros de la base de datos.
        </Text>
        <Pressable
          onPress={confirmDeleteAccount}
          disabled={deleting}
          className="flex-row items-center justify-center gap-2 px-5 py-3 rounded-full border border-rose-200 bg-rose-50"
        >
          <Trash2 size={16} color="#dc2626" />
          <Text className="text-sm font-sans-bold text-rose-700">
            {deleting ? 'Eliminando...' : 'Eliminar cuenta y datos'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
};
