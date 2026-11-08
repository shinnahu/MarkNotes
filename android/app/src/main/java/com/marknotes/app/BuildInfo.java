package com.marknotes.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;

final class BuildInfo {
    private BuildInfo() {}

    /** Debug builds let Chrome's DevTools inspect the page (chrome://inspect); release builds don't. */
    static boolean debuggable(Context c) {
        return (c.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
}
