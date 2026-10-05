package site.kraveo.customer

import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
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
        // Lets the app send the student to this app's system notification settings when they
        // have turned notifications off (see lib/services/push/system_settings.dart).
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "site.kraveo.customer/system")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "openNotificationSettings" -> {
                        try {
                            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(intent)
                            result.success(true)
                        } catch (e: Exception) {
                            result.success(false)
                        }
                    }
                    // Android 13+ (API 33) shows a notification permission dialog; older versions have none.
                    "hasPermissionDialog" -> result.success(android.os.Build.VERSION.SDK_INT >= 33)
                    // True only when this build carries a Maps key (see MAPS_API_KEY in build.gradle.kts)
                    // and Google Play services are installed; otherwise the app shows its plain map.
                    "mapsAvailable" -> result.success(mapsAvailable())
                    else -> result.notImplemented()
                }
            }
    }
}
