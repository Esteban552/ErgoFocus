import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Sun, Volume2, Rotate3d, Footprints, TrendingUp } from 'lucide-react-native';
import { SensorId } from '../types';
import { Gradient } from './Gradient';
import { useAuth } from '../auth/AuthContext';
import { getSensorReadingsByDay, SensorDayValue } from '../db/repos';

type Metric = SensorId;

interface MetricMeta {
  icon: React.ElementType;
  label: string;
  unit: string;
  normalize: (value: number) => number;
  format: (value: number) => string;
}

const METRICS: Record<Metric, MetricMeta> = {
  light: {
    icon: Sun,
    label: 'Iluminación',
    unit: 'Lux',
    normalize: (v) => Math.max(0, Math.min(1, v / 800)),
    format: (v) => `${Math.round(v)} lux`,
  },
  sound: {
    icon: Volume2,
    label: 'Ruido',
    unit: 'dB',
    normalize: (v) => Math.max(0, Math.min(1, v / 100)),
    format: (v) => `${Math.round(v)} dB`,
  },
  gyro: {
    icon: Rotate3d,
    label: 'Estabilidad',
    unit: '°/s',
    normalize: (v) => Math.max(0, Math.min(1, (v * 57.2958) / 360)),
    format: (v) => `${Math.round(v * 57.2958)} °/s`,
  },
  movement: {
    icon: Footprints,
    label: 'Sedentarismo',
    unit: 'min',
    normalize: (v) => Math.max(0, Math.min(1, v / 120)),
    format: (v) => `${Math.round(v)} min`,
  },
};

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

interface DayCell {
  dayKey: string;
  label: string;
  isToday: boolean;
  avg: number | null;
}

