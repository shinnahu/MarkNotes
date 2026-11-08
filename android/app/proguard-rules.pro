# The web page calls this object (addJavascriptInterface).
-keepclassmembers class com.marknotes.app.MainActivity$JsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-dontwarn java.lang.invoke.**
