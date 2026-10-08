import { useEffect, useRef, useState } from 'react';
import { Accelerometer, Gyroscope, LightSensor } from 'expo-sensors';

const SEDENTARY_ALERT_MINUTES = 60;
const MANIPULATION_THRESHOLD = 1.2; // rad/s por encima del cual se considera que el teléfono se tomó/manipuló
const VIBRATION_DELTA = 0.5; // diferencia mínima (rad/s) en la ventana para detectar vibración de mesa
const ROTATION_WINDOW = 8; // ~1.6s a 200ms por muestra
const BASELINE_COLLECTION_SAMPLES = 10; // muestras iniciales (~5s) para calibrar la gravedad en reposo
const MOVEMENT_DEVIATION = 0.6; // m/s² sobre la línea base calibrada para considerar movimiento
const MOVEMENT_DEBOUNCE = 2; // muestras consecutivas para confirmar cambio de estado (evita picos)
const REST_CALIBRATION_SAMPLES = 30; // muestras estables (~15s) para recalibrar la línea base
const BASELINE_ADAPTATION = 0.05; // cuánto se acerca la línea base al valor actual al recalibrar

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface SensorState {
  lux: number | null;
  luxAvailable: boolean;
  movementAvailable: boolean;
  accelerationMagnitude: number | null;
  isMoving: boolean;
  sedentaryMinutes: number;
  sedentarySeconds: number;
  sedentaryAlert: boolean;
  gyroAvailable: boolean;
  rotationSpeed: number | null;
  manipulated: boolean;
  deskVibration: boolean;
}