export const TrendsTab: React.FC = () => {
  const { userId } = useAuth();
  const [rows, setRows] = useState<SensorDayValue[]>([]);
  const [metric, setMetric] = useState<Metric>('light');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      setLoadError('No hay una sesión disponible para cargar tus tendencias.');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      setRows(await getSensorReadingsByDay(userId, 7));
    } catch (error) {
      console.warn(error);
      setLoadError('No pudimos cargar los datos locales de tendencias.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const meta = METRICS[metric];
  const Icon = meta.icon;

  const cells: DayCell[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
    const match = rows.find((r) => r.sensor === metric && r.dayKey === dayKey);
    cells.push({
      dayKey,
      label: `${DAY_LABELS[d.getDay()]}${i === 0 ? ' (Hoy)' : ''}`,
      isToday: i === 0,
      avg: match?.avg ?? null,
    });
  }

  const today = cells[cells.length - 1].avg;
  const globalMax = Math.max(...cells.filter((c) => c.avg !== null).map((c) => c.avg as number), 1);

  return (
    <View className="gap-6">
      {/* Trends Header */}
      <View className="bg-white rounded-2xl p-5 border border-slate-200/80 flex-col items-start justify-between gap-4">
        <View>
          <Text className="text-xs font-sans-semibold text-[#00687a] uppercase tracking-wider">
            Histórico por Usuario
          </Text>
          <Text className="text-2xl font-sans-extrabold text-[#131b2e] tracking-tight">
            Tendencias de Sensores
          </Text>
          <Text className="text-xs text-[#434655] font-sans mt-0.5">
            Promedios diarios de los valores registrados por tus sensores (cada 5 minutos).
          </Text>
        </View>

        {loadError ? (
          <View className="w-full flex-row items-center justify-between gap-3 rounded-xl bg-rose-50 p-3">
            <Text className="flex-1 text-xs font-sans-medium text-rose-700">{loadError}</Text>
            <Pressable onPress={() => void loadData()}>
              <Text className="text-xs font-sans-bold text-rose-700">Reintentar</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {/* Metric Selector */}
      <View className="flex-row flex-wrap gap-2">
        {(Object.keys(METRICS) as Metric[]).map((key) => {
          const M = METRICS[key];
          const ItemIcon = M.icon;
          const isActive = key === metric;
          return (
            <Pressable
              key={key}
              onPress={() => setMetric(key)}
              className={`flex-row items-center gap-1.5 px-3.5 py-2 rounded-full border ${
                isActive ? 'bg-[#eaedff] border-[#2563eb]/40' : 'bg-white border-slate-200'
              }`}
            >
              <ItemIcon size={14} color={isActive ? '#004ac6' : '#64748b'} />
              <Text
                className={`text-xs ${
                  isActive ? 'font-sans-bold text-[#004ac6]' : 'font-sans-medium text-slate-600'
                }`}
              >
                {M.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Bar Chart */}
      <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
        <View className="flex-row items-center justify-between pb-3 border-b border-slate-100 mb-6">
          <View className="flex-row items-center gap-2">
            <Icon size={16} color="#004ac6" />
            <Text className="text-xs font-sans-semibold text-slate-500 uppercase tracking-wider">
              Promedio Diario · {meta.label} ({meta.unit})
            </Text>
          </View>
          {today !== null ? (
            <View className="bg-[#f2f3ff] px-3 py-1 rounded-full">
              <Text className="text-xs font-sans-bold text-[#004ac6]">
                Hoy: {meta.format(today)}
              </Text>
            </View>
          ) : (
            <Text className="text-xs font-sans-semibold text-slate-400">Sin datos hoy</Text>
          )}
        </View>

        {loading ? (
          <Text className="text-xs font-sans text-slate-500">Cargando datos locales...</Text>
        ) : (
          <View className="flex-row items-end justify-between gap-2 px-2 pt-4">
            {cells.map((cell) => {
              const v = cell.avg;
              const has = v !== null;
              const heightPercent = has ? meta.normalize(v) * 88 : 4;
              return (
                <View key={cell.dayKey} className="flex-1 flex-col items-center gap-2">
                  <Text className="text-[10px] font-sans-bold text-slate-500 mb-1">
                    {has ? meta.format(v as number) : '—'}
                  </Text>
                  <View className="w-full bg-[#f2f3ff] rounded-t-xl overflow-hidden h-32 flex-col justify-end">
                    {!has ? (
                      <View className="w-full rounded-t-xl bg-slate-200" style={{ height: '4%' }} />
                    ) : cell.isToday ? (
                      <Gradient
                        direction="t"
                        from="#004ac6"
                        to="#06b6d4"
                        className="w-full rounded-t-xl"
                        style={{ height: `${heightPercent}%` }}
                      />
                    ) : (
                      <View
                        className={`w-full rounded-t-xl ${
                          meta === METRICS.movement
                            ? 'bg-[#f59e0b]/80'
                            : meta === METRICS.gyro
                            ? 'bg-[#7c3aed]/70'
                            : meta === METRICS.sound
                            ? 'bg-[#06b6d4]'
                            : 'bg-[#2563eb]/70'
                        }`}
                        style={{ height: `${heightPercent}%` }}
                      />
                    )}
                  </View>
                  <Text
                    className={`text-[11px] ${
                      cell.isToday ? 'font-sans-bold text-[#004ac6]' : 'font-sans-semibold text-slate-500'
                    }`}
                  >
                    {cell.label}
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        <View className="pt-4 mt-4 border-t border-slate-100 flex-row items-center gap-2">
          <TrendingUp size={14} color="#004ac6" />
          <Text className="text-xs font-sans text-slate-500 leading-relaxed">
            Los valores se guardan localmente y se vinculan a la cuenta del usuario. {meta.label}{' '}
            puede no estar disponible según el hardware del dispositivo.
          </Text>
        </View>
      </View>

      {/* Movement note */}
      <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
        <Text className="text-base font-sans-bold text-[#131b2e] mb-1">
          Interpretación de {meta.label}
        </Text>
        <Text className="text-xs font-sans text-[#434655] leading-relaxed">
          {metric === 'light' &&
            'Iluminación ideal entre 300 y 500 lux. Por debajo se fuerza la vista; por encima hay resplandor.'}
          {metric === 'sound' &&
            'Ruido bajo 50 dB es silencioso; entre 50 y 70 dB moderado; por encima de 70 dB se considera contaminación acústica.'}
          {metric === 'gyro' &&
            'Tasa de rotación del teléfono. Los picos indican manipulación del dispositivo o vibraciones de la mesa, que durante el Modo Enfoque se registran como distracciones.'}
          {metric === 'movement' &&
            'Minutos acumulados sin movimiento detectado por el acelerómetro. Por encima de 60 se emite la alerta de sedentarismo.'}
        </Text>
        <Text className="text-xs font-sans text-slate-500 mt-3">
          {globalMax === 1
            ? 'Sin datos suficientes todavía: los registros empiezan a acumularse al dejar la app abierta.'
            : `Valor máximo registrado en la semana: ${meta.format(globalMax)}.`}
        </Text>
      </View>
    </View>
  );
};