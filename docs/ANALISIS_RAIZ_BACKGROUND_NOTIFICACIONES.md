# Análisis de raíz — ErgoFocus

> **Estado posterior:** las correcciones derivadas de este diagnóstico están documentadas en
> `docs/CORRECCIONES_IMPLEMENTADAS_2026-10-09.md`. Este archivo conserva el estado previo y la
> justificación técnica.

**Sensores y notificaciones en segundo plano (prioridad máxima), confirmación de cuenta, post‑pago y feedback de usuario**

> **Fecha:** 2026‑10‑08
> **Autor:** Análisis automatizado sobre el código en `master` (working tree con cambios sin commitear).
> **Propósito:** Documento de hallazgos para que **otra IA / revisión humana** valide y priorice. Incluye causa raíz, evidencia (archivo:línea), mecanismo técnico con fuentes oficiales, y preguntas abiertas.
> **Stack:** Expo SDK 57 (`expo@~57.0.27`) · React Native 0.86.3 · React 19.2.3 · New Architecture (Fabric/TurboModules) por defecto · Supabase (Auth + Edge Functions) · Stripe · `react-native-background-actions@4.1.0` · `expo-sensors@~57.0.3` · `expo-audio@~57.0.5` · `expo-notifications@~57.0.22`.

---

## 0. Resumen ejecutivo

El requisito crítico — *"si arranco un cronómetro y salgo de la app o apago la pantalla, los sensores deben seguir midiendo y deben seguir llegando notificaciones"* — **hoy no se cumple de forma confiable**. El código asume un modelo mental equivocado sobre cómo funciona el background en Android/iOS.