export function useSensors(): SensorState {
  const [lux, setLux] = useState<number | null>(null);
  const [luxAvailable, setLuxAvailable] = useState(false);
  const [movementAvailable, setMovementAvailable] = useState(false);
  const [accelerationMagnitude, setAccelerationMagnitude] = useState<number | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [sedentaryMinutes, setSedentaryMinutes] = useState(0);
  const [sedentarySeconds, setSedentarySeconds] = useState(0);
  const [sedentaryAlert, setSedentaryAlert] = useState(false);

  const [gyroAvailable, setGyroAvailable] = useState(false);
  const [rotationSpeed, setRotationSpeed] = useState<number | null>(null);
  const [manipulated, setManipulated] = useState(false);
  const [deskVibration, setDeskVibration] = useState(false);

  const lastMovementRef = useRef<number | null>(null);
  const alertedRef = useRef(false);
  const rotationWindowRef = useRef<number[]>([]);

  useEffect(() => {
    let mounted = true;
    let subscription: { remove: () => void } | undefined;

    async function init() {
      try {
        const available = await LightSensor.isAvailableAsync();
        if (!mounted || !available) return;
        setLuxAvailable(true);
        LightSensor.setUpdateInterval(2000);
        subscription = LightSensor.addListener((data) => {
          const value =
            typeof (data as { illuminance?: unknown }).illuminance === 'number'
              ? (data as { illuminance: number }).illuminance
              : null;
          if (value !== null && mounted) setLux(Math.max(0, Math.round(value)));
        });
      } catch {
        setLuxAvailable(false);
      }
    }

    void init();
    return () => {
      mounted = false;
      try {
        LightSensor.removeAllListeners();
      } catch {}
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let subscription: { remove: () => void } | undefined;
    const baselineSamples: number[] = [];
    let baseline: number | null = null;
    let above = 0;
    let below = 0;
    let moving = false;

    async function init() {
      try {
        const available = await Accelerometer.isAvailableAsync();
        if (!mounted || !available) return;
        setMovementAvailable(true);
        Accelerometer.setUpdateInterval(500);
        subscription = Accelerometer.addListener((data) => {
          const { x, y, z } = data as { x: number; y: number; z: number };
          const magnitude = Math.sqrt(x * x + y * y + z * z);
          if (!mounted) return;
          setAccelerationMagnitude(Math.round(magnitude * 100) / 100);

          // Calibración inicial: mediana de las primeras muestras = gravedad "en reposo" del equipo.
          if (baseline === null) {
            baselineSamples.push(magnitude);
            if (baselineSamples.length >= BASELINE_COLLECTION_SAMPLES) {
              baseline = median(baselineSamples);
            }
            return;
          }

          const dev = Math.abs(magnitude - baseline);
          if (dev > MOVEMENT_DEVIATION) {
            above += 1;
            below = 0;
          } else {
            below += 1;
            above = 0;
          }

          // Debounce: solo cambia de estado tras varias muestras consecutivas del mismo signo.
          if (above >= MOVEMENT_DEBOUNCE && !moving) {
            moving = true;
            setIsMoving(true);
            const now = Date.now();
            lastMovementRef.current = now;
            alertedRef.current = false;
            setSedentaryMinutes(0);
            setSedentarySeconds(0);
            setSedentaryAlert(false);
          } else if (below >= MOVEMENT_DEBOUNCE && moving) {
            moving = false;
            setIsMoving(false);
          }

          // Recalibración lenta durante reposo estable para seguir deriva del sensor.
          if (below >= REST_CALIBRATION_SAMPLES) {
            baseline = baseline * (1 - BASELINE_ADAPTATION) + magnitude * BASELINE_ADAPTATION;
          }
        });
      } catch {
        setMovementAvailable(false);
      }
    }

    void init();
    return () => {
      mounted = false;
      try {
        Accelerometer.removeAllListeners();
      } catch {}
    };
  }, []);

  useEffect(() => {
    if (!movementAvailable) return;
    const timer = setInterval(() => {
      if (lastMovementRef.current === null) {
        lastMovementRef.current = Date.now();
        return;
      }
      const seconds = Math.floor((Date.now() - lastMovementRef.current) / 1000);
      setSedentarySeconds(seconds);
      const minutes = Math.floor(seconds / 60);
      setSedentaryMinutes(minutes);
      if (minutes >= SEDENTARY_ALERT_MINUTES && !alertedRef.current) {
        alertedRef.current = true;
        setSedentaryAlert(true);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [movementAvailable]);

  useEffect(() => {
    let mounted = true;
    let subscription: { remove: () => void } | undefined;

    async function init() {
      try {
        const available = await Gyroscope.isAvailableAsync();
        if (!mounted || !available) return;
        setGyroAvailable(true);
        Gyroscope.setUpdateInterval(200);
        subscription = Gyroscope.addListener((data) => {
          const { x, y, z } = data as { x: number; y: number; z: number };
          const magnitude = Math.sqrt(x * x + y * y + z * z);
          if (!mounted) return;

          setRotationSpeed(Math.round(magnitude * 100) / 100);

          const isManipulated = magnitude > MANIPULATION_THRESHOLD;
          if (isManipulated) {
            setManipulated(true);
            setDeskVibration(false);
            rotationWindowRef.current = [];
            return;
          }
          setManipulated(false);

          rotationWindowRef.current.push(magnitude);
          if (rotationWindowRef.current.length > ROTATION_WINDOW) {
            rotationWindowRef.current.shift();
          }
          if (rotationWindowRef.current.length >= 4) {
            const max = Math.max(...rotationWindowRef.current);
            const min = Math.min(...rotationWindowRef.current);
            setDeskVibration(max - min >= VIBRATION_DELTA);
          } else {
            setDeskVibration(false);
          }
        });
      } catch {
        setGyroAvailable(false);
      }
    }

    void init();
    return () => {
      mounted = false;
      try {
        Gyroscope.removeAllListeners();
      } catch {}
    };
  }, []);

  return {
    lux,
    luxAvailable,
    movementAvailable,
    accelerationMagnitude,
    isMoving,
    sedentaryMinutes,
    sedentarySeconds,
    sedentaryAlert,
    gyroAvailable,
    rotationSpeed,
    manipulated,
    deskVibration,
  };
}