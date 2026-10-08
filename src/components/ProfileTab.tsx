import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, Alert, AppState, Linking } from 'react-native';
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
} from 'lucide-react-native';
import { SensorId } from '../types';
import { useAuth } from '../auth/AuthContext';
import { getProfileRole, startCheckout, Role } from '../lib/billing';
import { getSensorReadingsBetween, SensorReading } from '../db/repos';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

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

export const ProfileTab: React.FC = () => {
  const { session, userId } = useAuth();
  const [role, setRole] = useState<Role | null>(null);
  const [period, setPeriod] = useState<PeriodId>('week');
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const isPro = role === 'pro';
  const periodMeta = PERIODS.find((p) => p.id === period)!;

  const refreshRole = useCallback(async () => {
    const current = await getProfileRole(userId ?? null);
    if (current) setRole(current);
  }, [userId]);

  useEffect(() => {
    void refreshRole();
  }, [refreshRole]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshRole();
    });
    return () => sub.remove();
  }, [refreshRole]);

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
      const url = await startCheckout();
      if (!url) {
        setCheckoutError(
          'No se pudo crear la sesión de pago. Asegurate de desplegar la Edge Function "checkout".'
        );
        return;
      }
      await Linking.openURL(url);
    } catch {
      setCheckoutError('No se pudo abrir el navegador de pago.');
    } finally {
      setCheckoutBusy(false);
    }
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
        </View>
      )}
    </View>
  );
};