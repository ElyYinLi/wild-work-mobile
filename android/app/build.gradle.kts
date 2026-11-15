plugins {
    id("com.android.application")
}

android {
    namespace = "com.wildwork.nativeapp"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.wildwork.nativeapp"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
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
