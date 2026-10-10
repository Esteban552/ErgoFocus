# ErgoFocus — Documentación de cambios y estado

> **Fecha:** 08/10/2026
> **Qué es este documento:** explica de forma simple qué se cambió en la app,
> qué partes ya están listas para funcionar conectadas a Supabase y qué límite
> tienen todavía las notificaciones push.

> **Actualización 08/10/2026 (sesión posterior):** el usuario ficticio `dev-user-local-123` ya
> fue eliminado (login real), el borrado de cuenta está en Perfil y existe monitoreo en segundo
> plano. Detalle en `docs/CAMBIOS_SESION_2026-10-08.md`; ese archivo prevalece sobre las
> secciones 4.3 y 5 de este documento.

> **Actualización 09/10/2026:** se implementó el ciclo completo de la suscripción Pro, incluida la
> cancelación de la renovación con acceso hasta el final del período pagado. El detalle actualizado
> está en `docs/CORRECCIONES_IMPLEMENTADAS_2026-10-09.md` y prevalece sobre el estado anterior.

---

## 1. Resumen en 30 segundos

ErgoFocus es una app de bienestar laboral que usa **4 sensores** del teléfono
para cuidar la postura y la salud de quien trabaja sentado, con un **Modo
Enfoque** tipo pomodoro, avisos de salud, un **historial en PDF** exclusivo
para usuarios **Pro** y pago por **suscripción con Stripe**.

- Los **sensores** y el **historial** funcionan **100 % sin servidor**
  (se guardan en una base local SQLite).
- El **login**, el rol **Pro** y el **pago** necesitan Supabase y el Stripe
  desplegado. Ya está todo el código escrito y listo para conectar.

---

## 2. Cambios que se realizaron

### 2.1 Sensores (4, cumpliendo el requisito del examen)

| Sensor | Nombre en la app | Qué mide | Hardware |
|---|---|---|---|
| Luz | **Iluminación** | Confort visual del puesto (Lux) | `LightSensor` (solo Android) |
| Sonido | **Ruido** | Ambiente sonoro del espacio (dB) | Micrófono (`expo-audio`) |
| Movimiento | **Estabilidad** | Movimiento y firmeza del entorno | `Accelerometer` calibrado |
| Giroscopio | **Sedentarismo** | Tiempo sin movimiento activo | `Gyroscope` |

Cambios clave:

- **Se eliminó el barómetro** y se reemplazó por el **giroscopio**. Ahora el
  giroscopio detecta dos cosas durante el Modo Enfoque:
  - **Manipulación**: se tomó el celular (momento angular alto).
  - **Vibración de mesa**: oscilación fina con el teléfono apoyado.
- Se **ocultaron los nombres de hardware** (lux, dB, °/s, min) en las tarjetas
  y se usaron nombres fáciles de entender: Iluminación, Ruido, Estabilidad y
  Sedentarismo.
- El **acelerómetro se autocalibra**: toma 10 muestras al inicio (unos 5
  segundos) para no dar falsas alarmas de movimiento, y se recalibra solo con
  el tiempo.

### 2.2 Modo Enfoque

- Duración **personalizable**: presets de 15/25/45/60 minutos o valor libre
  entre 1 y 240 minutos.
