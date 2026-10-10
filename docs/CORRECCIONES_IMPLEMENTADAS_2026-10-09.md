# ErgoFocus — Correcciones implementadas (2026-10-09)

Este documento registra las correcciones aplicadas después del análisis de raíz de
`docs/ANALISIS_RAIZ_BACKGROUND_NOTIFICACIONES.md`.

## 1. Monitoreo nativo Android

Se reemplazó `react-native-background-actions` por un módulo Expo local:

- `modules/ergofocus-background-monitoring/`
- Foreground Service Android nativo con tipo `microphone`.
- `SensorManager` nativo para luz, acelerómetro y giroscopio.
- `AudioRecord` nativo para estimación de ruido.
- `PARTIAL_WAKE_LOCK` renovable para reducir la suspensión con pantalla apagada.
- Alertas nativas de luz, ruido y descanso/sedentarismo, independientes del runtime JS.
- Snapshot nativo para que la interfaz informe capacidades y errores reales.
- El servicio es `START_NOT_STICKY`: Android 14+ no permite prometer reinicio automático de un
  servicio de micrófono desde background.

Limitación honesta: un wake lock mantiene el CPU, pero algunos fabricantes desactivan sensores
no wake-up (especialmente el sensor de luz) con la pantalla apagada. La interfaz informa cuando el
acelerómetro no es wake-up. La validación final requiere dispositivo real.

## 2. Cronómetro y notificaciones

- La sesión de enfoque se persiste por usuario en AsyncStorage con un `endAt` absoluto.
- Cambiar de pestaña o recrear la pantalla ya no reinicia el bloque.
- La alarma se programa antes de activar visualmente el cronómetro.
- Se agregó cancelación por generación para impedir alarmas huérfanas si el usuario reinicia o
  pausa durante la solicitud de permisos.
- `scheduleLocalNotification()` devuelve éxito/fallo; si el SO no acepta la alarma, el bloque no
  se inicia silenciosamente.
- Se agregó `SCHEDULE_EXACT_ALARM` y acceso directo a la pantalla de permisos de Android 12+.
- Se quitó el push remoto tardío disparado por el `setInterval` del cliente. La alarma local del SO
  es la fuente de verdad para el final del bloque.
- Cuando el servicio nativo está activo, se cancelan los recordatorios JS de descanso/sedentarismo
  para evitar alertas duplicadas.

## 3. Cuenta, EAS y push remoto

- Se restauró el proyecto EAS real: `@elsupa/ergofocus`, ID
  `5c793a31-5b87-4729-a8f3-5da3d12fe273`.
- El registro de push ahora devuelve un resultado visible en Perfil en lugar de fallar en silencio.
- Se agregó `EXPO_PUBLIC_AUTH_REDIRECT_URL=ergofocus://auth-callback` a `.env.example`.

Pendiente externo obligatorio:

1. Supabase Dashboard → Authentication → URL Configuration:
   - quitar `localhost:3000` como Site URL productivo;
   - agregar `ergofocus://**` a Redirect URLs.
2. Configurar Firebase/FCM v1 y `google-services.json` para push remoto Android. Las alarmas locales
   no dependen de FCM.

## 4. Pago y actualización de interfaz

- Se eliminó el doble Alert que afirmaba pago exitoso antes de verificar.
- El retorno de Stripe muestra éxito sólo después de confirmar el rol Pro.
- La verificación manual ya no acepta coincidencias sólo por email: exige `user_id` y una
  suscripción Stripe en estado `active` o `trialing`.
- El webhook maneja también `customer.subscription.updated` y comprueba errores al actualizar
  `profiles`.
- El polling post-pago se amplió a 16 segundos y usa un mensaje de estado pendiente si Stripe aún
  no confirmó.
- El retorno de Checkout incluye `session_id`; el servidor verifica que esa sesión pertenece al
  usuario autenticado antes de reconciliar la suscripción.
- `profiles` conserva `stripe_subscription_id`, estado, fin del período y
  `cancel_at_period_end` mediante `20261009165845_subscription_lifecycle.sql`.
- Cancelar el plan sólo desactiva la renovación. El rol sigue siendo Pro durante el período pagado
  y cambia a Free cuando Stripe emite el cierre definitivo de la suscripción.
- Perfil muestra la próxima renovación o la fecha hasta la que se conserva Pro y permite cancelar
  la renovación con confirmación explícita.
- Los eventos inactivos atrasados de una suscripción anterior no pueden bajar a Free un perfil que
  ya apunta a otra suscripción activa.
- Las Edge Functions usan `stripe@19.2.0` y la API `2025-10-29.clover`, la misma versión del
  destino configurado en Stripe.

Pendiente externo: aplicar la migración, desplegar las Edge Functions actualizadas y configurar el
webhook con `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated` y `customer.subscription.deleted`.

## 5. Feedback y sincronización

- El error de cierre de sesión ahora se muestra al usuario.
- Los fallos de registro push se muestran en Perfil.
- El estado del servicio nativo diferencia inicio, ejecución y error real.
- La sincronización remota de `sensor_daily` sólo se intenta para usuarios Pro; los usuarios Free
  ya no generan rechazos RLS silenciosos.

## 6. Verificación ejecutada

- `npm run lint`: OK.
- `npx expo-doctor`: 21/21 checks OK.
- `npx expo config --type prebuild`: módulo local autolinkeado y permisos presentes.
- `deno check` sobre `checkout`, `stripe-webhook` y `delete-account`: OK.
- `npx expo export --platform android`: bundle Hermes generado correctamente.
- Proyecto EAS verificado con `eas project:info`.
- Build EAS preview de validación finalizado correctamente:
  `https://expo.dev/accounts/elsupa/projects/ergofocus/builds/91c69758-61d8-4ce2-8ef5-c5c1ef3a2a8a`
- APK de validación:
  `https://expo.dev/artifacts/eas/U5wL5TX_QFkQp7cQaL9SVh4Sh1jOT8Dh03Dz65Bk5JE.apk`
- Build EAS finalizado, que incluye el último ajuste de persistencia del cronómetro:
  `https://expo.dev/accounts/elsupa/projects/ergofocus/builds/df7dc712-5699-4dfc-b542-cd2990984bbc`
- APK final:
  `https://expo.dev/artifacts/eas/9P3oGedtrLXTSj3mqKaXAMc-HEYoK1Ok4HGuNMbeBbs.apk`

La compilación Gradle local no pudo ejecutarse porque la máquina tiene JDK pero no Android SDK.
EAS Build confirmó que el módulo local, su código Kotlin, el manifest y el autolinking compilan.

## 7. Bloqueos externos

- La CLI de Supabase responde HTTP 403 por privilegios insuficientes, por lo que no fue posible
  desplegar `checkout`/`stripe-webhook` desde esta sesión.
- Browser MCP no está conectado, por lo que no fue posible editar el panel de Supabase.
- El funcionamiento con pantalla apagada debe probarse en al menos Android stock y un fabricante
  agresivo (Samsung/Xiaomi) durante 60+ minutos.
