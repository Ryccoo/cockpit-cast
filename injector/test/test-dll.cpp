// Test DLL for the injector and the host's capture link, built as cockpitcast-capture.dll in the
// test folder. It hooks nothing and captures nothing: once loaded it connects to the host's pipe,
// says HELLO, logs which process it is in, logs every CONFIG it receives, sends STATS every 5 s,
// and goes quiet on SHUTDOWN or when heartbeats stop. Use it with fake-sim.exe.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace {

const wchar_t* kPipe = L"\\\\.\\pipe\\cockpitcast-capture";
enum : uint8_t { HELLO = 1, LOG = 3, STATS = 4, CONFIG = 16, HEARTBEAT = 17, SHUTDOWN = 18 };

HANDLE g_pipe = INVALID_HANDLE_VALUE;

bool Send(uint8_t type, const std::string& payload) {
    std::vector<uint8_t> buf(5 + payload.size());
    uint32_t len = (uint32_t)(1 + payload.size());
    memcpy(buf.data(), &len, 4);
    buf[4] = type;
    memcpy(buf.data() + 5, payload.data(), payload.size());
    DWORD written = 0;
    return WriteFile(g_pipe, buf.data(), (DWORD)buf.size(), &written, nullptr) && written == buf.size();
}

bool ReadExact(void* dst, DWORD n) {
    auto* p = (uint8_t*)dst;
    while (n) {
        DWORD got = 0;
        if (!ReadFile(g_pipe, p, n, &got, nullptr) || !got) return false;
        p += got;
        n -= got;
    }
    return true;
}

DWORD WINAPI Worker(void*) {
    // Connect, retrying for up to 30 s (the host may start later).
    for (int i = 0; i < 60 && g_pipe == INVALID_HANDLE_VALUE; ++i) {
        g_pipe = CreateFileW(kPipe, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (g_pipe == INVALID_HANDLE_VALUE) Sleep(500);
    }
    if (g_pipe == INVALID_HANDLE_VALUE) return 0;

    wchar_t exe[MAX_PATH] = L"?";
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    char exeUtf8[MAX_PATH * 3];
    WideCharToMultiByte(CP_UTF8, 0, exe, -1, exeUtf8, sizeof exeUtf8, nullptr, nullptr);
    for (char* c = exeUtf8; *c; ++c) if (*c == '\\') *c = '/';

    char hello[512];
    snprintf(hello, sizeof hello, "{\"source\":\"test-dll\",\"version\":\"0.0.1\",\"pid\":%lu,\"protocol\":2}", GetCurrentProcessId());
    Send(HELLO, hello);
    Send(LOG, std::string("test DLL loaded into ") + exeUtf8);

    // Heartbeat watchdog + periodic stats on a second thread.
    static volatile LONG lastBeat = (LONG)GetTickCount();
    static volatile LONG stop = 0;
    CreateThread(nullptr, 0, [](void*) -> DWORD {
        int n = 0;
        while (!stop) {
            Sleep(500);
            if ((LONG)GetTickCount() - lastBeat > 10000) {
                Send(LOG, "no heartbeat for 10 s: going quiet");
                stop = 1;
                CancelIoEx(g_pipe, nullptr);
                break;
            }
            if (++n % 10 == 0) Send(STATS, "{\"tracked\":0,\"note\":\"test DLL, captures nothing\"}");
        }
        return 0;
    }, nullptr, 0, nullptr);

    for (;;) {
        uint32_t len = 0;
        uint8_t type = 0;
        if (!ReadExact(&len, 4) || len < 1 || len > (8u << 20) || !ReadExact(&type, 1)) break;
        std::string payload(len - 1, '\0');
        if (len > 1 && !ReadExact(payload.data(), len - 1)) break;
        if (type == HEARTBEAT) lastBeat = (LONG)GetTickCount();
        else if (type == CONFIG) Send(LOG, "config received: " + payload.substr(0, 300));
        else if (type == SHUTDOWN) {
            Send(LOG, "shutdown requested: going quiet");
            break;
        }
    }
    stop = 1;
    CloseHandle(g_pipe);
    g_pipe = INVALID_HANDLE_VALUE;
    return 0;
}

}  // namespace

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        HANDLE t = CreateThread(nullptr, 0, Worker, nullptr, 0, nullptr);
        if (t) CloseHandle(t);
    }
    return TRUE;
}
