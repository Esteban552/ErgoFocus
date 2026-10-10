# ErgoFocus — Cambios de la sesión (08/10/2026)

> **Documento histórico:** el enfoque con `react-native-background-actions` fue reemplazado el
> 09/10/2026 por un servicio Android nativo. Ver
> `docs/CORRECCIONES_IMPLEMENTADAS_2026-10-09.md`.

Resumen de todo lo modificado en esta sesión, con la causa de cada problema.

## 1. Registro / login real

- **Problema:** `src/App.tsx` usaba un usuario falso (`dev-user-local-123`), así que nunca se
  mostraba `LoginScreen` (que ya incluye "Crear Cuenta"). Sin sesión real, tampoco funcionaba el
  pago.
- **Cambio:** `MainApp` usa `userId` de `useAuth()`. Sin sesión se muestra login/registro. Los
  efectos de sync, push y persistencia de sensores solo corren con usuario.
- **Nota:** si Supabase exige confirmar el email, el usuario debe confirmarlo antes de entrar.

## 2. Pago Premium (Stripe)

- Las Edge Functions `checkout`, `stripe-webhook` y `delete-account` ya estaban desplegadas.
  El flujo se desbloquea al usar login real.
- `src/lib/billing.ts`: `startCheckout()` devuelve `{ ok, url } | { ok, message }` con el error real
  del servidor (antes un mensaje genérico). `deleteAccount()` ahora lanza error si falla.
- `ProfileTab` y `DashboardTab` muestran ese mensaje de error.
- **Requisito externo:** secretos `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` y `STRIPE_WEBHOOK_SECRET`
  cargados en Supabase (no verificados desde el código).

## 3. "Eliminar cuenta" movido a Perfil

- Se eliminó de `DashboardTab`; ahora está en la tarjeta "Mi cuenta" de `ProfileTab`.
- Si el borrado remoto falla ya no se cierra la sesión.

## 4. Acelerómetro (no cambiaba a "En movimiento")

- **Causa:** `expo-sensors` entrega valores en **g** (~1.0 en reposo) pero el umbral estaba en
  m/s² (0.6): hacía falta una sacudida de 0.6 g.
- **Cambio** (`src/sensors/useSensors.ts`): `MOVEMENT_DEVIATION = 0.05` g, nuevo
  `MOVEMENT_JERK = 0.04` g (cambio entre muestras), muestreo cada 200 ms y reinicio del contador de
  sedentarismo mientras haya movimiento sostenido.
- Ajuste fino: esas dos constantes al inicio del archivo.

## 5. Notificaciones en segundo plano / teléfono bloqueado

Dos capas:

### 5.1 Notificaciones programadas por el SO (`src/notifications.ts`)
- **Descanso cada hora:** notificación repetida (`TIME_INTERVAL`, `repeats: true`).
- **Sedentarismo:** agendada a (último movimiento + 1 h) y reprogramada con cada movimiento.
- `useHealthAlerts` recibe `sedentarySeconds` y `enabled` (solo con sesión); al cerrar sesión se
  cancelan. Luz y ruido siguen siendo avisos inmediatos.

### 5.2 Servicio en primer plano de Android (monitoreo en segundo plano)
- **Por qué:** luz y ruido necesitan lecturas en vivo; Android suspende el código de la app al
  bloquear el teléfono. Un servicio en primer plano mantiene vivo el proceso (sensores,
  micrófono y temporizadores).
- **Dependencia nueva:** `react-native-background-actions@4.1.0`.
- `src/background/monitoring.ts`: hook `useBackgroundMonitoring(active)`; pide permisos de
  micrófono y notificaciones, inicia/detiene el servicio y persiste la preferencia
  (`AsyncStorage`, clave `ergofocus:background-monitoring`). Se reactiva al abrir la app con sesión.
- `plugins/withBackgroundMonitoring.js` (config plugin): declara el servicio
  `RNBackgroundActionsTask` con `foregroundServiceType="microphone"`.
- `app.json`: plugin + permisos `FOREGROUND_SERVICE_MICROPHONE` y `POST_NOTIFICATIONS`.
- `ProfileTab`: interruptor "Monitoreo en segundo plano".
- `App.tsx`: `AmbientTab` queda siempre montado (oculto fuera de su pestaña) para que el medidor
  de micrófono no se corte al cambiar de pestaña.

**Cómo usarlo:** (1) reconstruir la app nativa (`npm run android` o build EAS), porque cambió el
manifest; (2) Perfil → activar "Monitoreo en segundo plano"; (3) en la pestaña de sensores iniciar
el micrófono una vez.

**Costos conocidos:** notificación permanente visible, mayor consumo de batería, y la política de
Google Play exige justificar el permiso de micrófono en primer plano. Solo Android; en iOS no aplica.

