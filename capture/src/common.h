// cockpit-link-capture.dll: shared declarations.
#pragma once

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#define CL_VERSION "0.1.0"

// ---- logging (log.cpp) ----
// Writes to %LOCALAPPDATA%\CockpitLink\logs\capture.log and, when connected, to the host as LOG.
void LogInit();
void Log(const char* fmt, ...);
void LogFileOnly(const char* fmt, ...);

// ---- time ----
inline uint64_t NowMs() { return GetTickCount64(); }
inline double NowSec() {
    static LARGE_INTEGER freq = [] { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f; }();
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return double(t.QuadPart) / double(freq.QuadPart);
}

// ---- configuration from the host (CONFIG message) ----
struct DisplayConfig {
    std::string id;
    uint8_t marker[2][3] = {};
    int readX = 0, readY = 0;
    int cropW = 0, cropH = 0;   // 0 = whole texture from the read point
    int texW = 0, texH = 0;     // 0 = unknown
    bool enabled = false;
    double maxFps = 0;  // may be below 1 (e.g. 0.2: one picture every 5 s for previews)
};

struct CaptureConfig {
    int jpegQuality = 80;
    int heartbeatTimeoutMs = 10000;
    std::vector<DisplayConfig> displays;
    uint64_t generation = 0;  // bumped on every new CONFIG
    bool valid = false;       // false until the first CONFIG arrives
};

// Global switches.
extern std::atomic<bool> g_disabled;        // permanent: something went wrong, hooks pass through
extern std::atomic<bool> g_shutdown;        // host asked us to stop for good
extern std::atomic<uint64_t> g_lastHeartbeatMs;

// Current config (copied under the mutex).
CaptureConfig GetConfig();
void SetConfigFromJson(const std::string& json);

// ---- pipe to the host (pipe.cpp) ----
void PipeStart();
bool PipeConnected();
// Returns false if the frame was dropped (pipe backed up or not connected).
bool PipeSendFrame(const std::string& id, int w, int h, uint32_t seq, const std::vector<uint8_t>& jpeg);
void PipeSendUnchanged(const std::string& id, uint32_t seq);
void PipeSendLog(const std::string& line);
void PipeSendStats(const std::string& json);

// ---- hooks (hooks.cpp) ----
bool InstallHooks();

// ---- capture engine (capture.cpp) ----
struct ID3D12CommandQueue;
struct ID3D12GraphicsCommandList;
struct D3D12_RESOURCE_BARRIER;
void OnExecuteCommandLists(ID3D12CommandQueue* queue);
void OnResourceBarrier(UINT count, const D3D12_RESOURCE_BARRIER* barriers);
void OnPresent();
void StatsTick();  // called about every 2 s from the pipe thread

// The original ExecuteCommandLists, so our own submissions skip our hook.
using PFN_ECL = void(STDMETHODCALLTYPE*)(ID3D12CommandQueue*, UINT, void* const*);
extern PFN_ECL g_origExecuteCommandLists;

// ---- encoder (encoder.cpp) ----
struct EncodeJob {
    int display = -1;
    std::string id;
    const uint8_t* pixels = nullptr;  // mapped readback memory, top-left of the crop
    uint32_t rowPitch = 0;
    int width = 0, height = 0;
    bool bgra = false;                 // texture byte order B,G,R,A (else R,G,B,A)
    uint8_t marker[2][3] = {};
    int quality = 80;
    std::atomic<int>* doneFlag = nullptr;  // set to 1 when the job no longer needs the pixels
};
void EncoderStart(int threads);
bool EncoderSubmit(const EncodeJob& job);  // false when the queue is full
// Per display: the encoder reports marker mismatches here; the engine re-probes.
void EncoderTakeMismatch(int display, int& mismatches);
struct EncoderStats {
    uint64_t frames = 0, unchanged = 0, mismatches = 0, dropped = 0, failed = 0;
    double encodeMsAvg = 0;
};
EncoderStats EncoderGetStats();
