# ErgoFocus

Plataforma de telemetría ambiental y ergonomía de precisión para trabajo digital y bienestar.

App móvil construida con **Expo SDK 57** + **React Native 0.86** + **NativeWind 4.2.7** (Tailwind CSS).

## Requisitos

- Node.js 20+
- Credenciales de Supabase en `.env` (ver `.env.example`): `EXPO_PUBLIC_SUPABASE_URL` y `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (o `EXPO_PUBLIC_SUPABASE_ANON_KEY`)
- **Development build** (no Expo Go): las funciones nativas (`expo-sensors`, `expo-notifications`, `expo-audio`, `expo-sqlite`) requieren un build propio.

## Correr localmente

1. Copiar `.env.example` a `.env` y completar las credenciales de Supabase.
2. Instalar dependencias:
   ```bash
   npm install
   ```
3. Compilar el development build (una vez):
   ```bash
   npx expo prebuild
   npx expo run:android
   ```
   o con EAS: `eas build --platform android --profile development`
4. Levantar Metro y desarrollar:
   ```bash
   npm start
   ```

Otros scripts: `npm run android`, `npm run ios`, `npm run web`, `npm run lint` (typecheck).

## Sensores (obligatorios)

Los cuatro sensores del requerimiento se leen en tiempo real con `expo-sensors` y `expo-audio`:

| Sensor | Fuente | Disponibilidad |
|---|---|---|
| Luz (lux) | `LightSensor` | Solo Android; en iOS se muestra "no disponible" |
| Ruido (dB aproximado) | micrófono con metering (`expo-audio`) | iOS/Android, procesado solo en el dispositivo |
| Giroscopio (manipulación y vibración) | `Gyroscope` | iOS/Android |
| Sedentarismo | `Accelerometer` | iOS/Android (detección en primer plano) |

Cada sensor verifica `isAvailableAsync()` y avisa si el hardware no lo soporta. El ruido se mide
bajo demanda desde la pestaña Ambiente. Las lecturas se guardan en SQLite (tabla `sensor_logs`)
cada 5 minutos y alimentan la pestaña Tendencias y el historial premium de la pestaña Perfil (PDF).

El giroscopio calcula la tasa de rotación (magnitud de la velocidad angular) y, con una ventana
deslizante de muestras, distingue dos escenarios: **manipulación** (se tomó el celular, momento
angular alto) y **vibración de mesa** (oscilación fina con el teléfono apoyado). Durante el Modo
Enfoque del dashboard, cada manipulación detectada se cuenta como **distracción** y se muestra el
aviso en la tarjeta ("una distracción" o "varias distracciones").

## Notificaciones

- `expo-notifications` con notificaciones **locales** que llegan apenas un sensor supera su límite
  recomendado (iluminación fuera de 300-500 lux, ruido >= 70 dB, sedenterismo de 1 h) y un
  recordatorio de descanso cada hora. Cada aviso usa un **canal de Android de alta prioridad** y
  antes de cada envío se verifica/pide el permiso del sistema (Android 13+), mostrando un aviso
  dentro de la app si el permiso está denegado.
- **Distracción en el bloque**: si el giroscopio detecta que se tomó el teléfono durante una
  sesión de enfoque, se muestra el aviso en la tarjeta y se envía una notificación local.
- **Fin de bloque (segundo plano)**: al iniciar un bloque de concentración se **agenda una
  notificación local con fecha exacta** (canal de alta prioridad); el SO la muestra aunque la app
  esté en segundo plano o cerrada. Al pausar o reiniciar el bloque se cancela y reprograma.
- **Push remoto** vía Expo Push API: de forma complementaria, al terminar el bloque se invoca la
  Edge Function `send-push` (recibe el token del dispositivo o lo busca en `push_tokens`) para
  entregar la notificación real desde el servidor cuando está desplegado.

## Pagos (Stripe) y cuenta

- **Checkout Pro**: la Edge Function `checkout` crea una sesión de Stripe y devuelve la URL; el
  botón "Mejorar a Pro" del dashboard (y de la pestaña Perfil) la abre en el navegador.
- **Historial PDF (Pro)**: la pestaña **Perfil** muestra el historial de datos recopilados por
  día, semana, mes y año con promedio por sensor, y permite exportarlo a **PDF** (generado 100 %
  en el dispositivo con `expo-print` + `expo-sharing`, sin servidor). Solo es visible cuando la
  cuenta tiene `role = 'pro'`; los usuarios free ven el bloqueo con el botón de upgrade.
- **Webhook**: `stripe-webhook` (con firma verificada) marca `role = 'pro'` en la tabla
  `profiles` al completar el pago y vuelve `'free'` al cancelar la suscripción.
- **Eliminar cuenta**: la Edge Function `delete-account` borra el usuario con `service_role`;
  la app limpia además los registros locales de `sensor_logs`.

### Despliegue de Supabase

1. Aplicar la migración y desplegar las funciones:
   ```bash
   supabase db push
   supabase functions deploy checkout --no-verify-jwt
   supabase functions deploy stripe-webhook --no-verify-jwt
   supabase functions deploy delete-account
   supabase functions deploy send-push --no-verify-jwt
   ```
2. Cargar los secretos:
   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_... STRIPE_PRICE_ID=price_... STRIPE_WEBHOOK_SECRET=whsec_... APP_RETURN_SCHEME=ergofocus
   ```
