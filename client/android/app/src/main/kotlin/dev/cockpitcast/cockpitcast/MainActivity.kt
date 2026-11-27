package dev.cockpitcast.cockpitcast

import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import io.flutter.embedding.android.FlutterActivity

// Flutter's Impeller renderer runs on Vulkan 1.1 where a device has it, and on OpenGL ES otherwise.
// That OpenGL ES path crashes old GPUs: on an Adreno 330 tablet a shader needs
// GL_OES_EGL_image_external_essl3, which the GPU lacks, and the driver's shader compiler then crashes
// on the first frame. Devices without Vulkan 1.1 therefore get Flutter's older Skia renderer (OpenGL
// ES 2/3); devices with Vulkan 1.1 keep Impeller. A flag passed here wins over the manifest.
class MainActivity : FlutterActivity() {
    override fun getFlutterEngineFlags(): List<String> {
        val flags = super.getFlutterEngineFlags()
        if (hasVulkan11()) return flags
        Log.i(TAG, "No Vulkan 1.1 on this device: using the Skia renderer instead of Impeller")
        return flags + "--enable-impeller=false"
    }

    private fun hasVulkan11(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
            packageManager.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_VERSION, VULKAN_1_1)

    companion object {
        private const val TAG = "CockpitCast"

        // Vulkan versions as Android reports them: major << 22 | minor << 12.
        private const val VULKAN_1_1 = (1 shl 22) or (1 shl 12)
    }
}