| # | Hallazgo | Severidad | ¿Rompe el requisito crítico? |
|---|---|---|---|
| **RC‑1** | `expo-sensors` **no entrega lecturas a JS** con la app en segundo plano ni con la pantalla apagada/Doze. Los listeners viven en el runtime JS de React. | 🔴 CRÍTICO | **Sí** |
| **RC‑2** | El "servicio en primer plano" (`react-native-background-actions`) **no mantiene vivos** los timers JS ni los listeners de sensores: no toma `PARTIAL_WAKE_LOCK`, corre en el **mismo** runtime JS (HeadlessJS), y la New Architecture puede pausar el JS. | 🔴 CRÍTICO | **Sí** |
| **RC‑3** | La medición de **ruido (micrófono)** no sigue en background: falta `enableBackgroundRecording` en el plugin y `shouldPlayInBackground: true` en `setAudioModeAsync`. | 🔴 CRÍTICO | **Sí** |
| **RC‑4** | Las alertas de **luz y ruido** dependen de un `setInterval` JS (30 s) → sólo funcionan en primer plano. | 🟠 ALTO | **Sí** |
| **RC‑5** | Las notificaciones locales que **sí** dispara el SO (fin de bloque, descanso, sedentarismo) son **inexactas** en Android 12+: falta `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM`. | 🟠 ALTO | Parcial |
| **RC‑6** | **No existe disparador server‑side del push remoto**. `send-push` sólo lo invoca la app en primer plano. Además **falta FCM v1 / `google-services.json`** → el push remoto no funciona en el APK de release. | 🔴 CRÍTICO | **Sí** |
| **RC‑7** | Confusión de diseño: se compara "push remoto" con "notificación local programada". Lo único que funciona con la app cerrada es la local (inexacta); el "push" es un complemento que sólo corre en foreground. | 🟠 ALTO | Sí |
| **RC‑8** | Si el usuario **desliza la app fuera de recientes**, el servicio y todos los sensores se detienen. | 🟠 ALTO | Sí |
| **RC‑9** | `react-native-background-actions` **no soporta oficialmente la New Architecture** (issue #249 abierto). Riesgo de fallo silencioso en SDK 57. | 🟡 MEDIO | Sí |
| **RC‑10** | Zoom de UI post‑pago con **doble `Alert`** y polling corto (8 s); verificación `checkout:verify` matchea por email sin binding fuerte. | 🟡 MEDIO | No |
| **RC‑11** | Confirmación de cuenta: el link cae a `localhost:3000` por **configuración del panel de Supabase** (Site URL / Redirect URLs), no por el código. | 🟠 ALTO | No |
| **RC‑12** | Ausencia generalizada de **feedback al usuario** (logout, sync, export, permisos, sync silencioso de usuarios free). | 🟡 MEDIO | No |
| **RC‑13** | Deuda/seguridad: anon key + URL hardcodeadas en `app.json extra`; migraciones duplicadas (`db.sql` + 2 migraciones); posible desalineación del `projectId` de EAS. | 🟡 MEDIO | No |

**Conclusión de una línea:** el sistema intenta mantener vivos los sensores "haciendo que el proceso no muera", pero el cuello de botella no es la muerte del proceso: es que **el runtime JS y el CPU se suspenden** con la pantalla apagada, que **expo-sensors no tiene soporte de background**, y que **no hay un emisor de push del lado servidor**.

---

## 1. Alcance y método

- **Lectura directa** de: `src/App.tsx`, `src/background/monitoring.ts`, `src/sensors/useSensors.ts`, `src/notifications.ts`, `src/components/{DashboardTab,AmbientTab,ProfileTab,TrendsTab,TopBar,BottomNav}.tsx`, `src/auth/AuthContext.tsx`, `src/lib/{billing,supabase}.ts`, `src/db/{repos,database}.ts`, `src/screens/LoginScreen.tsx`, `supabase/functions/*`, `supabase/migrations/*`, `db.sql`, `app.json`, `eas.json`, `android/app/src/main/AndroidManifest.xml`, `plugins/withBackgroundMonitoring.js`.
- **Verificación externa** contra documentación oficial de Expo, Android Developers y fuente de `react-native-background-actions` / `expo-notifications` (fuentes citadas en cada sección).
- **No** se ejecutó la app en dispositivo real: hay inferencias marcadas como tales. Ver §9 "Cómo reproducir / verificar".

---

## 2. PRIORIDAD MÁXIMA — Sensores y notificaciones en segundo plano

### 2.1 El modelo mental que tiene el código (y por qué es incorrecto)

Comentario textual del código, `src/background/monitoring.ts:12‑16`:

```ts
/**
 * The task only keeps the JS runtime alive while the foreground service runs.
 * Sensor listeners, the microphone meter and the health-alert timers live in React and
 * continue to execute because the process is not suspended by Android.
 */
```

Esa premisa es **falsa en tres frentes**:

1. Un **Foreground Service (FGS) mantiene el proceso vivo y visible, pero NO mantiene despierto al CPU**. Sin `PARTIAL_WAKE_LOCK`, con la pantalla apagada el CPU puede suspenderse; y en **Doze** el sistema *ignora* los wake locks de las apps. → los `setInterval`/`setTimeout` de JS **se congelan**. Fuente: [Android — Background work / services](https://developer.android.com/develop/background-work/services).
2. **`expo-sensors` no tiene modo background**: no hay `UIBackgroundModes`, ni FGS, ni entry point headless; los listeners sólo emiten mientras el runtime JS está activo. Fuente: [Expo Accelerometer docs](https://docs.expo.dev/versions/latest/sdk/accelerometer.md) (no existe API de background).
3. El "keep alive" que se implementa es un `sleep` loop (`monitoring.ts:17‑21`) que **no hace la medición**: la lógica real (sensores, micrófono, temporizadores de salud) vive en los **hooks de React** montados en el árbol de UI (`App.tsx` → `useSensors`, `useHealthAlerts`, `AmbientTab`). El servicio no los "arrastra".

### 2.2 Causas raíz (detalladas)

#### RC‑1 🔴 `expo-sensors` no emite con la app en background / pantalla apagada
- **Dónde:** `src/sensors/useSensors.ts` — `LightSensor` (`:56‑85`), `Accelerometer` (`:87‑166`), `Gyroscope` (`:187‑237`). Los tres usan `addListener` sobre el runtime JS de React.
- **Mecanismo:** con la app en background o pantalla apagada, el bridge/EventEmitter deja de entregar eventos (no hay servicio nativo que lea los sensores y despierte al JS).
- **Efecto observable:** `lux`, `accelerationMagnitude`, `isMoving`, `manipulated`, `deskVibration` y `sedentarySeconds` **se congelan**. El contador de sedentarismo (`useSensors.ts:168‑185`) y la reprogramación de su notificación (`notifications.ts:286‑302`) **nunca se ejecutan** con la pantalla apagada.
- **Consecuencia de producto:** el "cronómetro de sedentarismo" en background es sólo un número congelado; la reprogramación "al moverse" no ocurre → puede salir un aviso de sedentarismo **falso positivo** (el SO dispara la alarma agendada aunque el usuario sí se haya movido, porque la app no se enteró).

#### RC‑2 🔴 El Foreground Service no mantiene vivos los timers ni los sensores
- **Dónde:** `src/background/monitoring.ts:23‑31` (OPTIONS), `:37‑44` (start/stop), `:17‑21` (`keepAliveTask`).
- **Mecanismo verificado:**
  - `react-native-background-actions@4.1.0` **no adquiere `PARTIAL_WAKE_LOCK`** (ni declara `WAKE_LOCK` en su manifest). Fuente: `RNBackgroundActionsTask.java` / `BackgroundActionsModule.java` del repo.
  - Corre en **HeadlessJS** dentro del **mismo** runtime JS (no un contexto aislado). Bajo la New Architecture, RN puede **pausar la ejecución JS cuando la Activity no está activa** (RN #50327). Fuente: [Headless JS](https://reactnative.dev/docs/headless-js-android).
  - La librería es un `ReactContextBaseJavaModule` **legacy**; el soporte de New Architecture está **abierto y sin resolver** (issue #249). En SDK 57 (New Arch por defecto) esto es un riesgo de fallo silencioso.
- **Sobre `foregroundServiceType: ['microphone']`:** sólo tiene sentido semántico para el micrófono. **No existe un tipo de FGS "sensores"** en Android, así que declarar el servicio no hace que el acelerómetro/giroscopio/luz sigan funcionando. Fuente: [FGS types](https://developer.android.com/develop/background-work/services/fgs/service-types).
- **Restricción Android 14 (API 34):** un FGS con tipo que requiere permiso "while‑in‑use" (p. ej. `microphone`) **no puede iniciarse desde background**; lanza `SecurityException` salvo que ya se tenga `RECORD_AUDIO`. Hoy se arranca con la app en foreground, pero conviene tenerlo presente. Fuente: [Restricciones de arranque desde background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).

#### RC‑3 🔴 El micrófono / la medición de ruido no sigue en background
- **Dónde:** `src/components/AmbientTab.tsx:103` → `setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })`; grabación con `useAudioRecorder(METERED_RECORDING_OPTIONS, …)` (`:37‑47`).
- **Falta:**
  1. El **plugin `expo-audio`** con `enableBackgroundRecording: true` (default `false`). Sin eso no se agrega el servicio de grabación en background ni los permisos correspondientes. En `app.json:46` el plugin está como string `"expo-audio"`, sin opciones.
  2. En `expo-audio`, el flag correcto de `setAudioModeAsync` es **`shouldPlayInBackground: true`** (el nombre `staysActiveInBackground` es de la vieja `expo-av`/`Audio` y **no** es de `expo-audio`). El código no lo pasa.
- **Bug conocido de Expo:** aunque `allowsBackgroundRecording` arranque el FGS, la grabación **se pausa** porque el ciclo de vida está condicionado por `shouldPlayInBackground` (expo/expo #46731). Workaround: pasar **ambos** flags.
- **Efecto:** `decibels` queda congelado/`null` → la alerta de ruido no puede recalcularse (`notifications.ts:321‑330`).
- **Fuentes:** [Expo Audio docs](https://docs.expo.dev/versions/latest/sdk/audio.md) · [expo/expo #46731](https://github.com/expo/expo/issues/46731).

#### RC‑4 🟠 Las alertas de luz/ruido usan un `setInterval` de JS → sólo primer plano
- **Dónde:** `src/notifications.ts:243‑334`. Constante `TICK_MS = 30_000` (`:243`) y `setInterval(..., TICK_MS)` (`:305‑331`).
- **Mecanismo:** el tick vive en el runtime JS. Con la app suspendida o CPU dormido, no corre. El propio código lo admite en el comentario `:250‑257` ("requiere la app activa").
- **Efecto:** con la pantalla apagada, **no llegan** las alertas de iluminación fuera de rango ni de ruido ≥ 70 dB.

#### RC‑5 🟠 Notificaciones locales del SO → **inexactas** en Android 12+
- **Dónde:** `scheduleLocalNotification` usa trigger `DATE` (`notifications.ts:107‑128`); `scheduleRepeatingLocalNotification` usa `TIME_INTERVAL` + `repeats: true` (`:139‑160`). Se usan para: fin de bloque de enfoque (`DashboardTab.tsx:150‑155`), descanso horario (`notifications.ts:277‑282`) y sedentarismo (`:296‑301`).
- **Problema:** ni `SCHEDULE_EXACT_ALARM` ni `USE_EXACT_ALARM` están declarados. `app.json:25‑32` no los incluye, y el **config plugin de `expo-notifications` NO los agrega** (sólo maneja icono/color/sonidos/canales). Evidencia local: `android/app/src/main/AndroidManifest.xml:2‑12` no los declara.
- **Mecanismo verificado en el source de Expo:** `ExpoSchedulingDelegate.setupAlarm()` decide:
  ```kotlin
  val canScheduleExact = SDK_INT < S || alarmManager.canScheduleExactAlarms()
  when {
    !canScheduleExact -> AlarmManagerCompat.setAndAllowWhileIdle(...)  // INEXACTO
    alarmClock        -> alarmManager.setAlarmClock(...)
    else              -> AlarmManagerCompat.setExactAndAllowWhileIdle(...)
  }
  ```
  Sin permiso exacto, en Android 12+ `canScheduleExactAlarms()` es `false` → cae a **`setAndAllowWhileIdle`** (batching de Doze, sin garantía de hora). **No** lanza excepción: degrada en silencio.
- **Fuentes:** `withNotificationsAndroid.ts` y `ExpoSchedulingDelegate.kt` del repo Expo; [`AlarmManager.canScheduleExactAlarms()`](https://developer.android.com/reference/android/app/AlarmManager#canScheduleExactAlarms()).
- **Efecto:** el aviso de fin de enfoque y el de descanso pueden llegar **tarde** (minutos, y con Doze potencialmente más). No es "que no llegue", es "que no llega a horario".

#### RC‑6 🔴 No existe push remoto real en background (dos problemas sumados)
1. **No hay emisor server‑side.** `sendRemotePushNotification` (`notifications.ts:168‑188`) se llama **sólo** desde `DashboardTab.tsx:90` cuando el bloque termina **con la app corriendo**. La Edge Function `send-push` sólo se invoca desde el cliente. **No hay `pg_cron`, trigger de base de datos ni ningún scheduler en `supabase/`** (verificado: sólo hay `functions/{checkout,delete-account,send-push,stripe-webhook}` y 2 migraciones). ⇒ Con la app cerrada, **nadie le pide al servidor que envíe nada**.
2. **Falta FCM v1 / `google-services.json`.** No existe `google-services.json` en el repo ni el plugin `com.google.gms.google-services` en Gradle. En un build standalone de Android, `getExpoPushTokenAsync` requiere credenciales FCM v1 cargadas en EAS (o `google-services.json`). El APK de release incluido (`ErgoFocus-v1.0.0.apk`, build local) **no las tiene** ⇒ el push remoto no funciona ahí. Fuente: [Expo FCM credentials](https://docs.expo.dev/push-notifications/fcm-credentials.md).
- **Efecto combinado:** el "push" que el usuario espera en background **no existe**. Lo único que puede llegar con la app cerrada es la notificación local del SO (RC‑5, inexacta).

#### RC‑7 🟠 Diseño: "local programada" ≠ "push remoto"
- El código presenta el push remoto como "complemento" de la local (`notifications.ts:163‑165`, `DashboardTab.tsx:89`). Pero el comportamiento real es: **local = funciona con app cerrada (inexacta)**; **remoto = sólo foreground y hoy ni siquiera con FCM configurado**. Para la expectativa del usuario ("siga mandando push si tengo un cronómetro activo"), el diseño correcto es que **el servidor** sea el que envía, o que todo se resuelva con notificaciones locales exactas.

#### RC‑8 🟠 Cerrar la app desde "recientes" detiene todo
- `react-native-background-actions` no está configurado como servicio *sticky*/managed; si el usuario desliza la app, el FGS muere y con él sensores, micrófono y timers. Las alarmas locales del SO sobreviven (AlarmManager), pero son inexactas.
- El propio doc previo lo reconoce: `docs/CAMBIOS_SESION_2026-10-08.md:88‑91`.

#### RC‑9 🟡 Riesgo de librería en New Architecture
- `react-native-background-actions@4.1.0` es un NativeModule legacy. En SDK 57 la New Architecture es el default; el issue #249 sigue abierto. Puede fallar silenciosamente o requerir el interop legacy. **A confirmar en dispositivo.**

### 2.3 Traza completa del caso "cronómetro activo + salgo / pantalla apagada"

| Momento | Qué ocurre realmente | Componente |
|---|---|---|
| Usuario toca "Iniciar Enfoque" | `setEndAt(Date.now() + base)`; agenda notificación local `DATE`; pide permiso; intenta push remoto (sólo foreground) | `DashboardTab.tsx:117‑157` |
| App pasa a background | `AppState` = background. `supabase.auth.stopAutoRefresh()`. El `setInterval` de `clockNow` (`:67‑70`) depende del runtime JS. | `supabase.ts:92‑99`, `DashboardTab.tsx:67` |
| Pantalla se apaga | Sin `PARTIAL_WAKE_LOCK`, el CPU puede suspenderse. En Doze se ignoran wake locks. `clockNow`, sensores, salud → congelados. | Android + RC‑2 |
| Llega la hora del fin | El SO dispara la alarma **inexacta** (RC‑5): puede demorarse. | `notifications.ts:107‑128` |
| App vuelve a primer plano | `clockNow` salta, el effect de fin (`DashboardTab.tsx:78‑96`) recién ahora corre: `sendRemotePushNotification(...)` (tarde), chime, etc. | `DashboardTab.tsx` |
| Con la app cerrada del todo | Sólo sobrevive la alarma local del SO (inexacta). **Ningún push remoto.** | RC‑6 |

### 2.4 Qué SÍ y qué NO funciona hoy

| Escenario | Estado real |
|---|---|
| App abierta, mirando la pantalla | ✅ Sensores, alertas de salud (tick 30 s), timer, notificaciones inmediatas. |
| App en background, pantalla **encendida** | 🟠 Parcial/incierto: depende de si el CPU se suspende y del fabricante. Sensores y timers no garantizados. |
| Pantalla apagada / Doze | 🔴 Sensores congelados; alertas de luz/ruido no llegan; micrófono se pausa. |
| Notificación de fin de enfoque (app cerrada) | 🟠 Llega, pero **inexacta** (sin permiso de alarma exacta). |
| Push remoto con app cerrada | 🔴 No existe (sin scheduler + sin FCM v1). |
| App cerrada desde recientes | 🔴 Todo el monitoreo se detiene. |

### 2.5 Evidencia (archivo:línea)

- `src/background/monitoring.ts:12‑21` — premisa falsa + `keepAliveTask` que sólo duerme.
- `src/background/monitoring.ts:23‑31` — `foregroundServiceType: ['microphone']`.
- `src/sensors/useSensors.ts:56‑237` — listeners de sensores en JS.
- `src/notifications.ts:243‑334` — `TICK_MS`/`setInterval` de salud; comentario que admite primer plano.
- `src/notifications.ts:107‑160` — triggers `DATE`/`TIME_INTERVAL`.
- `src/notifications.ts:168‑188` — push remoto sólo desde cliente.
- `src/components/AmbientTab.tsx:37‑47,103` — `setAudioModeAsync` sin flag de background.
- `src/components/DashboardTab.tsx:67‑96,150‑155` — timer y notificación de fin.
- `app.json:25‑32` — permisos sin `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM`/`WAKE_LOCK`.
- `app.json:46` — plugin `expo-audio` sin `enableBackgroundRecording`.
- `plugins/withBackgroundMonitoring.js:19‑24` — manifest del servicio.
- `android/app/src/main/AndroidManifest.xml:29` — servicio `foregroundServiceType="microphone"`.

### 2.6 Recomendaciones (con tradeoffs)

**A. Corto plazo (más barato, mejora real del caso "cronómetro")**
1. **Aceptar que sensores en background no son viables con `expo-sensors`** y mover la garantía a **notificaciones locales exactas**:
   - Declarar `SCHEDULE_EXACT_ALARM` (y/o `USE_EXACT_ALARM`) en `app.json` → `android.permissions`, y ofrecer la pantalla de permiso en Android 12+ (`Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)`).
   - Programar el aviso de fin de bloque y el de descanso con alarma exacta. Esto **sí** cumple "salgo de la app y me avisa a horario".
   - *Tradeoff:* Google Play audita `USE_EXACT_ALARM`; usar `SCHEDULE_EXACT_ALARM` (revocable por el usuario) para apps que no son alarmas/calendario.
2. **Habilitar background real del micrófono**: plugin `["expo-audio", { "enableBackgroundRecording": true }]` + `setAudioModeAsync({ allowsRecording: true, shouldPlayInBackground: true, playsInSilentMode: true })`. *Tradeoff:* FGS permanente + consumo + política de Play.
3. **Pedir exclusión de optimización de batería** (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) para el monitoreo extendido, con explicación al usuario. *Tradeoff:* UX y auditoría de Play.
4. **Feedback explícito honesto**: cambiar el texto del interruptor "Monitoreo en segundo plano" para decir qué sí y qué no garantiza (hoy promete sensores con pantalla bloqueada, lo cual no es cierto con `expo-sensors`).

**B. Mediano plazo (la arquitectura correcta para "push en background")**
5. **Mover el disparo al servidor**: un `pg_cron` (Supabase Cron) o una Edge Function programada que, para cada usuario con "cronómetro activo", llame a `send-push`. Esto requiere **persistir sesiones de foco** en una tabla (`focus_sessions` con `ends_at`) en vez de tenerlas sólo en estado de React. Es el único camino para "push con la app cerrada".
6. **Configurar FCM v1 en EAS** (cuenta de servicio) o agregar `google-services.json`, y validar `getExpoPushTokenAsync` en dispositivo. Sin esto, ningún push remoto funciona en APK.
7. **Verificar la consistencia del EAS `projectId`**: `notifications.ts:8‑14` usa fallback `eb0c8cf1-…` y `app.json:57` también; hay memoria previa que menciona otro proyecto (`5c793a31-…`). Un `projectId` equivocado hace fallar `getExpoPushTokenAsync`.
8. **Sensores en background (si es requisito duro):** `expo-sensors` no alcanza. Opciones: (a) plugin nativo propio con `SensorManager` + `PARTIAL_WAKE_LOCK` dentro de un FGS `dataSync`; (b) librerías de actividad (p. ej. Google Activity Recognition); (c) restringir la app a foreground. *Tradeoff:* complejidad nativa alta + batería + Play.
9. **Evaluar reemplazo de `react-native-background-actions`** por una solución New‑Arch compatible, o fijar el interop legacy, dado RC‑9.

### 2.7 Preguntas abiertas para el revisor

1. ¿El requisito "sensores con pantalla apagada" es **duro** (nota del examen) o alcanza con "notificaciones exactas a horario"? Cambia completamente la solución.
2. ¿Se acepta un FGS permanente (batería + política de Play) a cambio del monitoreo real?
3. ¿El proyecto Supabase permite `pg_cron` (plan) para el scheduler server‑side?
4. ¿Se puede reconstruir el APK vía EAS (para inyectar FCM) en vez de build local?

---

## 3. Confirmación de cuenta: el link cae a `localhost:3000`

**Estado del código (ya corregido a nivel cliente):**
- `AuthContext.tsx:18‑19`: `AUTH_REDIRECT_URL = process.env.EXPO_PUBLIC_AUTH_REDIRECT_URL || 'ergofocus://auth-callback'`.
- `signUp` (`:318‑342`) y `resetPassword` (`:369‑395`) pasan `emailRedirectTo: AUTH_REDIRECT_URL`.
- `AuthContext.tsx:189‑279`: handler de deep links procesa `payment/success`, `payment/cancel`, hash (`#access_token=…`) y PKCE (`?code=…`).
- `android/.../AndroidManifest.xml:40‑46`: el scheme `ergofocus` (y `exp+ergofocus`) está registrado.

**Por qué igual cae a `localhost:3000`:**
- El host del link de confirmación que arma Supabase es el **Site URL** del proyecto (Authentication → URL Configuration). Si sigue en `http://localhost:3000`, el link apunta ahí.
- Si `ergofocus://**` **no está en la allowlist de Redirect URLs**, Supabase **ignora** el `emailRedirectTo` y cae al Site URL por defecto.
- **Esto es configuración del panel, no código.** No hay `supabase/config.toml` en el repo (no se gestiona el `site_url` desde el proyecto local).

**Acciones:**
1. En Supabase → Authentication → URL Configuration: definir **Site URL** a un `https://` controlado (idealmente una página que redirija al scheme) y **agregar `ergofocus://**` a Redirect URLs.
2. Verificar que la plantilla del email use `{{ .ConfirmationURL }}` con `redirect_to` (para que respete el `emailRedirectTo`).
3. Mantener la nota en `.env.example` sobre `EXPO_PUBLIC_AUTH_REDIRECT_URL`.
4. **Bug menor de UX:** en recuperación de contraseña, el handler sólo establece la sesión (`:244‑267`) y no guía al usuario a elegir una contraseña nueva. Faltaría una pantalla de "nueva contraseña".

**Pregunta abierta:** ¿Supabase acepta `ergofocus://auth-callback` directamente como Site URL? (Incierto; lo estándar y seguro es Site URL `https://…` + scheme en allowlist.)

---

## 4. Actualización de interfaces posterior al pago

**Flujo actual:**
1. `startCheckout()` (`src/lib/billing.ts:19‑38`) → `supabase.functions.invoke('checkout')` → devuelve `{ url }`.
2. `DashboardTab.handleUpgrade` / `ProfileTab.handleUpgrade` → `Linking.openURL(url)`.
3. Stripe redirige a `ergofocus://payment/success` (`checkout/index.ts:138`) → `AuthContext` deep link (`:198‑229`).

**Problemas encontrados:**
- **Doble `Alert` inmediato:** al volver del pago se muestra `'¡Pago recibido!'` ("Estamos sincronizando…") y enseguida otro `Alert` de éxito/registrado (`AuthContext.tsx:199‑227`). Confuso; debería haber un estado único "Verificando pago…".
- **Polling corto y bloqueante:** 4 iteraciones × 2 s = **8 s** (`:213‑223`). Si el webhook de Stripe tarda más, se rinde y muestra "Pago registrado…". No hay reintento persistente ni suscripción **Realtime** a `profiles`.
- **UI no refleja estado "pendiente"**: entre el pago y la confirmación del webhook no hay un estado visual claro (badge "Pro (pendiente)").
- **La verificación `checkout:verify`** (`checkout/index.ts:42‑96`) lista las últimas 20 sesiones globales y matchea por `client_reference_id`/`metadata.user_id`/`customer_email`. El match **por email** es un *smell* (si bien está autenticado, conviene exigir binding estricto por `user_id`).
- **Roles/secciones no se refrescan más que por `AppState` y `refreshRole()`** (`DashboardTab.tsx:60‑65`, `ProfileTab.tsx:242‑247`). Si el pago se completa en otro dispositivo, no hay actualización en vivo.
- **`checkoutBusy` se libera al volver de `openURL`** aunque el usuario siga en el navegador (`DashboardTab.tsx:211‑213`) → permite doble toque.

**Recomendaciones:** estado único de verificación con spinner; suscripción Realtime a `profiles` o polling con backoff más largo (p. ej. 30–60 s); badge "Pro pendiente"; endurecer `verify` a `user_id`; deshabilitar el botón hasta el retorno real por deep link.

---

## 5. Falta de feedback al usuario (inventario)

No existe un sistema global de feedback (ni toasts/snackbars ni Skeletons). Predominan texto inline y `Alert.alert`. Hallazgos:

| Acción | Feedback actual | Problema |
|---|---|---|
| Cerrar sesión (`TopBar.tsx:31‑37` → `App.tsx:141`) | **Ninguno** | Sin confirmación ni estado; `signOut()` devuelve `AuthActionResult` que **se ignora** (`void signOut()`) → fallo silencioso. |
| Sincronización diaria a Supabase (`App.tsx:88,108‑110` → `repos.ts:83‑119`) | Sólo `console.warn` en logs locales | El usuario nunca sabe si sincronizó. Además se llama para **todos** los usuarios; RLS sólo permite insertar a *pro* → los *free* generan errores **silenciosos**. |
| `logSensor` (`App.tsx:104‑107`) | Sólo `console.warn` | Pérdida de datos invisible. |
| Iniciar/pausar/reiniciar enfoque (`DashboardTab.tsx:117‑168`) | Cambio de texto + (al final) chime | Sin toast/háptica al iniciar/pausar; sin confirmación inmediata. |
| Verificar suscripción (`DashboardTab.tsx:216‑239`) | `Alert` al final | Sin spinner en el botón. |
| Exportar PDF (`ProfileTab.tsx:275‑299`) | "Generando PDF…" + share sheet | Sin confirmación de éxito; errores sólo como `Alert`. |
| Eliminar cuenta (`ProfileTab.tsx:344‑357`) | Confirmación + "Eliminando…" | Correcto, pero sin toast final. |
| Toggle de monitoreo (`ProfileTab.tsx:585‑589`) | Sólo switch + texto de error | Sin confirmación de éxito; no aclara el permiso de batería. |
| Permiso de micrófono/notificaciones | Alerts en onboarding del micrófono | `registerForPushNotificationsAsync` falla **en silencio** (`notifications.ts:208‑210`). |
| Tendencias (`TrendsTab.tsx:196‑197`) | Texto "Cargando…" | Sin skeleton; sin indicador de refresco. |
| Sin conexión / errores de red | No hay banner | `normalizeAuthError` cubre login, pero el resto no. |
| Accesibilidad | Pocos `accessibilityLabel` | La mayoría de los `Pressable` no los tiene. |

**Recomendación:** introducir un **Toast/Snackbar global** (p. ej. contexto propio o `react-native-toast-message`) + **haptics** (`expo-haptics`) para acciones clave, **spinners** en botones async, y **estados vacío/error/éxito** consistentes. Corregir el sync para *free* (no intentar insertar o informar "función Pro").

---

## 6. Hallazgos adicionales / deuda técnica

- **Seguridad/config:** `app.json:53‑60` incluye `EXPO_PUBLIC_SUPABASE_URL`, la **anon key** y `eas.projectId` hardcodeados (la anon key es pública por diseño, pero conviene gestionarla por `.env`/EAS, no en el repo). `supabase.ts:16‑23` la lee de `extra` como fallback.
- **`projectId` de EAS:** fallback `eb0c8cf1-…` en `notifications.ts:12` y `app.json:57`; hay memoria de sesión que menciona otro `projectId`. **Verificar** (impacta push).
- **Migraciones duplicadas:** `db.sql` + `supabase/migrations/20261008000000_profiles_and_push.sql` definen lo mismo; `db.sql` agrega RLS extra de `deleted_at`. Riesgo de drift.
- **`expo-audio` en `app.json:46`** sin opciones → sin background recording (ver RC‑3).
- **Sin permisos** `WAKE_LOCK`, `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.
- **`Del` `keepAliveTask`** no verifica errores del servicio; un fallo de `BackgroundService.start` sólo se traduce en texto de error (`monitoring.ts:122‑124`).
- **`App.tsx`** monta `AmbientTab` siempre oculto (`:163‑169`) para no cortar el micrófono: buena intención, pero combinado con RC‑3 no alcanza en background.

---

## 7. Plan sugerido priorizado

1. **Decidir el alcance real** del requisito "background" (ver §2.7).
2. **Ruta rápida:** notificaciones locales **exactas** + `enableBackgroundRecording` + `shouldPlayInBackground` + exclusión de batería + feedback honesto. (Cubre "salgo de la app / apago pantalla y me avisa".)
3. **Ruta completa:** persistir `focus_sessions` + scheduler server‑side (`pg_cron`) + FCM v1/EAS + validar token en dispositivo. (Cubre "push con la app cerrada".)
4. **Sensores en background:** decidir si se acepta limitación (foreground) o se invierte en plugin nativo con wake lock.
5. **Supabase Auth:** Site URL + Redirect URLs (localhost:3000).
6. **Post‑pago:** estado único de verificación + Realtime + badge pendiente.
7. **Feedback global:** toasts + haptics + spinners + sync correcto para free.

---

## 8. Fuentes técnicas

- Expo Accelerometer (sin background): https://docs.expo.dev/versions/latest/sdk/accelerometer.md
- Expo Audio (background recording, `shouldPlayInBackground`): https://docs.expo.dev/versions/latest/sdk/audio.md
- Expo bug grabación en background: https://github.com/expo/expo/issues/46731
- Expo FCM v1 credentials: https://docs.expo.dev/push-notifications/fcm-credentials.md
- `expo-notifications` exact alarm (source): `withNotificationsAndroid.ts`, `ExpoSchedulingDelegate.kt` (repo expo/expo) · https://developer.android.com/reference/android/app/AlarmManager#canScheduleExactAlarms()
- Android — Background work / Foreground services: https://developer.android.com/develop/background-work/services
- Android — FGS types: https://developer.android.com/develop/background-work/services/fgs/service-types
- Android — Restricciones de arranque de FGS desde background: https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- React Native — Headless JS: https://reactnative.dev/docs/headless-js-android
- `react-native-background-actions` (sin wake lock, legacy, New Arch issue #249): https://github.com/Rapsssito/react-native-background-actions
- Expo SDK 57 changelog (New Architecture default): https://staging.expo.dev/changelog/sdk-57

---

## 9. Cómo reproducir / verificar (para el revisor)

1. **Instalar el APK de release** en un Android 12+ real (el APK local no tiene FCM):
   - Iniciar bloque de enfoque de 1 min → **bloquear la pantalla** → ver si el aviso llega **a horario**.
   - Iniciar sesión/registro → revisar a qué host apunta el link del email.
2. **Logcat filtrado** mientras se apaga la pantalla:
   `adb logcat | Select-String -Pattern "BackgroundActions|ExpoScheduling|ExpoSensors|AudioRecorder"`
   - Buscar si `RNBackgroundActionsTask` arranca, si los sensores dejan de emitir y si el recorder pausa.
3. **Probar push remoto:** intentar `getExpoPushTokenAsync` en el APK de release → esperado: falla por falta de FCM v1.
4. **Comprobar config de Supabase:** Dashboard → Authentication → URL Configuration (Site URL / Redirect URLs).
5. **`adb shell dumpsys alarm | Select-String ergofocus`** tras programar el fin de bloque → ver si la alarma es exacta o `setAndAllowWhileIdle`.

---

*Fin del documento. Diseñado para revisión por otra IA: cada hallazgo está atado a evidencia y a una causa raíz verificable.*
