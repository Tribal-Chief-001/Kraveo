package site.kraveo.driver

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    // The geolocator plugin shows its "on duty" foreground-service notification on a channel with
    // this id and creates it with importance NONE (which Android may hide). Creating it here
    // first with LOW importance (visible in the shade, silent) is a best effort: Android lets an
    // app lower a channel it created, so whether the plugin's later NONE request wins is NOT
    // verified on a device. If the plugin renames the channel this is simply unused.
    private val dutyChannelId = "geolocator_channel_01"

    private fun ensureDutyChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val manager = getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(dutyChannelId) == null) {
                val channel = NotificationChannel(dutyChannelId, "On duty - location sharing", NotificationManager.IMPORTANCE_LOW)
                channel.description = "Shown while you are on duty and Kraveo is sharing your location."
                channel.setShowBadge(false)
                manager.createNotificationChannel(channel)
            }
        } catch (e: Exception) {
            // Never let a notification channel problem stop the app from starting.
        }
    }

    @Suppress("DEPRECATION")
    private fun mapsAvailable(): Boolean {
        return try {
            val info = packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
            val key = info.metaData?.getString("com.google.android.geo.API_KEY")
            if (key.isNullOrBlank()) {
                false
            } else {
                packageManager.getPackageInfo("com.google.android.gms", 0)
                true
            }
        } catch (e: Exception) {
            false
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        ensureDutyChannel()
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "site.kraveo.driver/system")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    // True only when this build carries a Maps key (see MAPS_API_KEY in build.gradle.kts)
                    // and Google Play services are installed; otherwise the app shows its plain card.
                    "mapsAvailable" -> result.success(mapsAvailable())
                    else -> result.notImplemented()
                }
            }
    }
}
