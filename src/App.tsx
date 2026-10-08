/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, ScrollView, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  useFonts,
  PlusJakartaSans_300Light,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { TabType, SensorId } from './types';
import { TopBar } from './components/TopBar';
import { BottomNav } from './components/BottomNav';
import { DashboardTab } from './components/DashboardTab';
import { AmbientTab } from './components/AmbientTab';
import { TrendsTab } from './components/TrendsTab';
import { ProfileTab } from './components/ProfileTab';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginScreen } from './screens/LoginScreen';
import { useSensors } from './sensors/useSensors';
import { useHealthAlerts, configureNotifications, registerForPushNotificationsAsync } from './notifications';
import { logSensor, syncSensorDailyToSupabase } from './db/repos';

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_300Light,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });

  if (!fontsLoaded && !fontError) {
    return <View className="flex-1 bg-[#faf8ff]" />;
  }

  return (
    <AuthProvider>
      <SafeAreaProvider>
        <MainApp />
      </SafeAreaProvider>
    </AuthProvider>
  );
}

function MainApp() {
  const { initializing, signOut } = useAuth();
  const userId = "dev-user-local-123";

  const [currentTab, setCurrentTab] = useState<TabType>('dashboard');

  // Ambient state (noise comes from the microphone meter, managed in AmbientTab)
  const [decibels, setDecibels] = useState<number | null>(null);

  // Real-time sensor readings (light, acceleration, gyroscope)
  const sensors = useSensors();

  useHealthAlerts({
    lux: sensors.lux,
    luxAvailable: sensors.luxAvailable,
    decibels,
    sedentaryAlert: sensors.sedentaryAlert,
  });

  const sensorsRef = useRef(sensors);
  sensorsRef.current = sensors;
  const decibelsRef = useRef(decibels);
  decibelsRef.current = decibels;

  useEffect(() => {
    void configureNotifications();
    void registerForPushNotificationsAsync(userId);
    if (userId) {
      void syncSensorDailyToSupabase(userId, 7);
    }
  }, [userId]);

  // Periodic persistence of the latest readings per linked user
  useEffect(() => {
    const flush = () => {
      const s = sensorsRef.current;
      const samples: { sensor: SensorId; value: number }[] = [];
      if (s.lux !== null) samples.push({ sensor: 'light', value: s.lux });
      if (decibelsRef.current !== null) {
        samples.push({ sensor: 'sound', value: decibelsRef.current });
      }
      if (s.rotationSpeed !== null) samples.push({ sensor: 'gyro', value: s.rotationSpeed });
      samples.push({ sensor: 'movement', value: s.sedentaryMinutes });
      for (const sample of samples) {
        logSensor(userId, sample.sensor, sample.value).catch((error) =>
          console.warn('No se pudo guardar el log del sensor:', error)
        );
      }
      if (userId) {
        void syncSensorDailyToSupabase(userId, 7);
      }
    };
    const interval = setInterval(flush, FLUSH_INTERVAL_MS);
    flush();
    return () => clearInterval(interval);
  }, [userId]);

  const handleUpdateDecibels = useCallback((value: number | null) => {
    setDecibels(value);
  }, []);

  if (initializing) {
    return <View className="flex-1 bg-[#faf8ff]" />;
  }

  if (!userId) {
    return (
      <SafeAreaProvider>
        <LoginScreen />
      </SafeAreaProvider>
    );
  }

  const noiseStatus = decibels === null ? 'sin-medicion' as const : decibels < 50 ? 'silencioso' as const : decibels < 70 ? 'moderado' as const : 'ruidoso' as const;

  return (
    <View className="flex-1 bg-[#faf8ff]">
      <StatusBar style="dark" />

      {/* Top Navigation Bar */}
      <SafeAreaView edges={['top']} style={{ backgroundColor: '#ffffff' }}>
        <TopBar onSignOut={() => void signOut()} />
      </SafeAreaView>

      {/* Main Container */}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 24,
          paddingBottom: 120,
        }}
      >
        {currentTab === 'dashboard' && (
          <DashboardTab
            sensors={sensors}
            decibels={decibels}
            noiseStatus={noiseStatus}
            onNavigateToAmbient={() => setCurrentTab('ambient')}
          />
        )}

        {currentTab === 'ambient' && (
          <AmbientTab
            sensors={sensors}
            decibels={decibels}
            onUpdateDecibels={handleUpdateDecibels}
          />
        )}

        {currentTab === 'trends' && <TrendsTab />}

        {currentTab === 'profile' && <ProfileTab />}
      </ScrollView>

      {/* Bottom Floating Navigation */}
      <BottomNav currentTab={currentTab} onTabChange={setCurrentTab} />
    </View>
  );
}