3. En Stripe Dashboard crear el webhook apuntando a
   `https://<ref>.supabase.co/functions/v1/stripe-webhook` con los eventos
   `checkout.session.completed` y `customer.subscription.deleted`.

## Datos

- **Supabase**: login (email + contraseña), perfil con rol Pro, tokens push. Nunca recibe las
  lecturas de sensores.
- **SQLite local** (`src/db/`): única fuente de verdad del historial de `sensor_logs`, con
  `user_id` por fila.
- Formato de fila compatible con una futura tabla Supabase `sensor_logs`
  (`user_id`, `sensor`, `value`, `created_at`): las lecturas se siguen guardando localmente y un
  sync futuro puede subirlas igual que se hace con `push_tokens`.
- El usuario de la app se fuerza a `dev-user-local-123` (modo desarrollo); las Edge Functions
  de pago y borrado de cuenta se asocian al usuario autenticado de Supabase.

## Estructura

```
index.ts                # registro + import de global.css (NativeWind)
global.css              # directivas Tailwind
tailwind.config.js      # preset nativewind + familias Plus Jakarta Sans
src/
  App.tsx               # gate de auth, tabs, sensores, alertas y persistencia
  types.ts              # tipos compartidos (readings de sensores)
  lib/supabase.ts       # cliente condicional con validación defensiva
  lib/billing.ts        # rol Pro, checkout de Stripe y borrado de cuenta
  auth/AuthContext.tsx  # sesión, signIn/signUp/resetPassword
  screens/LoginScreen.tsx
  sensors/useSensors.ts # hook de LightSensor, Gyroscope y Accelerometer
  notifications.ts      # alertas locales (useHealthAlerts) y registro push
  db/                   # schema + queries SQLite de sensor_logs
  utils/audio.ts        # campanadas vía expo-audio (WAVs sintetizados)
  components/           # TopBar, BottomNav, tabs, Gradient, etc.
assets/sounds/          # WAVs generados por scripts/generate-sounds.mjs
scripts/                # generación de sonidos
supabase/
  functions/            # checkout, stripe-webhook, delete-account, send-push
  migrations/           # profiles + push_tokens
```

## Notas de la migración (postura → sensores)

- Se eliminó la detección postural con cámara (MediaPipe), el mapa de molestias corporales, las
  insignias/rachas, las micro-pausas guiadas, el temporizador 20-20-20 y el modo de pie.
- El slider manual de lux y la tarjeta de temperatura/humedad/CO2 se reemplazaron por las
  lecturas reales de los sensores.
- La pestaña Tendencias muestra promedios diarios reales de los 4 sensores.