- Al terminar el bloque, la app avisa con una notificación programada.
- Se reemplazaron las "penalizaciones" por un sistema de **distracciones**:
  si el giroscopio detecta que tomaste el celular durante un bloque, se cuenta
  una distracción y se muestra el aviso ("Una distracción" o "Varias
  distracciones").

### 2.3 Contador de sedentarismo

- Ahora se muestra en formato **minutos:segundos** (mm:ss).
- La barra de progreso avanza cada segundo real, no por "burbujas".

### 2.4 Notificaciones

- Se reescribió el sistema de notificaciones para que funcione de verdad en
  Android 13+ (permiso en tiempo real + canal de notificaciones propio).
- Se definen **alertas de salud** que se disparan cuando un sensor llega a su
  límite:
  - Iluminación fuera de 300–500 lux.
  - Ruido igual o mayor a 70 dB.
  - Una hora sin moverse (sedentarismo).
  - Recordatorio de descanso cada hora.
- Estas alertas se disparan por límite real del sensor (con "histéresis de
  borde": avisan una vez y no repiten hasta que el valor vuelva a estar bien).

### 2.5 Historial premium en PDF (nuevo)

- Se agregó una **pestaña "Perfil"** en el menú inferior.
- Dentro de esa pestaña, **solo los usuarios Pro** (que ya pagaron) ven el
  **historial de datos recopilados** filtrado por período:
  - **Día** (por hora)
  - **Semana** (por día)
  - **Mes** (por día)
  - **Año** (por mes)
- Tiene un botón **"Descargar PDF"** que genera el archivo **dentro del
  teléfono** (sin necesitar internet ni Supabase), usando `expo-print` +
  `expo-sharing`.
- Los usuarios **free NO ven la tabla ni los datos**: solo ven el aviso
  "Bloqueado · Mejorar a Pro".

### 2.6 Otros ajustes

- Se quitó del dashboard el texto que prometía "alertas avanzadas /
  notificaciones extendidas" en el plan Pro.
- Se corrigieron detalles de diseño (botón del micrófono, textos de estado,
  recorte de textos en los campos de duración).
- Base de datos local SQLite (tabla `sensor_logs`): los valores de los 4
  sensores se guardan cada 5 minutos y alimentan Tendencias y el historial
  PDF.

---

## 3. Lo que ya funciona sin Supabase (ahora mismo)

| Función | ¿Funciona ya? |
|---|---|
| Los 4 sensores (luz, ruido, estabilidad, sedentarismo) | ✅ Sí |
| Modo Enfoque con duración libre y distracciones | ✅ Sí |
| Alertas de salud por sensor (en primer plano) | ✅ Sí |
| Tendencias de los últimos 7 días | ✅ Sí |
| Historial Pro en PDF (Perfil) | 🟠 Sí, pero solo visible si el rol es Pro |
| Guardado local de datos (SQLite) | ✅ Sí |
| Notificaciones push reales | ❌ No todavía (ver sección 5) |

---

## 4. Lo que ya está listo para conectar con Supabase

> Toda la parte "de fábrica" está escrita. Solo falta **desplegarla** en tu
> proyecto Supabase y **completar los datos de Stripe**.

### 4.1 Lo que ya existe en el código (listo para usar)

| Pieza | Archivo / Lugar | Para qué sirve |
|---|---|---|
| Tabla `profiles` (rol free/pro) | `supabase/migrations/20261008000000_profiles_and_push.sql` | Guarda si el usuario es Free o Pro |
| Ciclo de suscripción | `supabase/migrations/20261009165845_subscription_lifecycle.sql` | Guarda suscripción, estado, vencimiento y cancelación programada |
| Tabla `push_tokens` | misma migración | Guarda el token del teléfono para push |
| Edge Function `checkout` | `supabase/functions/checkout/` | Crea la sesión de pago de Stripe |
| Edge Function `stripe-webhook` | `supabase/functions/stripe-webhook/` | Marca al usuario como Pro cuando paga |
| Edge Function `send-push` | `supabase/functions/send-push/` | Envía el push real desde el servidor |
| Edge Function `delete-account` | `supabase/functions/delete-account/` | Borra la cuenta al pedirlo el usuario |
| Pantalla de Login | `src/screens/LoginScreen.tsx` | Registro / inicio de sesión con Supabase |
| Botón "Mejorar a Pro" | Dashboard y pestaña Perfil | Abre el pago de Stripe |

### 4.2 Checklist para activar todo (paso a paso)

```bash
# 1) Aplicar la migración (crea las tablas profiles y push_tokens)
supabase db push

# 2) Desplegar las funciones de servidor
supabase functions deploy checkout
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy send-push
supabase functions deploy delete-account

# 3) Configurar los secretos (claves de Stripe + URL de la app)
supabase secrets set \
  STRIPE_SECRET_KEY=sk_... \
  STRIPE_PRICE_ID=price_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  APP_RETURN_SCHEME=ergofocus
```

Y en el **panel de Stripe**:

1. Crear el producto/suscripción **Pro** y copiar su `PRICE_ID`.
2. Crear un **webhook** que apunte a:
   `https://<tu-proyecto>.supabase.co/functions/v1/stripe-webhook`
3. Suscribirlo a los eventos `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated` y
   `customer.subscription.deleted`.
4. Copiar el "Signing secret" como `STRIPE_WEBHOOK_SECRET`.

Sólo `stripe-webhook` se despliega con `--no-verify-jwt`, porque Stripe no envía un JWT de
Supabase. `checkout`, `send-push` y `delete-account` deben conservar la verificación JWT.

### 4.3 Importante para que el pago funcione

- La función `checkout` **exige un usuario autenticado de verdad** con
  Supabase (si no, responde "401 No autorizado").
- La app usa login real de Supabase también en desarrollo; no existe un usuario ficticio.
- Al cancelar, Stripe configura `cancel_at_period_end=true`: el usuario conserva Pro hasta
  `subscription_current_period_end` y recién pasa a Free cuando termina el período pagado.

### 4.4 Dependencias nuevas instaladas

| Paquete | Para qué |
|---|---|
| `expo-print` | Generar el PDF del historial en el dispositivo |
| `expo-sharing` | Compartir / guardar el PDF generado |

---

## 5. ⚠️ Notificaciones push: todavía NO funcionan en segundo plano

Este es el límite más importante del estado actual.

### Qué significa en simple

**Cuando la app está en segundo plano o el teléfono está suspendido
(pantalla apagada), la app NO puede ejecutar su código.** Por eso:

| Situación | ¿Qué pasa? |
|---|---|
| App en segundo plano y el ruido sube a 70 dB | ❌ **No llega alerta** hasta volver a abrir la app |
| Una hora sentado, teléfono en la mesa | ❌ **No llega el aviso** de sedentarismo |
| Bloque de enfoque programado por el SO | ✅ **Sí llega** (lo programa el propio sistema operativo) |

### Por qué

1. **Las alertas de salud** se calculan con un temporizador interno de la app
   (`setInterval`). Si la app está suspendida, ese temporizador **se pausa**
   y no se ejecuta nada.
2. **El push remoto** (enviar desde el servidor de Supabase a tu teléfono)
   ya está escrito en el código, pero **aún no está desplegado ni probado
   en un teléfono real**, y necesita además que la app esté abierta para
   generar el token del dispositivo.

### Qué sí funciona en segundo plano hoy

- La **notificación local programada** del fin del Modo Enfoque (la agenda el
  sistema operativo con fecha exacta) se muestra aunque la app esté cerrada.

### Qué haría falta para que el push funcione de verdad

1. Desplegar la Edge Function `send-push` (paso 4.2).
2. Build propio de la app en un teléfono real (`npm run android`) — en
   "Expo Go" los push pueden no entregarse.
3. Que el reloj de alertas de salud pase a un **servicio en segundo plano**
   o que las alertas se envíen desde el **servidor** (todavía no implementado).

---

## 6. Estado final de cada requerimiento del examen

| Requisito | Estado |
|---|---|
| 4 sensores funcionando | ✅ Completado |
| Modo de enfoque con alertas | ✅ Completado |
| Pasarela de pago (Stripe) | 🟠 Código listo, falta desplegar |
| Notificaciones push | 🟠 Local en primer plano OK, push remoto pendiente de desplegar |
| Historial premium en PDF | ✅ Completado (local, gated por rol Pro) |
| Base de datos local de sensores | ✅ Completado (SQLite) |
