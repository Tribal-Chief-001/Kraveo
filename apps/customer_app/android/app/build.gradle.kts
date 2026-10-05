plugins {
    id("com.android.application")
    id("dev.flutter.flutter-gradle-plugin")
    id("com.google.gms.google-services")
}

// Google Maps key: Gradle property MAPS_API_KEY, else env KRAVEO_MAPS_API_KEY, else empty. It is
// only ever injected into the manifest placeholder; it is never written to the repository. With
// no key the build still succeeds and the app shows its plain (non-Google) tracking map.
fun nonBlank(value: Any?): String? = value?.toString()?.trim()?.takeIf { it.isNotEmpty() }
val mapsApiKey: String = nonBlank(project.findProperty("MAPS_API_KEY")) ?: nonBlank(System.getenv("KRAVEO_MAPS_API_KEY")) ?: ""

android {
    namespace = "site.kraveo.customer"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        // Required by flutter_local_notifications (java.time on API 24+).
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "site.kraveo.customer"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["MAPS_API_KEY"] = mapsApiKey
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
