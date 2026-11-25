// cockpitcast-capture.dll entry point.
// DllMain only starts a thread (nothing heavy under the loader lock). The thread pins the DLL in
// memory (the sim's function tables will point into it, so it must never be unloaded), opens the log,
// connects to the host, starts the encoder and installs the hooks.

#include "common.h"

namespace {

DWORD WINAPI InitThread(void* module) {
    HMODULE pinned = nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN, (LPCWSTR)module, &pinned);
    LogInit();
    char exe[MAX_PATH] = "?";
    GetModuleFileNameA(nullptr, exe, MAX_PATH);
    LogFileOnly("CockpitCast capture %s loaded into %s (pid %lu)", CL_VERSION, exe, GetCurrentProcessId());
    PipeStart();
    EncoderStart(2);
    if (InstallHooks()) Log("hooks installed; waiting for the sim to draw");
    else Log("hooks NOT installed; capture is off (the sim is unaffected)");
    return 0;
}

}  // namespace

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        HANDLE t = CreateThread(nullptr, 0, InitThread, inst, 0, nullptr);
        if (t) CloseHandle(t);
    }
    return TRUE;
}
