// JPEG encoder pool. Off the sim's threads: workers check the marker pixels, skip unchanged pictures
// (checksum), paint over the marker, encode with Windows' built-in JPEG encoder (WIC) and hand the
// result to the pipe.

#include "common.h"

#include <shlwapi.h>
#include <wincodec.h>

#include <condition_variable>
#include <deque>
#include <map>
#include <thread>

namespace {

const size_t kMaxQueue = 8;

std::mutex g_mutex;
std::condition_variable g_cv;
std::deque<EncodeJob> g_jobs;

struct DisplayState {
    uint64_t lastHash = 0;
    int lastW = 0, lastH = 0;
    uint32_t seq = 0;
    int mismatches = 0;  // since the engine last took them
};
std::map<std::string, DisplayState> g_state;  // guarded by g_mutex
std::map<int, int> g_mismatchByIndex;         // display index -> count, guarded by g_mutex

std::mutex g_statsMutex;
EncoderStats g_stats;
double g_encodeMsSum = 0;
uint64_t g_encodeCount = 0;

bool Near(uint8_t a, uint8_t b) { return (a > b ? a - b : b - a) <= 3; }

bool MarkerMatches(const EncodeJob& j) {
    for (int k = 0; k < 2; ++k) {
        const uint8_t* p = j.pixels + 4 * k;
        uint8_t r = j.bgra ? p[2] : p[0], g = p[1], b = j.bgra ? p[0] : p[2];
        if (!Near(r, j.marker[k][0]) || !Near(g, j.marker[k][1]) || !Near(b, j.marker[k][2])) return false;
    }
    return true;
}

uint64_t HashPixels(const EncodeJob& j) {
    uint64_t h = 0x9E3779B97F4A7C15ull ^ (uint64_t(j.width) << 32) ^ uint64_t(j.height);
    const size_t rowBytes = size_t(j.width) * 4;
    for (int y = 0; y < j.height; ++y) {
        const uint8_t* row = j.pixels + size_t(y) * j.rowPitch;
        size_t x = 0;
        for (; x + 8 <= rowBytes; x += 8) {
            uint64_t v;
            memcpy(&v, row + x, 8);
            h = (h ^ (v * 0x87C37B91114253D5ull)) * 0x4CF5AD432745937Full;
            h ^= h >> 29;
        }
        for (; x < rowBytes; ++x) h = (h ^ row[x]) * 0x100000001B3ull;
    }
    return h;
}

// Readback (RGBA or BGRA, row pitch) -> tightly packed BGR, 4-byte aligned rows (WIC 24bppBGR).
// The two marker pixels are replaced by the pixels just below them.
void ToBgr(const EncodeJob& j, std::vector<uint8_t>& out, UINT& stride) {
    stride = UINT((j.width * 3 + 3) & ~3);
    out.resize(size_t(stride) * j.height);
    for (int y = 0; y < j.height; ++y) {
        const uint8_t* s = j.pixels + size_t(y) * j.rowPitch;
        uint8_t* d = out.data() + size_t(y) * stride;
        if (j.bgra) {
            for (int x = 0; x < j.width; ++x, s += 4, d += 3) { d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; }
        } else {
            for (int x = 0; x < j.width; ++x, s += 4, d += 3) { d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; }
        }
    }
    if (j.height > 1 && j.width >= 2) memcpy(out.data(), out.data() + stride, 6);
}

bool EncodeJpeg(IWICImagingFactory* f, const uint8_t* bgr, UINT stride, int w, int h, int quality, std::vector<uint8_t>& jpeg) {
    IStream* stream = SHCreateMemStream(nullptr, 0);
    if (!stream) return false;
    IWICBitmapEncoder* enc = nullptr;
    IWICBitmapFrameEncode* frame = nullptr;
    IPropertyBag2* bag = nullptr;
    bool ok = false;
    do {
        if (FAILED(f->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &enc))) break;
        if (FAILED(enc->Initialize(stream, WICBitmapEncoderNoCache))) break;
        if (FAILED(enc->CreateNewFrame(&frame, &bag))) break;
        PROPBAG2 opt[2] = {};
        VARIANT val[2];
        VariantInit(&val[0]);
        VariantInit(&val[1]);
        opt[0].pstrName = const_cast<LPOLESTR>(L"ImageQuality");
        val[0].vt = VT_R4;
        val[0].fltVal = float(quality) / 100.0f;
        opt[1].pstrName = const_cast<LPOLESTR>(L"JpegYCrCbSubsampling");
        val[1].vt = VT_UI1;
        val[1].bVal = WICJpegYCrCbSubsampling420;
        bag->Write(2, opt, val);
        if (FAILED(frame->Initialize(bag))) break;
        if (FAILED(frame->SetSize(UINT(w), UINT(h)))) break;
        WICPixelFormatGUID pf = GUID_WICPixelFormat24bppBGR;
        if (FAILED(frame->SetPixelFormat(&pf)) || pf != GUID_WICPixelFormat24bppBGR) break;
        if (FAILED(frame->WritePixels(UINT(h), stride, stride * UINT(h), const_cast<BYTE*>(bgr)))) break;
        if (FAILED(frame->Commit()) || FAILED(enc->Commit())) break;
        ULARGE_INTEGER size{};
        if (FAILED(IStream_Size(stream, &size))) break;
        jpeg.resize(size_t(size.QuadPart));
        if (FAILED(IStream_Reset(stream)) || FAILED(IStream_Read(stream, jpeg.data(), ULONG(jpeg.size())))) break;
        ok = true;
    } while (false);
    if (bag) bag->Release();
    if (frame) frame->Release();
    if (enc) enc->Release();
    stream->Release();
    return ok;
}

