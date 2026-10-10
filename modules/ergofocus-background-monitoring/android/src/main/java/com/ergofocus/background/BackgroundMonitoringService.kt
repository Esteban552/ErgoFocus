package com.ergofocus.background

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.roundToInt
import kotlin.math.sqrt

class BackgroundMonitoringService : Service(), SensorEventListener {
  companion object {
    const val ACTION_START = "com.ergofocus.background.START"
    const val PREFERENCES_NAME = "ergofocus_background_snapshot"

    @Volatile
    var isRunning = false
      private set

    private const val SERVICE_NOTIFICATION_ID = 4100
    private const val ALERT_NOTIFICATION_BASE_ID = 4200
    private const val SERVICE_CHANNEL_ID = "ergofocus-monitoring"
    private const val ALERT_CHANNEL_ID = "ergofocus-alerts"
    private const val SAMPLE_RATE = 16_000
    private const val MOVEMENT_DEVIATION = 0.05f
    private const val MOVEMENT_JERK = 0.04f
    private const val BREAK_INTERVAL_MS = 60L * 60L * 1000L
    private const val WAKE_LOCK_TIMEOUT_MS = 10L * 60L * 1000L
    private const val SNAPSHOT_INTERVAL_MS = 1_000L
  }

  private lateinit var sensors: SensorManager
  private lateinit var notifications: NotificationManager
  private lateinit var wakeLock: PowerManager.WakeLock
  private val audioRunning = AtomicBoolean(false)
  private val audioSession = AtomicInteger(0)
  private var audioRecord: AudioRecord? = null
  private var baseline: Float? = null
  private var previousMagnitude: Float? = null
  private var lastMovementAt = 0L
  private var lastBreakAt = 0L
  private var lightWarned = false
  private var noiseWarned = false
  private var lastSnapshotAt = 0L
  private var latestLux: Float? = null
  private var latestDecibels: Float? = null
  private var latestAcceleration: Float? = null
  private var latestRotation: Float? = null

  override fun onCreate() {
    super.onCreate()
    sensors = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    notifications = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    createNotificationChannels()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action != ACTION_START) return START_NOT_STICKY

