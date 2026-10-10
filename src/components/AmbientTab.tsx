import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Pressable } from 'react-native';
import {
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import {
  Sun,
  Mic,
  MicOff,
  Rotate3d,
  Vibrate,
  Footprints,
  AlertTriangle,
} from 'lucide-react-native';
import { SensorState } from '../sensors/useSensors';
import { Gradient } from './Gradient';
import { formatDuration } from '../lib/format';
import type { BackgroundMonitoring } from '../background/monitoring';

interface Props {
  sensors: SensorState;
  decibels: number | null;
  onUpdateDecibels: (decibels: number | null) => void;
  monitoring: BackgroundMonitoring;
}

const METERED_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

export const AmbientTab: React.FC<Props> = ({ sensors, decibels, onUpdateDecibels, monitoring }) => {
  const audioRecorder = useAudioRecorder(METERED_RECORDING_OPTIONS, (status) => {
    if (status.hasError || status.mediaServicesDidReset) {
      setMicError(
        status.error ??
          'La medición se interrumpió. Detenela e intentá iniciar el micrófono nuevamente.',
      );
      setMicActive(false);
      onUpdateDecibels(null);
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
  });
  const recorderState = useAudioRecorderState(audioRecorder, 250);
  const [micActive, setMicActive] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const observedRecordingRef = useRef(false);

  useEffect(() => {
    if (!micActive || !recorderState.isRecording || recorderState.metering === undefined) {
      return;
    }
    observedRecordingRef.current = true;
    // dBFS is relative to the microphone's digital full scale; only an ambient estimate.
    const estimatedDb = Math.max(0, Math.min(100, Math.round(recorderState.metering + 100)));
    onUpdateDecibels(estimatedDb);
  }, [micActive, onUpdateDecibels, recorderState.isRecording, recorderState.metering]);

  useEffect(() => {
    if (recorderState.mediaServicesDidReset) {
      observedRecordingRef.current = false;
      setMicActive(false);
      setMicError('El sistema de audio se reinició. Volvé a iniciar la medición.');
      onUpdateDecibels(null);
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      return;
    }
    if (micActive && observedRecordingRef.current && !recorderState.isRecording) {
      observedRecordingRef.current = false;
      setMicActive(false);
      setMicError('La grabación fue interrumpida por el sistema. Volvé a iniciarla.');
      onUpdateDecibels(null);
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
  }, [micActive, onUpdateDecibels, recorderState.isRecording, recorderState.mediaServicesDidReset]);

  const startMicMeter = async () => {
    if (micBusy || micActive) return;

    setMicError(null);
    setMicBusy(true);
    onUpdateDecibels(null);
    try {
      let permission = await getRecordingPermissionsAsync();
      if (!permission.granted) {
        if (!permission.canAskAgain) {
          setMicError('El permiso de micrófono está bloqueado. Habilitalo desde los ajustes del dispositivo.');
          return;
        }
        permission = await requestRecordingPermissionsAsync();
      }

      if (!permission.granted) {
        setMicError('No se otorgó permiso para usar el micrófono.');
        return;
      }

      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      observedRecordingRef.current = false;
      setMicActive(true);
    } catch (error) {
      setMicError(
        error instanceof Error
          ? `No se pudo iniciar la medición: ${error.message}`
          : 'No se pudo iniciar la medición con el micrófono.',
      );
      setMicActive(false);
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    } finally {
      setMicBusy(false);
    }
  };

  const stopMicMeter = async () => {
    if (micBusy) return;

    setMicBusy(true);
    setMicActive(false);
    observedRecordingRef.current = false;
    onUpdateDecibels(null);
    try {
      if (audioRecorder.isRecording) {
        await audioRecorder.stop();
      }
    } catch (error) {
      setMicError(
        error instanceof Error
          ? `No se pudo detener la medición: ${error.message}`
          : 'No se pudo detener correctamente la medición.',
      );
    } finally {
      try {
        await setAudioModeAsync({ allowsRecording: false });
      } catch {
        setMicError('La medición se detuvo, pero no se pudo restaurar el modo de audio.');
      }
      setMicBusy(false);
    }
  };

  useEffect(() => {
    if (monitoring.enabled && (micActive || audioRecorder.isRecording)) {
      void stopMicMeter();
    }
  }, [monitoring.enabled]);

  useEffect(() => {
    return () => {
      void (async () => {
        try {
          if (audioRecorder.isRecording) {
            await audioRecorder.stop();
          }
        } finally {
          await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        }
      })();
    };
  }, [audioRecorder]);

  const luxStatusDescriptor =
    sensors.lux === null
      ? 'Sin lectura'
      : sensors.lux < 300
      ? 'Luz insuficiente (menor a 300 lux)'
      : sensors.lux <= 500
      ? 'Rango óptimo (300 - 500 lux)'
      : 'Iluminación excesiva (mayor a 500 lux)';

  const noiseStatusDescriptor =
    decibels === null
      ? 'Sin medición'
      : decibels < 50
      ? 'Ambiente silencioso'
      : decibels < 70
      ? 'Ruido moderado'
      : 'Alerta de ruido';

  const sedentaryText =
    !sensors.movementAvailable
      ? 'Accelerómetro no disponible'
      : sensors.isMoving
      ? 'Movimiento detectado'
      : `Sin movimiento: ${formatDuration(sensors.sedentarySeconds)}`;

  const gyroStatusDescriptor = !sensors.gyroAvailable
    ? 'Giroscopio no disponible'
    : sensors.manipulated
    ? 'Teléfono en uso (manipulación detectada)'
    : sensors.deskVibration
    ? 'Vibración de mesa detectada'
    : 'Teléfono en reposo';
  const rotationDegPerSec =
    sensors.rotationSpeed === null ? null : Math.round(sensors.rotationSpeed * 57.2958);

  const sensorUnavailable = (available: boolean) => (
    <View className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex-row items-start gap-2">
      <AlertTriangle size={16} color="#b45309" />
      <Text className="flex-1 text-xs font-sans text-amber-800 leading-relaxed">
        Este dispositivo no expone este sensor, así que no se generan lecturas.
      </Text>
    </View>
  );

  const statusBadge = (active: boolean) => (
    <View
      className={`shrink-0 px-2.5 py-1 rounded-full ${
        active ? 'bg-emerald-100' : 'bg-slate-100'
      }`}
    >
      <Text className={`text-[11px] font-sans-bold ${active ? 'text-emerald-700' : 'text-slate-500'}`}>
        {active ? 'En vivo' : 'No disponible'}
      </Text>
    </View>
  );

  return (
    <View className="gap-6">
      {/* Ambient Header */}
      <View className="bg-white rounded-2xl p-5 border border-slate-200/80 flex-col items-start justify-between gap-4">
        <View>
          <Text className="text-xs font-sans-semibold text-[#00687a] uppercase tracking-wider">
            Telemetría Ambiental & Confort
          </Text>
          <Text className="text-2xl font-sans-extrabold text-[#131b2e] tracking-tight">
            Ambiente & Salud Ergonométrica
          </Text>
          <Text className="text-xs font-sans text-[#434655] mt-0.5">
            Lecturas reales de los sensores del dispositivo: iluminación, ruido, estabilidad y
            movimiento.
          </Text>
        </View>
      </View>

      <View className="flex flex-col gap-6">
        {/* Iluminación */}
        <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
          <View className="flex-row items-center justify-between gap-3 pb-3 border-b border-slate-100 mb-4">
            <View className="flex-1 flex-row items-center gap-2">
              <View className="p-2 rounded-xl bg-amber-50">
                <Sun size={20} color="#d97706" />
              </View>
              <View className="flex-1">
                <Text className="text-[11px] font-sans-semibold text-slate-400 uppercase tracking-wider">
                  Confort visual del puesto
                </Text>
                <Text className="text-lg font-sans-extrabold text-[#131b2e] leading-snug">
                  Iluminación
                </Text>
              </View>
            </View>
            {statusBadge(sensors.luxAvailable)}
          </View>

          {!sensors.luxAvailable ? (
            sensorUnavailable(false)
          ) : (
            <>
              <View className="flex-row items-baseline justify-between mb-2">
                <Text className="text-4xl font-sans-black text-[#131b2e]">
                  {sensors.lux ?? '—'}{' '}
                  <Text className="text-sm font-sans-semibold text-slate-400">Lux</Text>
                </Text>
                <Text className="text-xs font-sans-semibold text-[#00687a]">
                  300 - 500 Lux Recomendado
                </Text>
              </View>

              <View className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden relative">
                <Gradient
                  direction="r"
                  from="#fbbf24"
                  to="#f59e0b"
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, ((sensors.lux ?? 0) / 800) * 100)}%` }}
                />
                <View className="absolute top-0 bottom-0 left-[37.5%] w-[25%] bg-emerald-500/20 border-x border-emerald-500/40" />
              </View>

              <Text className="text-xs font-sans-semibold text-slate-600 mt-3">
                {luxStatusDescriptor}
              </Text>
            </>
          )}
        </View>

        {/* Ruido */}
        <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
          <View className="pb-3 border-b border-slate-100 mb-4">
            <View className="flex-row items-center gap-2">
              <View className="p-2 rounded-xl bg-cyan-50">
                <Mic size={20} color="#0891b2" />
              </View>
              <View className="flex-1">
                <Text className="text-[11px] font-sans-semibold text-slate-400 uppercase tracking-wider">
                  Ambiente sonoro del espacio
                </Text>
                <Text className="text-lg font-sans-extrabold text-[#131b2e] leading-snug">
                  Ruido
                </Text>
              </View>
            </View>

            <View className="flex-row items-center justify-between gap-3 mt-3">
              {statusBadge(monitoring.enabled || micActive || micBusy)}
              {monitoring.enabled ? (
                <View className="shrink-0 px-3 py-1.5 rounded-full bg-emerald-50">
                  <Text className="text-xs font-sans-semibold text-emerald-700">
                    Segundo plano activo
                  </Text>
                </View>
              ) : micActive ? (
                <Pressable
                  onPress={() => void stopMicMeter()}
                  disabled={micBusy}
                  className="shrink-0 flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-100"
                >
                  <MicOff size={14} color="#334155" />
                  <Text className="text-xs font-sans-semibold text-slate-700">
                    {micBusy ? 'Deteniendo...' : 'Detener'}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => void startMicMeter()}
                  disabled={micBusy}
                  className="shrink-0 flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#06b6d4]"
                >
                  <Mic size={14} color="#ffffff" />
                  <Text className="text-xs font-sans-semibold text-white">
                    {micBusy ? 'Procesando...' : 'Medir con Micrófono'}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>

          {micError && (
            <View className="mb-3 p-2.5 bg-amber-50 rounded-xl">
              <Text className="text-xs font-sans text-amber-800">{micError}</Text>
            </View>
          )}

          <View className="flex-row items-baseline justify-between mb-2">
            <Text className="text-4xl font-sans-black text-[#131b2e]">
              {decibels === null ? '--' : decibels}{' '}
              <Text className="text-sm font-sans-semibold text-slate-400">dB estimados</Text>
            </Text>
            <Text className="text-xs font-sans-semibold text-[#00687a]">
              {noiseStatusDescriptor}
            </Text>
          </View>

          <View className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden mb-4">
            <View
              className={`h-full rounded-full ${
                decibels === null
                  ? 'bg-slate-300'
                  : decibels < 50
                  ? 'bg-[#06b6d4]'
                  : decibels < 70
                  ? 'bg-[#f59e0b]'
                  : 'bg-[#ef4444]'
              }`}
              style={{ width: `${decibels === null ? 0 : Math.min(100, decibels)}%` }}
            />
          </View>

          <Text className="text-xs font-sans text-[#434655] leading-relaxed">
            Medición aproximada basada en dBFS del micrófono, procesada solo en el dispositivo. No
            se graba ni almacena audio, y no reemplaza un sonómetro calibrado.
          </Text>
        </View>

        {/* Estabilidad (giroscopio) */}
        <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
          <View className="flex-row items-center justify-between gap-3 pb-3 border-b border-slate-100 mb-4">
            <View className="flex-1 flex-row items-center gap-2">
              <View className="p-2 rounded-xl bg-violet-50">
                <Rotate3d size={20} color="#7c3aed" />
              </View>
              <View className="flex-1">
                <Text className="text-[11px] font-sans-semibold text-slate-400 uppercase tracking-wider">
                  Movimiento y firmeza del entorno
                </Text>
                <Text className="text-lg font-sans-extrabold text-[#131b2e] leading-snug">
                  Estabilidad
                </Text>
              </View>
            </View>
            {statusBadge(sensors.gyroAvailable)}
          </View>

          {!sensors.gyroAvailable ? (
            sensorUnavailable(false)
          ) : (
            <>
              <View className="flex-row items-baseline justify-between mb-2">
                <Text className="text-4xl font-sans-black text-[#131b2e]">
                  {rotationDegPerSec === null ? '—' : rotationDegPerSec}{' '}
                  <Text className="text-sm font-sans-semibold text-slate-400">°/s</Text>
                </Text>
                <Text className="text-xs font-sans-semibold text-[#00687a]">
                  Tasa de rotación
                </Text>
              </View>

              <View className="flex-col gap-3">
                <View className="p-3.5 bg-[#faf8ff] rounded-xl border border-slate-100 flex-row items-start gap-2">
                  <Rotate3d size={16} color="#7c3aed" />
                  <View className="flex-1">
                    <Text className="text-xs font-sans-bold text-[#131b2e]">Estado</Text>
                    <Text className="text-xs font-sans text-[#434655] leading-relaxed">
                      {gyroStatusDescriptor}
                    </Text>
                  </View>
                </View>

                <View className="p-3.5 bg-[#faf8ff] rounded-xl border border-slate-100 flex-row items-start gap-2">
                  <Vibrate size={16} color={sensors.deskVibration ? '#dc2626' : '#059669'} />
                  <View className="flex-1">
                    <Text className="text-xs font-sans-bold text-[#131b2e]">
                      Vibración de la mesa de trabajo
                    </Text>
                    <Text className="text-xs font-sans text-[#434655] leading-relaxed">
                      {sensors.deskVibration
                        ? 'Se detectan vibraciones que pueden molestar la concentración.'
                        : 'Sin vibraciones notorias en la mesa.'}
                    </Text>
                  </View>
                </View>
              </View>

              {sensors.manipulated && (
                <View className="mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200 flex-row items-start gap-2">
                  <AlertTriangle size={16} color="#b45309" />
                  <Text className="flex-1 text-xs font-sans text-amber-800 leading-relaxed">
                    Se detectó que el teléfono fue tomado o manipulado. Durante el Modo Enfoque
                    esto se registra como una distracción del bloque.
                  </Text>
                </View>
              )}
            </>
          )}
        </View>

        {/* Sedentarismo (acelerómetro) */}
        <View className="bg-white rounded-2xl p-6 border border-slate-200/80">
          <View className="flex-row items-center justify-between gap-3 pb-3 border-b border-slate-100 mb-4">
            <View className="flex-1 flex-row items-center gap-2">
              <View className="p-2 rounded-xl bg-emerald-50">
                <Footprints size={20} color="#059669" />
              </View>
              <View className="flex-1">
                <Text className="text-[11px] font-sans-semibold text-slate-400 uppercase tracking-wider">
                  Tiempo sin movimiento activo
                </Text>
                <Text className="text-lg font-sans-extrabold text-[#131b2e] leading-snug">
                  Sedentarismo
                </Text>
              </View>
            </View>
            {statusBadge(sensors.movementAvailable)}
          </View>

          {!sensors.movementAvailable ? (
            sensorUnavailable(false)
          ) : (
            <>
              <View className="flex-row items-baseline justify-between mb-2">
                <Text className="text-4xl font-sans-black text-[#131b2e]">
                  {formatDuration(sensors.sedentarySeconds)}{' '}
                  <Text className="text-sm font-sans-semibold text-slate-400">sin moverte</Text>
                </Text>
                <Text className="text-xs font-sans-semibold text-[#00687a]">Máx 60 min</Text>
              </View>

              <View className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden mb-2">
                <View
                  className={`h-full rounded-full ${
                    sensors.sedentaryAlert ? 'bg-[#ef4444]' : 'bg-[#f59e0b]'
                  }`}
                  style={{ width: `${Math.min(100, (sensors.sedentarySeconds / 3600) * 100)}%` }}
                />
              </View>

              <Text className="text-xs font-sans-semibold text-slate-600 mb-3">
                {sedentaryText}
                {sensors.accelerationMagnitude !== null &&
                  ` · Magnitud: ${sensors.accelerationMagnitude} m/s²`}
              </Text>

              {sensors.sedentaryAlert && (
                <View className="p-3 rounded-xl bg-red-50 border border-red-200 flex-row items-start gap-2">
                  <AlertTriangle size={16} color="#dc2626" />
                  <Text className="flex-1 text-xs font-sans text-red-800 leading-relaxed">
                    Llevás más de una hora sin movimiento. Es obligatorio tomar un descanso.
                  </Text>
                </View>
              )}
            </>
          )}
        </View>
      </View>
    </View>
  );
};