## 6. Archivos tocados

| Archivo | Cambio |
|---|---|
| `src/App.tsx` | Auth real, hooks de alertas y monitoreo, `AmbientTab` siempre montado |
| `src/lib/billing.ts` | Errores reales en checkout y borrado |
| `src/components/ProfileTab.tsx` | Eliminar cuenta, interruptor de monitoreo, checkout |
| `src/components/DashboardTab.tsx` | Se quitó eliminar cuenta; checkout con nuevo tipo |
| `src/sensors/useSensors.ts` | Acelerómetro en g, jerk, muestreo 200 ms |
| `src/notifications.ts` | Notificaciones programadas por el SO |
| `src/background/monitoring.ts` | Nuevo: servicio en primer plano |
| `plugins/withBackgroundMonitoring.js` | Nuevo: config plugin del manifest |
| `app.json`, `package.json` | Plugin, permisos y dependencia |

## 7. Limitaciones pendientes

- Verificado solo con `tsc --noEmit` y `expo prebuild`; **falta probar en un teléfono real**
  (acelerómetro, pago de extremo a extremo, servicio con pantalla bloqueada).
- Si la app se cierra por completo (deslizada de recientes), el servicio y las alertas de luz/ruido
  se detienen; las notificaciones programadas del SO sí persisten.
- Algunos fabricantes (Xiaomi, Huawei, Samsung) matan servicios agresivamente: puede hacer falta
  excluir la app de la optimización de batería.

## 8. Notificaciones push, confirmación de correo y Soft Delete

### 8.1 Notificaciones Push en segundo plano
- **Problema previo:** En Android 8+, las notificaciones en segundo plano eran descartadas porque el payload de `send-push` no incluía `channelId` ni `priority`. Además, el fallback de `getProjectId()` tenía un ID desfasado.
- **Solución implementada:**
  - `supabase/functions/send-push/index.ts`: Envía `channelId: 'ergofocus-alerts'` (o el canal solicitado), `priority: 'high'` y `_displayInForeground: true`.
  - `src/notifications.ts`: Se registran con `AndroidImportance.MAX` tanto el canal `ergofocus-alerts` como `default` (con vibración y sonido). Se corrigió el ID del proyecto EAS a `eb0c8cf1-1157-4ebd-81cd-171b8b87dadb`.
  - *Nota sobre compilaciones APK/AAB:* Para recibir push remotos en segundo plano en Android fuera de Expo Go, es indispensable vincular las credenciales de **FCM v1** (Firebase Cloud Messaging) en EAS Dashboard o proveer `google-services.json`.

### 8.2 Confirmación de correo sin error de `localhost:3000`
- **Problema previo:** `supabase.auth.signUp()` no especificaba `emailRedirectTo`. Por defecto, Supabase Auth redirige al **Site URL** del proyecto (`http://localhost:3000`), produciendo `ERR_CONNECTION_REFUSED` al pulsar el enlace desde el móvil.
- **Solución implementada:**
  - `src/auth/AuthContext.tsx`: `signUp()` y `resetPassword()` envían `emailRedirectTo: 'ergofocus://auth-callback'`.
  - Se agregó listener de deep links con `Linking` en `AuthProvider` para procesar tokens de hash (`#access_token=...`) y códigos PKCE (`?code=...`) e iniciar la sesión automáticamente al abrir la app desde el correo.
  - *Configuración en Supabase Dashboard:* En **Authentication -> URL Configuration**, agregar `ergofocus://**` en **Redirect URLs**.

### 8.3 Eliminación de cuenta como Soft Delete
- **Problema previo:** `delete-account` ejecutaba `admin.auth.admin.deleteUser(user.id)`, un hard delete que borraba físicamente al usuario y destruía datos en cascada.
- **Solución implementada:**
  - `supabase/migrations/20261009000000_soft_delete.sql` y `db.sql`: Se añadió la columna `deleted_at timestamptz default null` e índice condicional a `public.profiles`.
  - Se actualizaron las políticas RLS de `profiles` y `sensor_daily` para excluir filas pertenecientes a cuentas con `deleted_at IS NOT NULL`.
  - `supabase/functions/delete-account/index.ts`: Marca `deleted_at = now()` en `profiles`, elimina los tokens push en `push_tokens`, marca `app_metadata.deleted = true` y revoca las sesiones activas en Auth.
  - `src/auth/AuthContext.tsx` y `src/lib/billing.ts`: Validan `deleted_at` / `app_metadata.deleted` al iniciar sesión o restaurar token. Si la cuenta está eliminada, se bloquea el acceso y se cierra la sesión con un mensaje informativo.