    try {
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      } else {
        0
      }
      ServiceCompat.startForeground(
        this,
        SERVICE_NOTIFICATION_ID,
        buildServiceNotification(),
        type
      )
    } catch (error: Throwable) {
      setMonitoringError(error.message ?: "Android no permitió iniciar el servicio de monitoreo.")
      stopSelf()
      return START_NOT_STICKY
    }

    if (!isRunning) {
      isRunning = true
      getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
        .edit()
        .remove("error")
        .apply()
      acquireWakeLock()
      registerSensors()
      startMicrophone()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    isRunning = false
    sensors.unregisterListener(this)
    stopMicrophone()
    if (::wakeLock.isInitialized && wakeLock.isHeld) wakeLock.release()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  override fun onSensorChanged(event: SensorEvent) {
    when (event.sensor.type) {
      Sensor.TYPE_LIGHT -> handleLight(event.values[0])
      Sensor.TYPE_ACCELEROMETER -> handleAcceleration(event.values)
      Sensor.TYPE_GYROSCOPE -> handleGyroscope(event.values)
    }
  }

  private fun acquireWakeLock() {
    if (!::wakeLock.isInitialized) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "ErgoFocus::BackgroundMonitoring"
      ).apply {
        setReferenceCounted(false)
      }
    }
    if (!wakeLock.isHeld) wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS)
  }

  private fun registerSensors() {
    val preferences = getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
    val light = sensors.getDefaultSensor(Sensor.TYPE_LIGHT)
    val accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    val gyroscope = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

    light?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
    accelerometer?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
    gyroscope?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }

    lastMovementAt = preferences.getLong("lastMovementAt", System.currentTimeMillis())
    lastBreakAt = System.currentTimeMillis()
    preferences.edit()
      .putBoolean("lightAvailable", light != null)
      .putBoolean("movementAvailable", accelerometer != null)
      .putBoolean("gyroAvailable", gyroscope != null)
      .putBoolean("lightWakeUp", light?.isWakeUpSensor == true)
      .putBoolean("movementWakeUp", accelerometer?.isWakeUpSensor == true)
      .putBoolean("gyroWakeUp", gyroscope?.isWakeUpSensor == true)
      .putLong("lastMovementAt", lastMovementAt)
      .apply()
  }

  private fun handleLight(lux: Float) {
    latestLux = lux
    persistSnapshot()
    val outOfRange = lux < 300f || lux > 500f
    if (outOfRange && !lightWarned) {
      lightWarned = true
      showAlert(
        1,
        "Iluminación fuera de rango",
        "La luz recomendada es entre 300 y 500 lux. Ajustá tu iluminación."
      )
    } else if (!outOfRange) {
      lightWarned = false
    }
  }

  private fun handleAcceleration(values: FloatArray) {
    val gravity = SensorManager.GRAVITY_EARTH
    val magnitude = sqrt(values[0] * values[0] + values[1] * values[1] + values[2] * values[2]) / gravity
    val currentBaseline = baseline
    if (currentBaseline == null) {
      baseline = magnitude
      previousMagnitude = magnitude
      return
    }

    val jerk = abs(magnitude - (previousMagnitude ?: magnitude))
    previousMagnitude = magnitude
    val moved = abs(magnitude - currentBaseline) > MOVEMENT_DEVIATION || jerk > MOVEMENT_JERK
    val now = System.currentTimeMillis()
    if (moved) {
      lastMovementAt = now
      baseline = currentBaseline * 0.98f + magnitude * 0.02f
    }

    if (now - lastBreakAt >= BREAK_INTERVAL_MS) {
      val sedentary = now - lastMovementAt >= BREAK_INTERVAL_MS
      lastBreakAt = now
      showAlert(
        3,
        if (sedentary) "Sedentarismo detectado" else "Momento de descansar",
        if (sedentary) {
          "Llevás una hora sin moverte. Levantate y descansá la vista."
        } else {
          "Llevás una hora de trabajo. Hacé una pausa breve y descansá la vista."
        }
      )
    }

    latestAcceleration = magnitude
    persistSnapshot()
  }

  private fun handleGyroscope(values: FloatArray) {
    val magnitude = sqrt(values[0] * values[0] + values[1] * values[1] + values[2] * values[2])
    latestRotation = magnitude
    persistSnapshot()
  }

  private fun startMicrophone() {
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      setMonitoringError("No se otorgó permiso para medir el ruido en segundo plano.")
      return
    }

    val minimum = AudioRecord.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    if (minimum <= 0) {
      setMonitoringError("El micrófono no admite la medición en segundo plano.")
      return
    }

    try {
      val recorder = createAudioRecorder(minimum)
      if (recorder == null) {
        setMonitoringError("No se pudo inicializar el micrófono en segundo plano.")
        return
      }

      audioRecord = recorder
      audioRunning.set(true)
      val session = audioSession.incrementAndGet()
      recorder.startRecording()
      getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE).edit()
        .putBoolean("microphoneAvailable", true)
        .apply()

      thread(name = "ErgoFocusAudioMonitor") {
        val buffer = ShortArray(minimum)
        while (audioRunning.get() && audioSession.get() == session) {
          val count = recorder.read(buffer, 0, buffer.size)
          if (count <= 0) continue
          var sum = 0.0
          for (index in 0 until count) {
            val sample = buffer[index].toDouble()
            sum += sample * sample
          }
          val rms = sqrt(sum / count).coerceAtLeast(1.0)
          val estimated = (20.0 * log10(rms / Short.MAX_VALUE) + 100.0)
            .coerceIn(0.0, 100.0)
            .roundToInt()
            .toFloat()
          latestDecibels = estimated
          persistSnapshot()

          val tooLoud = estimated >= 70f
          if (tooLoud && !noiseWarned) {
            noiseWarned = true
            showAlert(
              2,
              "Ruido por encima del límite",
              "El ambiente superó los 70 dB estimados. Considerá alejarte del ruido."
            )
          } else if (!tooLoud) {
            noiseWarned = false
          }
        }
      }
    } catch (error: Throwable) {
      audioRunning.set(false)
      audioSession.incrementAndGet()
      try {
        audioRecord?.stop()
      } catch (_: Throwable) {
      }
      audioRecord?.release()
      audioRecord = null
      setMonitoringError(error.message ?: "No se pudo iniciar el micrófono en segundo plano.")
    }
  }

  private fun createAudioRecorder(bufferSize: Int): AudioRecord? {
    val sources = intArrayOf(
      MediaRecorder.AudioSource.UNPROCESSED,
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      MediaRecorder.AudioSource.MIC
    )
    for (source in sources) {
      try {
        val recorder = AudioRecord(
          source,
          SAMPLE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          bufferSize * 2
        )
        if (recorder.state == AudioRecord.STATE_INITIALIZED) return recorder
        recorder.release()
      } catch (_: Throwable) {
      }
    }
    return null
  }

  private fun stopMicrophone() {
    audioRunning.set(false)
    audioSession.incrementAndGet()
    try {
      audioRecord?.stop()
    } catch (_: Throwable) {
    }
    audioRecord?.release()
    audioRecord = null
    getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE).edit()
      .putBoolean("microphoneAvailable", false)
      .apply()
  }

  @Synchronized
  private fun persistSnapshot() {
    val now = System.currentTimeMillis()
    if (now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return
    lastSnapshotAt = now
    acquireWakeLock()
    val editor = getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE).edit()
      .putLong("lastMovementAt", lastMovementAt)
    latestLux?.let { editor.putFloat("lux", it) }
    latestDecibels?.let { editor.putFloat("decibels", it) }
    latestAcceleration?.let { editor.putFloat("accelerationMagnitude", it) }
    latestRotation?.let { editor.putFloat("rotationSpeed", it) }
    editor.apply()
  }

  private fun setMonitoringError(message: String) {
    getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE).edit()
      .putBoolean("microphoneAvailable", false)
      .putString("error", message)
      .apply()
  }

  private fun createNotificationChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    notifications.createNotificationChannel(
      NotificationChannel(
        SERVICE_CHANNEL_ID,
        "Monitoreo ErgoFocus",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Mantiene activos los sensores y el micrófono."
        setShowBadge(false)
      }
    )
    notifications.createNotificationChannel(
      NotificationChannel(
        ALERT_CHANNEL_ID,
        "Alertas ErgoFocus",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        enableVibration(true)
      }
    )
  }

  private fun buildServiceNotification() = NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
    .setSmallIcon(notificationIcon())
    .setContentTitle("ErgoFocus está monitoreando")
    .setContentText("Midiendo luz, ruido y movimiento con la pantalla apagada.")
    .setContentIntent(openAppIntent())
    .setOngoing(true)
    .setOnlyAlertOnce(true)
    .setCategory(NotificationCompat.CATEGORY_SERVICE)
    .build()

  private fun showAlert(offset: Int, title: String, body: String) {
    val notification = NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
      .setSmallIcon(notificationIcon())
      .setContentTitle(title)
      .setContentText(body)
      .setContentIntent(openAppIntent())
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setDefaults(NotificationCompat.DEFAULT_ALL)
      .build()
    notifications.notify(ALERT_NOTIFICATION_BASE_ID + offset, notification)
  }

  private fun openAppIntent(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(
      this,
      0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun notificationIcon(): Int {
    val configured = resources.getIdentifier("notification_icon", "drawable", packageName)
    return if (configured != 0) configured else applicationInfo.icon
  }
}
