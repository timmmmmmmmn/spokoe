import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

// Ondertekening: op GitHub uit de geheime instellingen, lokaal uit
// ~/AndroidStudioProjects/spokoe-release.properties (staat buiten de repo).
val localSigning = Properties().apply {
    val file = File(System.getProperty("user.home"), "AndroidStudioProjects/spokoe-release.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun signing(name: String): String? = System.getenv(name) ?: localSigning.getProperty(name)

// Elke build op GitHub krijgt een hoger versienummer, zodat Android hem als update ziet.
val buildNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1

android {
    namespace = "nl.timvanbergen.spokoe"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "nl.timvanbergen.spokoe"
        minSdk = 26
        targetSdk = 37
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
        // Alleen 64-bit ARM (vrijwel elke telefoon sinds 2017): de app blijft klein.
        ndk { abiFilters += "arm64-v8a" }
    }

    signingConfigs {
        create("release") {
            signing("SPOKOE_KEYSTORE")?.let { storeFile = file(it) }
            storePassword = signing("SPOKOE_KEYSTORE_PASSWORD")
            keyAlias = signing("SPOKOE_KEY_ALIAS")
            keyPassword = signing("SPOKOE_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    // Dezelfde interface als de Mac-app; de Rust-kern komt uit android/core (zie build.sh).
    sourceSets {
        getByName("main") {
            assets.srcDirs("../../ui")
            jniLibs.srcDirs("src/main/jniLibs")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.media)
}
