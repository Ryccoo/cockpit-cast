// Pipe client for the host (docs/protocol.md section 1, capture protocol 2).
// One thread connects and reads (CONFIG, HEARTBEAT, SHUTDOWN); one thread writes a send queue.
// Overlapped I/O, because a synchronous pipe handle serialises reads and writes.
// Never blocks a caller: frames are dropped when the queue is full or the host is not connected.

#include "common.h"
#include "json.h"

#include <condition_variable>
#include <deque>
#include <thread>

namespace {

const wchar_t* kPipeName = L"\\\\.\\pipe\\cockpitcast-capture";
enum : uint8_t { HELLO = 1, FRAME = 2, LOG = 3, STATS = 4, UNCHANGED = 5, CONFIG = 16, HEARTBEAT = 17, SHUTDOWN = 18 };
const size_t kMaxQueuedBytes = 6u << 20;  // frames beyond this are dropped
const uint32_t kMaxMessage = 8u << 20;

std::mutex g_qMutex;
std::condition_variable g_qCv;
std::deque<std::vector<uint8_t>> g_queue;
size_t g_queuedBytes = 0;
HANDLE g_pipe = INVALID_HANDLE_VALUE;
std::atomic<bool> g_connected{false};
uint64_t g_connectionId = 0;  // bumped per connection, so the writer notices reconnects

std::mutex g_cfgMutex;
CaptureConfig g_cfg;

std::vector<uint8_t> Message(uint8_t type, const void* payload, size_t n) {
    std::vector<uint8_t> m(5 + n);
    uint32_t len = uint32_t(1 + n);
    memcpy(m.data(), &len, 4);
    m[4] = type;
    if (n) memcpy(m.data() + 5, payload, n);
    return m;
}

bool Enqueue(std::vector<uint8_t>&& m, bool droppable) {
    std::lock_guard<std::mutex> lock(g_qMutex);
    if (!g_connected) return false;
    if (droppable && g_queuedBytes + m.size() > kMaxQueuedBytes) return false;
    if (g_queuedBytes + m.size() > kMaxQueuedBytes + (2u << 20)) return false;  // even logs have a limit
    g_queuedBytes += m.size();
    g_queue.push_back(std::move(m));
    g_qCv.notify_one();
    return true;
}

// Overlapped write of the whole buffer; false on error or 5 s timeout.
bool WriteAll(HANDLE h, const uint8_t* data, size_t n, HANDLE ev) {
    while (n) {
        OVERLAPPED ov{};
        ov.hEvent = ev;
        DWORD written = 0;
        if (!WriteFile(h, data, DWORD(n), nullptr, &ov) && GetLastError() != ERROR_IO_PENDING) return false;
        if (WaitForSingleObject(ev, 5000) != WAIT_OBJECT_0) {
            CancelIoEx(h, &ov);
            GetOverlappedResult(h, &ov, &written, TRUE);
            return false;
        }
        if (!GetOverlappedResult(h, &ov, &written, FALSE) || !written) return false;
        data += written;
        n -= written;
    }
    return true;
}

void WriterThread() {
    HANDLE ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    for (;;) {
        std::vector<uint8_t> m;
        HANDLE h;
        uint64_t conn;
        {
            std::unique_lock<std::mutex> lock(g_qMutex);
            g_qCv.wait(lock, [] { return !g_queue.empty(); });
            m = std::move(g_queue.front());
            g_queue.pop_front();
            g_queuedBytes -= m.size();
            h = g_pipe;
            conn = g_connectionId;
        }
        if (h == INVALID_HANDLE_VALUE) continue;
        ResetEvent(ev);
        if (!WriteAll(h, m.data(), m.size(), ev)) {
            std::lock_guard<std::mutex> lock(g_qMutex);
            if (conn == g_connectionId && g_pipe != INVALID_HANDLE_VALUE) CancelIoEx(g_pipe, nullptr);  // reader sees the break
        }
    }
}

void OnConfig(const std::string& json) {
    SetConfigFromJson(json);
}

// Reads exactly n bytes with overlapped I/O. Calls StatsTick about every 2 s while waiting.
bool ReadExact(HANDLE h, uint8_t* dst, size_t n, HANDLE ev, uint64_t& nextStats) {
    while (n) {
        OVERLAPPED ov{};
        ov.hEvent = ev;
        ResetEvent(ev);
        DWORD got = 0;
        if (!ReadFile(h, dst, DWORD(n), nullptr, &ov) && GetLastError() != ERROR_IO_PENDING) return false;
        for (;;) {
            DWORD w = WaitForSingleObject(ev, 500);
            if (NowMs() >= nextStats) {
                nextStats = NowMs() + 2000;
                StatsTick();
            }
            if (w == WAIT_OBJECT_0) break;
            if (g_shutdown) {
                CancelIoEx(h, &ov);
                GetOverlappedResult(h, &ov, &got, TRUE);
                return false;
            }
        }
        if (!GetOverlappedResult(h, &ov, &got, FALSE) || !got) return false;
        dst += got;
        n -= got;
    }
    return true;
}

void ConnectionThread() {
    HANDLE ev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    bool loggedWaiting = false;
    while (!g_shutdown) {
        HANDLE h = CreateFileW(kPipeName, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
        if (h == INVALID_HANDLE_VALUE) {
            if (!loggedWaiting) LogFileOnly("host pipe not available (error %lu); retrying every 2 s", GetLastError());
            loggedWaiting = true;
            Sleep(2000);
            continue;
        }
        loggedWaiting = false;
        {
            std::lock_guard<std::mutex> lock(g_qMutex);
            g_pipe = h;
            ++g_connectionId;
            g_queue.clear();
            g_queuedBytes = 0;
            g_connected = true;
        }
        char hello[256];
        snprintf(hello, sizeof hello, "{\"source\":\"capture.dll\",\"version\":\"%s\",\"pid\":%lu,\"protocol\":2}", CL_VERSION, GetCurrentProcessId());
        Enqueue(Message(HELLO, hello, strlen(hello)), false);
        Log("connected to the host");

        uint64_t nextStats = NowMs() + 2000;
        for (;;) {
            uint32_t len = 0;
            uint8_t type = 0;
            if (!ReadExact(h, (uint8_t*)&len, 4, ev, nextStats) || len < 1 || len > kMaxMessage) break;
            if (!ReadExact(h, &type, 1, ev, nextStats)) break;
            std::string payload(len - 1, '\0');
            if (len > 1 && !ReadExact(h, (uint8_t*)payload.data(), len - 1, ev, nextStats)) break;
            if (type == HEARTBEAT) g_lastHeartbeatMs = NowMs();
            else if (type == CONFIG) OnConfig(payload);
            else if (type == SHUTDOWN) {
                Log("host asked to shut down: capture stops for good (hooks stay in pass-through)");
                g_shutdown = true;
                break;
            }
        }
        {
            std::lock_guard<std::mutex> lock(g_qMutex);
            g_connected = false;
            g_pipe = INVALID_HANDLE_VALUE;
            ++g_connectionId;
            g_queue.clear();
            g_queuedBytes = 0;
        }
        CancelIoEx(h, nullptr);
        CloseHandle(h);
        g_lastHeartbeatMs = 0;  // capture pauses until the host is back
        LogFileOnly("disconnected from the host");
        if (!g_shutdown) Sleep(2000);
    }
}

}  // namespace

std::atomic<bool> g_disabled{false};
std::atomic<bool> g_shutdown{false};
std::atomic<uint64_t> g_lastHeartbeatMs{0};

void PipeStart() {
    std::thread(WriterThread).detach();
    std::thread(ConnectionThread).detach();
}

bool PipeConnected() { return g_connected; }

bool PipeSendFrame(const std::string& id, int w, int h, uint32_t seq, const std::vector<uint8_t>& jpeg) {
    std::vector<uint8_t> p(1 + id.size() + 8 + jpeg.size());
    size_t o = 0;
    p[o++] = uint8_t(id.size());
    memcpy(&p[o], id.data(), id.size());
    o += id.size();
    uint16_t w16 = uint16_t(w), h16 = uint16_t(h);
    memcpy(&p[o], &w16, 2);
    memcpy(&p[o + 2], &h16, 2);
    memcpy(&p[o + 4], &seq, 4);
    o += 8;
    memcpy(&p[o], jpeg.data(), jpeg.size());
    return Enqueue(Message(FRAME, p.data(), p.size()), true);
}

void PipeSendUnchanged(const std::string& id, uint32_t seq) {
    std::vector<uint8_t> p(1 + id.size() + 4);
    p[0] = uint8_t(id.size());
    memcpy(&p[1], id.data(), id.size());
    memcpy(&p[1 + id.size()], &seq, 4);
    Enqueue(Message(UNCHANGED, p.data(), p.size()), true);
}

void PipeSendLog(const std::string& line) { Enqueue(Message(LOG, line.data(), line.size()), false); }

void PipeSendStats(const std::string& json) { Enqueue(Message(STATS, json.data(), json.size()), true); }

// ---- config ----

CaptureConfig GetConfig() {
    std::lock_guard<std::mutex> lock(g_cfgMutex);
    return g_cfg;
}

void SetConfigFromJson(const std::string& json) {
    JValue j = JParse(json);
    if (j.type != JValue::Object) {
        Log("ignoring CONFIG: not valid JSON");
        return;
    }
    CaptureConfig c;
    c.jpegQuality = std::clamp(j["jpegQuality"].asInt(80), 1, 100);
    c.heartbeatTimeoutMs = std::clamp(j["heartbeatTimeoutMs"].asInt(10000), 2000, 120000);
    const JValue& ds = j["displays"];
    for (size_t i = 0; i < ds.size() && i < 16; ++i) {
        const JValue& d = ds[i];
        DisplayConfig dc;
        dc.id = d["id"].asString().substr(0, 32);
        if (dc.id.empty()) continue;
        for (int k = 0; k < 2; ++k)
            for (int ch = 0; ch < 3; ++ch) dc.marker[k][ch] = uint8_t(std::clamp(d["marker"][k][ch].asInt(0), 0, 255));
        dc.readX = std::max(0, d["read"]["x"].asInt(0));
        dc.readY = std::max(0, d["read"]["y"].asInt(0));
        dc.cropW = std::max(0, d["crop"]["w"].asInt(0));
        dc.cropH = std::max(0, d["crop"]["h"].asInt(0));
        dc.texW = std::max(0, d["texture"]["w"].asInt(0));
        dc.texH = std::max(0, d["texture"]["h"].asInt(0));
        dc.enabled = d["enabled"].asBool(false);
        dc.maxFps = std::clamp(d["maxFps"].asDouble(0), 0.0, 60.0);
        dc.local = d["local"].asBool(false);
        dc.localFps = std::clamp(d["localFps"].asDouble(0), 0.0, 120.0);
        c.displays.push_back(dc);
    }
    std::string summary;
    for (auto& d : c.displays) {
        char b[128];
        if (d.enabled || d.local)
            snprintf(b, sizeof b, "%s%s=%gfps%s", summary.empty() ? "" : " ", d.id.c_str(), d.enabled ? d.maxFps : 0.0,
                     d.local ? (std::string("+local@") + std::to_string(int(d.localFps))).c_str() : "");
        else snprintf(b, sizeof b, "%s%s=off", summary.empty() ? "" : " ", d.id.c_str());
        summary += b;
    }
    {
        std::lock_guard<std::mutex> lock(g_cfgMutex);
        c.generation = g_cfg.generation + 1;
        c.valid = true;
        g_cfg = c;
    }
    LogFileOnly("config: %s Q%d", summary.c_str(), c.jpegQuality);
}
