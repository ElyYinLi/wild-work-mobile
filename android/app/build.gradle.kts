plugins {
    id("com.android.application")
}

android {
    namespace = "com.wildwork.mobile"
    compileSdk = 34

    defaultConfig {
        // 与 iOS 侧 com.wildwork.mobile 及 Java 源码包名保持一致；
        // 此前误用 com.wildwork.nativeapp，会与纯移动端 APK 互相覆盖。
        applicationId = "com.wildwork.mobile"
        minSdk = 24
        targetSdk = 34
        // 版本号由 CI 从上游最新 tag 注入（-PupstreamVersion / -PversionCode）。
        versionCode = project.findProperty("versionCode")?.toString()?.toIntOrNull() ?: 1
        versionName = project.findProperty("upstreamVersion")?.toString() ?: "0.0.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            // 自用工具：用 debug 签名，避免要求用户配置 keystore。
            // 若要上架/长期分发，替换为自己的 signingConfig。
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // mobile-ui 在构建前由 CI 复制到 assets/www，这里不做额外处理
    androidResources {
        noCompress += listOf("html", "js", "css")
    }
}

dependencies {
    // 刻意零第三方依赖：壳只需要 WebView + 自建代理，减少构建失败面。
}
