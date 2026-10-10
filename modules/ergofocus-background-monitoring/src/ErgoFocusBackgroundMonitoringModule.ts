import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface BackgroundMonitoringSnapshot {
  running: boolean;
  lux: number | null;
  decibels: number | null;
  accelerationMagnitude: number | null;
  rotationSpeed: number | null;
  lastMovementAt: number;
  microphoneAvailable: boolean;
  lightAvailable: boolean;
  movementAvailable: boolean;
  gyroAvailable: boolean;
  lightWakeUp: boolean;
  movementWakeUp: boolean;
  gyroWakeUp: boolean;
  error: string | null;
}

declare class ErgoFocusBackgroundMonitoringModule extends NativeModule<{}> {
  startAsync(): Promise<void>;
  stopAsync(): Promise<void>;
  isRunningAsync(): Promise<boolean>;
  getSnapshotAsync(): Promise<BackgroundMonitoringSnapshot>;
  canScheduleExactAlarmsAsync(): Promise<boolean>;
  openExactAlarmSettingsAsync(): Promise<void>;
}

export default requireOptionalNativeModule<ErgoFocusBackgroundMonitoringModule>(
  'ErgoFocusBackgroundMonitoring'
);