void Worker() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IWICImagingFactory* factory = nullptr;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)))) {
        Log("encoder: cannot create the WIC factory; encoding disabled");
        return;
    }
    std::vector<uint8_t> bgr, jpeg;
    for (;;) {
        EncodeJob j;
        {
            std::unique_lock<std::mutex> lock(g_mutex);
            g_cv.wait(lock, [] { return !g_jobs.empty(); });
            j = g_jobs.front();
            g_jobs.pop_front();
        }
        auto done = [&] { if (j.doneFlag) j.doneFlag->store(1); };

        if (!MarkerMatches(j)) {
            done();
            {
                std::lock_guard<std::mutex> lock(g_mutex);
                g_mismatchByIndex[j.display]++;
            }
            std::lock_guard<std::mutex> s(g_statsMutex);
            g_stats.mismatches++;
            continue;
        }
        uint64_t hash = HashPixels(j);
        uint32_t seq;
        bool unchanged;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            DisplayState& st = g_state[j.id];
            unchanged = st.lastHash == hash && st.lastW == j.width && st.lastH == j.height;
            if (!unchanged) {
                st.lastHash = hash;
                st.lastW = j.width;
                st.lastH = j.height;
                st.seq++;
            }
            seq = st.seq;
        }
        if (unchanged) {
            done();
            PipeSendUnchanged(j.id, seq);
            std::lock_guard<std::mutex> s(g_statsMutex);
            g_stats.unchanged++;
            continue;
        }
        UINT stride = 0;
        ToBgr(j, bgr, stride);
        done();  // the readback buffer is free from here on
        double t0 = NowSec();
        bool ok = EncodeJpeg(factory, bgr.data(), stride, j.width, j.height, j.quality, jpeg);
        double ms = (NowSec() - t0) * 1000.0;
        bool sent = ok && PipeSendFrame(j.id, j.width, j.height, seq, jpeg);
        if (!sent) {
            // Forget the hash so the next frame is sent even if the picture has not changed.
            std::lock_guard<std::mutex> lock(g_mutex);
            g_state[j.id].lastHash = 0;
        }
        std::lock_guard<std::mutex> s(g_statsMutex);
        if (!ok) g_stats.failed++;
        else if (!sent) g_stats.dropped++;
        else g_stats.frames++;
        g_encodeMsSum += ms;
        g_encodeCount++;
    }
}

}  // namespace

void EncoderStart(int threads) {
    for (int i = 0; i < threads; ++i) std::thread(Worker).detach();
}

bool EncoderSubmit(const EncodeJob& job) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_jobs.size() >= kMaxQueue) return false;
    g_jobs.push_back(job);
    g_cv.notify_one();
    return true;
}

void EncoderTakeMismatch(int display, int& mismatches) {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_mismatchByIndex.find(display);
    mismatches = it == g_mismatchByIndex.end() ? 0 : it->second;
    if (it != g_mismatchByIndex.end()) it->second = 0;
}

EncoderStats EncoderGetStats() {
    std::lock_guard<std::mutex> s(g_statsMutex);
    EncoderStats out = g_stats;
    out.encodeMsAvg = g_encodeCount ? g_encodeMsSum / double(g_encodeCount) : 0;
    g_encodeMsSum = 0;
    g_encodeCount = 0;
    return out;
}
