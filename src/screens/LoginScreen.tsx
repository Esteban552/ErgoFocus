import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../auth/AuthContext';

type PendingAction = 'submit' | 'reset' | 'retry' | null;

export const LoginScreen: React.FC = () => {
  const {
    configured,
    configurationError,
    initError,
    retryInitialization,
    signIn,
    signUp,
    resetPassword,
  } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const submitLock = useRef(false);

  const normalizedEmail = () => email.trim().toLowerCase();

  const validateEmail = (value: string): boolean => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('Ingresá un email válido.');
      return false;
    }
    return true;
  };

  const submit = async () => {
    if (submitLock.current) return;

    setError(null);
    setInfo(null);
    const cleanEmail = normalizedEmail();
    setEmail(cleanEmail);
    if (!validateEmail(cleanEmail)) return;
    if (password.length < 6) {
      setError('La contraseña necesita al menos 6 caracteres.');
      return;
    }

    submitLock.current = true;
    setPendingAction('submit');
    try {
      const result =
        mode === 'signin'
          ? await signIn(cleanEmail, password)
          : await signUp(cleanEmail, password);

      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.confirmationRequired) {
        setInfo('Te enviamos un email de confirmación. Revisá tu bandeja para activar la cuenta.');
      }
    } finally {
      submitLock.current = false;
      setPendingAction(null);
    }
  };

  const requestPasswordReset = async () => {
    if (submitLock.current) return;

    setError(null);
    setInfo(null);
    const cleanEmail = normalizedEmail();
    setEmail(cleanEmail);
    if (!validateEmail(cleanEmail)) return;

    submitLock.current = true;
    setPendingAction('reset');
    try {
      const result = await resetPassword(cleanEmail);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setInfo('Te enviamos un email para restablecer tu contraseña. Revisá tu bandeja.');
    } finally {
      submitLock.current = false;
      setPendingAction(null);
    }
  };

  const retry = async () => {
    if (submitLock.current) return;
    setError(null);
    setInfo(null);
    submitLock.current = true;
    setPendingAction('retry');
    try {
      await retryInitialization();
    } finally {
      submitLock.current = false;
      setPendingAction(null);
    }
  };

  if (!configured) {
    return (
      <View className="flex-1 bg-[#0d1424] items-center justify-center p-6">
        <Text className="text-2xl font-sans-extrabold text-white mb-2">ErgoFocus</Text>
        <Text className="text-sm font-sans text-rose-300 text-center mb-2">
          No se pudo configurar la autenticación.
        </Text>
        <Text className="text-sm font-sans text-slate-400 text-center max-w-sm">
          {configurationError ?? 'Revisá las variables públicas de Supabase y reiniciá la aplicación.'}
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-[#0d1424]"
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="items-center px-6 py-10">
          <LinearGradient
            colors={['#2563eb', '#06b6d4']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
              width: 72,
              height: 72,
              borderRadius: 999,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 20,
            }}
          >
            <Text className="text-3xl font-sans-extrabold text-white">E</Text>
          </LinearGradient>

          <Text className="text-3xl font-sans-extrabold text-white tracking-tight">
            ErgoFocus
          </Text>
          <Text className="text-sm font-sans text-slate-400 text-center mt-1 mb-8">
            {mode === 'signin'
              ? 'Iniciá sesión para acceder a tu historial'
              : 'Creá tu cuenta para empezar'}
          </Text>

          <View className="w-full max-w-sm gap-3">
            <TextInput
              value={email}
              onChangeText={setEmail}
              onBlur={() => setEmail(normalizedEmail())}
              placeholder="Email"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              className="w-full bg-white/10 border border-white/15 rounded-xl px-4 py-3.5 text-white font-sans text-sm"
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Contraseña"
              placeholderTextColor="#64748b"
              secureTextEntry
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              className="w-full bg-white/10 border border-white/15 rounded-xl px-4 py-3.5 text-white font-sans text-sm"
            />

            {(error ?? initError) && (
              <Text className="text-rose-400 text-xs font-sans text-center">
                {error ?? initError}
              </Text>
            )}
            {info && (
              <Text className="text-emerald-400 text-xs font-sans text-center">{info}</Text>
            )}

            {initError && (
              <Pressable
                onPress={retry}
                disabled={pendingAction !== null}
                className="py-2 items-center"
              >
                <Text className="text-cyan-300 text-xs font-sans-semibold">
                  {pendingAction === 'retry' ? 'Reintentando...' : 'Reintentar conexión'}
                </Text>
              </Pressable>
            )}

            <Pressable
              onPress={submit}
              disabled={pendingAction !== null || Boolean(initError)}
              className={`w-full py-3.5 rounded-full items-center justify-center ${
                pendingAction !== null || initError ? 'bg-[#2563eb]/50' : 'bg-[#2563eb]'
              }`}
            >
              <Text className="font-sans-semibold text-white text-sm">
                {pendingAction === 'submit'
                  ? 'Cargando...'
                  : mode === 'signin'
                  ? 'Iniciar Sesión'
                  : 'Crear Cuenta'}
              </Text>
            </Pressable>

            {mode === 'signin' && (
              <Pressable
                onPress={requestPasswordReset}
                disabled={pendingAction !== null || Boolean(initError)}
                className="py-2"
              >
                <Text className="text-cyan-300 text-xs font-sans text-center">
                  {pendingAction === 'reset' ? 'Enviando...' : 'Olvidé mi contraseña'}
                </Text>
              </Pressable>
            )}

            <Pressable
              onPress={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setError(null);
                setInfo(null);
              }}
              disabled={pendingAction !== null}
              className="py-2"
            >
              <Text className="text-slate-400 text-xs font-sans text-center">
                {mode === 'signin'
                  ? '¿No tenés cuenta? Registrate'
                  : '¿Ya tenés cuenta? Iniciá sesión'}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};
