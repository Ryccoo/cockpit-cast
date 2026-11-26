import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing (the app's upload key; never in the repo). From environment variables in CI
// (ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS), or locally from
// android/key.properties (storeFile, storePassword, keyAlias; git-ignored). Without either, release
// builds are signed with the debug key, as Flutter does by default.
val keyProps = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val uploadStore: String? = System.getenv("ANDROID_KEYSTORE_PATH") ?: keyProps.getProperty("storeFile")
val uploadPassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: keyProps.getProperty("storePassword")
val uploadAlias: String = System.getenv("ANDROID_KEY_ALIAS") ?: keyProps.getProperty("keyAlias") ?: "upload"
val hasUploadKey = !uploadStore.isNullOrBlank() && !uploadPassword.isNullOrBlank() && file(uploadStore!!).exists()

android {
    namespace = "dev.cockpitcast.cockpitcast"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "dev.cockpitcast.cockpitcast"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasUploadKey) {
            create("upload") {
                storeFile = file(uploadStore!!)
                storePassword = uploadPassword
                keyAlias = uploadAlias
                keyPassword = uploadPassword // PKCS12 keystores use one password for both
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName(if (hasUploadKey) "upload" else "debug")
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
