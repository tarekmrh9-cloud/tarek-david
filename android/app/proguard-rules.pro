-keepattributes *Annotation*
-keepattributes SourceFile,LineNumberTable
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Application
-keep public class * extends android.webkit.WebViewClient
-keep public class * extends android.webkit.WebChromeClient
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
