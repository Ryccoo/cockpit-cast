// Logging: a local file (always, so there is a trace even when the host is not connected) plus LOG
// messages to the host.

#include "common.h"

#include <shlobj.h>

#include <cstdarg>
#include <cstdio>

namespace {
std::mutex g_logMutex;
FILE* g_file = nullptr;
size_t g_bytes = 0;
const size_t kMaxBytes = 8u << 20;

void WriteFileLine(const char* text) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    if (!g_file || g_bytes > kMaxBytes) return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    int n = fprintf(g_file, "%02d:%02d:%02d.%03d %s\n", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, text);
    if (n > 0) g_bytes += size_t(n);
    fflush(g_file);
}

std::string Format(const char* fmt, va_list ap) {
    char buf[1024];
    vsnprintf(buf, sizeof buf, fmt, ap);
    return buf;
}
}  // namespace

void LogInit() {
    char base[MAX_PATH];
    std::string dir;
    if (SUCCEEDED(SHGetFolderPathA(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, base)))
        dir = std::string(base) + "\\CockpitCast\\logs";
    else {
        GetTempPathA(MAX_PATH, base);
        dir = base;
    }
    SHCreateDirectoryExA(nullptr, dir.c_str(), nullptr);
    std::string path = dir + "\\capture.log";
    std::string old = dir + "\\capture.1.log";
    MoveFileExA(path.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING);
    std::lock_guard<std::mutex> lock(g_logMutex);
    g_file = _fsopen(path.c_str(), "w", _SH_DENYWR);
}

void LogFileOnly(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::string s = Format(fmt, ap);
    va_end(ap);
    WriteFileLine(s.c_str());
}

void Log(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::string s = Format(fmt, ap);
    va_end(ap);
    WriteFileLine(s.c_str());
    PipeSendLog(s);
}
