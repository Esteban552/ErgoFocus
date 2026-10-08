import { getDb } from './database';
import { SensorId } from '../types';
import { supabase } from '../lib/supabase';

const now = () => new Date().toISOString();

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/* ---------------- sensor_logs ---------------- */

export async function logSensor(
  userId: string,
  sensor: SensorId,
  value: number
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO sensor_logs (user_id, sensor, value, created_at) VALUES (?, ?, ?, ?)',
    [userId, sensor, value, now()]
  );
}

export interface SensorDayValue {
  sensor: SensorId;
  dayKey: string;
  avg: number;
  count: number;
}

/** Promedio por día local (últimos N días) de cada valor de sensor registrado. */
export async function getSensorReadingsByDay(
  userId: string,
  days = 7
): Promise<SensorDayValue[]> {
  const db = await getDb();
  const since = isoDaysAgo(days - 1);
  const rows = await db.getAllAsync<{ sensor: string; value: number; created_at: string }>(
    'SELECT sensor, value, created_at FROM sensor_logs WHERE user_id = ? AND created_at >= ?',
    [userId, since]
  );

  const buckets = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    const key = localDayKey(new Date(row.created_at));
    let perSensor = buckets.get(key);
    if (!perSensor) {
      perSensor = new Map();
      buckets.set(key, perSensor);
    }
    const arr = perSensor.get(row.sensor) ?? [];
    arr.push(row.value);
    perSensor.set(row.sensor, arr);
  }

  const result: SensorDayValue[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayKey = localDayKey(d);
    const perSensor = buckets.get(dayKey);
    if (!perSensor) continue;
    for (const [sensor, values] of perSensor) {
      result.push({
        sensor: sensor as SensorId,
        dayKey,
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        count: values.length,
      });
    }
  }
  return result;
}

/**
 * Sincroniza los promedios diarios locales hacia la tabla `sensor_daily` de Supabase.
 * Solo disponible para usuarios Pro; la base de datos valida el rol vía RLS.
 */
export async function syncSensorDailyToSupabase(
  userId: string,
  days = 7
): Promise<{ success: boolean; syncedCount: number; error?: string }> {
  if (!supabase) {
    return { success: false, syncedCount: 0, error: 'Supabase no está inicializado.' };
  }

  try {
    const dailyValues = await getSensorReadingsByDay(userId, days);
    if (dailyValues.length === 0) {
      return { success: true, syncedCount: 0 };
    }

    const payload = dailyValues.map((v) => ({
      user_id: userId,
      sensor: v.sensor,
      day: v.dayKey,
      avg: Number(v.avg.toFixed(2)),
      sample_count: v.count,
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from('sensor_daily').upsert(payload, {
      onConflict: 'user_id,sensor,day',
    });

    if (error) {
      return { success: false, syncedCount: 0, error: error.message };
    }

    return { success: true, syncedCount: payload.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error inesperado al sincronizar.';
    return { success: false, syncedCount: 0, error: message };
  }
}

/**
 * Consulta el histórico agregado de la nube para el usuario (`sensor_daily`).
 */
export async function getRemoteSensorDaily(
  userId: string,
  limitDays = 30
): Promise<SensorDayValue[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('sensor_daily')
    .select('sensor, day, avg, sample_count')
    .eq('user_id', userId)
    .order('day', { ascending: false })
    .limit(limitDays * 4);

  if (error || !data) return [];

  return data.map((row) => ({
    sensor: row.sensor as SensorId,
    dayKey: row.day,
    avg: row.avg,
    count: row.sample_count,
  }));
}

export interface SensorReading {
  sensor: SensorId;
  value: number;
  created_at: string;
}

/** Devuelve los registros locales en un rango ISO de fechas (uso exclusivo del usuario). */
export async function getSensorReadingsBetween(
  userId: string,
  fromIso: string,
  toIso: string
): Promise<SensorReading[]> {
  const db = await getDb();
  return db.getAllAsync<SensorReading>(
    'SELECT sensor, value, created_at FROM sensor_logs WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC',
    [userId, fromIso, toIso]
  );
}

/* ---------------- helpers ---------------- */

/** Elimina todos los registros locales de un usuario (usado al borrar la cuenta). */
export async function deleteLocalUserData(userId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM sensor_logs WHERE user_id = ?', [userId]);
}

export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}