package com.ergofocus.background

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ErgoFocusBackgroundMonitoringModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ErgoFocusBackgroundMonitoring")

    AsyncFunction("startAsync") {
      val context = requireNotNull(appContext.reactContext)
      val intent = Intent(context, BackgroundMonitoringService::class.java).apply {
        action = BackgroundMonitoringService.ACTION_START
      }
      ContextCompat.startForegroundService(context, intent)
    }

    AsyncFunction("stopAsync") {
      val context = requireNotNull(appContext.reactContext)
      context.stopService(Intent(context, BackgroundMonitoringService::class.java))
    }

    AsyncFunction("isRunningAsync") {
      BackgroundMonitoringService.isRunning
    }

    AsyncFunction("getSnapshotAsync") {
      val context = requireNotNull(appContext.reactContext)
      val preferences = context.getSharedPreferences(
        BackgroundMonitoringService.PREFERENCES_NAME,
        Context.MODE_PRIVATE
      )
      mapOf(
        "running" to BackgroundMonitoringService.isRunning,
        "lux" to nullableFloat(preferences, "lux"),
        "decibels" to nullableFloat(preferences, "decibels"),
        "accelerationMagnitude" to nullableFloat(preferences, "accelerationMagnitude"),
        "rotationSpeed" to nullableFloat(preferences, "rotationSpeed"),
        "lastMovementAt" to preferences.getLong("lastMovementAt", 0L),
        "microphoneAvailable" to preferences.getBoolean("microphoneAvailable", false),
        "lightAvailable" to preferences.getBoolean("lightAvailable", false),
        "movementAvailable" to preferences.getBoolean("movementAvailable", false),
        "gyroAvailable" to preferences.getBoolean("gyroAvailable", false),
        "lightWakeUp" to preferences.getBoolean("lightWakeUp", false),
        "movementWakeUp" to preferences.getBoolean("movementWakeUp", false),
        "gyroWakeUp" to preferences.getBoolean("gyroWakeUp", false),
        "error" to preferences.getString("error", null)
      )
    }

    AsyncFunction("canScheduleExactAlarmsAsync") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        true
      } else {
        val context = requireNotNull(appContext.reactContext)
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarms.canScheduleExactAlarms()
      }
    }

    AsyncFunction("openExactAlarmSettingsAsync") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val context = requireNotNull(appContext.reactContext)
        val intent = Intent(
          Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
          Uri.parse("package:${context.packageName}")
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
      }
    }
  }

  private fun nullableFloat(preferences: android.content.SharedPreferences, key: String): Double? {
    return if (preferences.contains(key)) preferences.getFloat(key, 0f).toDouble() else null
  }
}
