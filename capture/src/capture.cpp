// Capture engine.
//
// 1. Queue: watch ExecuteCommandLists for a second and pick the DIRECT queue that gets the most
//    submissions (the sim's main graphics queue; frame generation adds others). Our copies run there.
// 2. Candidates: ResourceBarrier reports textures moving into RENDER_TARGET. Each new one is checked
//    once (Texture2D, 8-bit RGBA/BGRA, 1 sample, no array, plausible size) and kept (AddRef) if it
//    fits. At most 48 tracked; textures not drawn into for 5 s are let go.
// 3. Probe: copy the 2 marker pixels at each display's read point from every tracked texture into
//    one small readback buffer; on a later frame (never waiting on the GPU) compare with the marker
//    colours. That maps display -> texture. Re-probed every 2 s and after any mismatch.
// 4. Capture: for each display a client is watching, at its fps, copy just the display's area into a
//    readback buffer (3 per display). When the GPU is done (checked, never waited for), the encoder
//    pool checks the marker again, skips unchanged pictures and sends JPEGs to the host.
//
// RunFrame runs from Present (or from ExecuteCommandLists if Present never comes), at most once per
// call and never blocking: if another thread is in it, the call returns at once.

#include "common.h"

#include <d3d12.h>

#include <memory>
#include <unordered_map>

namespace {

const int kMaxTracked = 48;
const int kMaxDisplays = 16;
const int kSlots = 3;
const uint64_t kProbeCellBytes = 512;  // D3D12_TEXTURE_DATA_PLACEMENT_ALIGNMENT
const uint64_t kDecayMs = 5000;
const uint64_t kFreeIdleMs = 5000;     // readback buffers of unwatched displays are freed after this
const uint64_t kSizeTrustMs = 10000;   // a watched display not found by size this long: track all sizes
const uint64_t kReprobeMs = 2000;   // watched displays not found yet: look again this often
const uint64_t kRecheckMs = 10000;  // watched displays already found: confirm the texture this often
const uint64_t kQueuePickMs = 1000;

// ---------------- queue selection ----------------
struct QueueSeen {
    ID3D12CommandQueue* q = nullptr;
    uint64_t submits = 0;
    bool direct = false;
};
std::mutex g_queueMutex;
QueueSeen g_queues[16];
int g_queueCount = 0;
uint64_t g_firstEclMs = 0;
std::atomic<ID3D12CommandQueue*> g_queue{nullptr};
ID3D12Device* g_device = nullptr;
std::atomic<uint64_t> g_lastPresentMs{0};
std::atomic<uint64_t> g_lastFallbackRunMs{0};

// ---------------- candidates (filled from ResourceBarrier on game threads) ----------------
struct SeenInfo {
    uint64_t firstMs = 0, lastMs = 0;
    bool accepted = false;
};
std::mutex g_candMutex;
std::unordered_map<ID3D12Resource*, SeenInfo> g_seen;
std::vector<ID3D12Resource*> g_candidates;  // AddRef'd, waiting for RunFrame
// What is worth tracking (under g_candMutex), from what the host watches. Nothing watched: no texture is
// kept (AddRef) at all, so the sim can free its textures. Every watched display's texture size known
// (the hook reports it): only textures of those sizes are kept.
bool g_trackAny = false;
bool g_sizeFilter = false;
std::vector<std::pair<uint64_t, UINT>> g_wantSizes;
bool SizeWanted(const D3D12_RESOURCE_DESC& d) {
    if (!g_sizeFilter) return true;
    for (auto& s : g_wantSizes)
        if (s.first == d.Width && s.second == d.Height) return true;
    return false;
}
std::atomic<uint64_t> g_barrierCalls{0};
uint64_t g_rtTransitions = 0, g_accepted = 0;

bool IsBgra(DXGI_FORMAT f) { return f == DXGI_FORMAT_B8G8R8A8_UNORM || f == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB; }

bool Acceptable(const D3D12_RESOURCE_DESC& d) {
    if (d.Dimension != D3D12_RESOURCE_DIMENSION_TEXTURE2D) return false;
    if (d.DepthOrArraySize != 1 || d.SampleDesc.Count != 1) return false;
    if (!(d.Flags & D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET)) return false;
    switch (d.Format) {
        case DXGI_FORMAT_R8G8B8A8_UNORM:
        case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
        case DXGI_FORMAT_B8G8R8A8_UNORM:
        case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
            break;
        default:
            return false;
    }
    // Small minimum: instruments such as hour meters are only ~230x45.
    return d.Width >= 32 && d.Width <= 8192 && d.Height >= 16 && d.Height <= 8192;
}

// ---------------- engine state (RunFrame thread, under g_engineMutex) ----------------
std::mutex g_engineMutex;

struct Tracked {
    ID3D12Resource* res = nullptr;
    D3D12_RESOURCE_DESC desc{};
    uint64_t addedMs = 0;
    uint64_t lastUseFence = 0;
};
std::vector<Tracked> g_tracked;

struct Slot {
    enum State { Free, Copying, Copied, Encoding } state = Free;
    ID3D12Resource* buf = nullptr;
    uint8_t* mapped = nullptr;
    uint64_t capacity = 0;
    uint32_t rowPitch = 0;
    int w = 0, h = 0;
    bool bgra = false;
    uint64_t fence = 0;
    uint64_t readyMs = 0;
    std::atomic<int> done{0};
};

struct Display {
    std::string id;
    DisplayConfig cfg;
    ID3D12Resource* mapped = nullptr;  // matched texture (in g_tracked)
    uint64_t matchedMs = 0;
    int mismatches = 0;
    double nextCaptureSec = 0;
    Slot slots[kSlots];
    uint64_t submitted = 0;
    bool loggedNoMatch = false;
    bool wasEnabled = false;  // watched in the previous CONFIG
    uint64_t watchedSinceMs = 0;  // when it started being watched
    uint64_t idleSinceMs = 0;     // when it stopped being watched (0: watched)
};
std::vector<std::unique_ptr<Display>> g_displays;  // never shrinks: slots may be in use by encoders
CaptureConfig g_cfg;

struct Cmd {
    ID3D12CommandAllocator* alloc = nullptr;
    ID3D12GraphicsCommandList* list = nullptr;
    uint64_t fence = 0;
};
Cmd g_cmds[4];
ID3D12Fence* g_fence = nullptr;
uint64_t g_fenceValue = 0;
bool g_resourcesReady = false;
bool g_resourcesFailed = false;
bool g_released = false;

ID3D12Resource* g_probeBuf = nullptr;
uint8_t* g_probeMapped = nullptr;
struct ProbeEntry {
    ID3D12Resource* res;
    int display;
    uint64_t offset;
    bool bgra;
};
std::vector<ProbeEntry> g_probeEntries;
bool g_probePending = false;
uint64_t g_probeFence = 0;
uint64_t g_lastProbeMs = 0;
uint64_t g_lastRecheckMs = 0;
bool g_forceProbe = false;
bool g_probeRechecks = false;            // the probe being recorded also re-checks found displays
std::vector<bool> g_probed;              // per display: part of the last probe
bool g_wasActive = false;

uint64_t g_runFrames = 0, g_probes = 0, g_copies = 0, g_skippedNoCmd = 0;
// Time spent in RunFrame on the sim's thread (stats window, reset every StatsTick).
std::mutex g_timeMutex;
double g_runMsSum = 0, g_runMsMax = 0;
uint64_t g_runCount = 0;

void RunFrame();

void RunFrameTimed() {
    double t0 = NowSec();
    RunFrame();
    double ms = (NowSec() - t0) * 1000.0;
    std::lock_guard<std::mutex> lock(g_timeMutex);
    g_runMsSum += ms;
    g_runMsMax = std::max(g_runMsMax, ms);
    ++g_runCount;
}

uint64_t Align(uint64_t v, uint64_t a) { return (v + a - 1) & ~(a - 1); }

ID3D12Resource* CreateReadback(uint64_t bytes) {
    D3D12_HEAP_PROPERTIES hp{};
    hp.Type = D3D12_HEAP_TYPE_READBACK;
    D3D12_RESOURCE_DESC rd{};
    rd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    rd.Width = bytes;
    rd.Height = 1;
    rd.DepthOrArraySize = 1;
    rd.MipLevels = 1;
    rd.SampleDesc.Count = 1;
    rd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    ID3D12Resource* r = nullptr;
    HRESULT hr = g_device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&r));
    if (FAILED(hr)) {
        Log("cannot create a %llu-byte readback buffer (0x%08lx)", (unsigned long long)bytes, hr);
        return nullptr;
    }
    return r;
}

bool CreateResources() {
    if (FAILED(g_device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&g_fence)))) return false;
    for (Cmd& c : g_cmds) {
        if (FAILED(g_device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&c.alloc)))) return false;
        if (FAILED(g_device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, c.alloc, nullptr, IID_PPV_ARGS(&c.list)))) return false;
        c.list->Close();
    }
    g_probeBuf = CreateReadback(uint64_t(kMaxTracked) * kMaxDisplays * kProbeCellBytes);
    if (!g_probeBuf) return false;
    D3D12_RANGE none{0, 0};
    if (FAILED(g_probeBuf->Map(0, &none, (void**)&g_probeMapped))) return false;
    return true;
}

// Called once on shutdown, when nothing is in flight.
void ReleaseAll() {
    for (auto& d : g_displays)
        for (Slot& s : d->slots)
            if (s.buf) {
                s.buf->Unmap(0, nullptr);
                s.buf->Release();
                s.buf = nullptr;
                s.mapped = nullptr;
            }
    for (Tracked& t : g_tracked) t.res->Release();
    g_tracked.clear();
    {
        std::lock_guard<std::mutex> lock(g_candMutex);
        for (ID3D12Resource* r : g_candidates) r->Release();
        g_candidates.clear();
        g_seen.clear();
    }
    if (g_probeBuf) {
        g_probeBuf->Unmap(0, nullptr);
        g_probeBuf->Release();
        g_probeBuf = nullptr;
    }
    for (Cmd& c : g_cmds) {
        if (c.list) c.list->Release();
        if (c.alloc) c.alloc->Release();
        c = Cmd{};
    }
    if (g_fence) g_fence->Release();
    g_fence = nullptr;
    g_released = true;
    Log("capture resources released");
}

Display* FindDisplay(const std::string& id) {
    for (auto& d : g_displays)
        if (d->id == id) return d.get();
    return nullptr;
}

void ApplyConfig(const CaptureConfig& c) {
    for (auto& d : g_displays) {
        d->wasEnabled = d->cfg.enabled;
        d->cfg.enabled = false;
    }
    for (const DisplayConfig& dc : c.displays) {
        Display* d = FindDisplay(dc.id);
        if (!d && (int)g_displays.size() >= kMaxDisplays) {
            // All entries taken (the host learns displays as aircraft change): reuse one that is not in
            // this CONFIG and has no copy or encode in flight. Its readback buffers are kept.
            for (auto& old : g_displays) {
                bool inConfig = false;
                for (const DisplayConfig& other : c.displays) inConfig = inConfig || other.id == old->id;
                bool busy = false;
                for (Slot& s : old->slots) busy = busy || s.state == Slot::Copying || (s.state == Slot::Encoding && !s.done.load());
                if (inConfig || busy) continue;
                for (Slot& s : old->slots) s.state = Slot::Free;
                LogFileOnly("display entry %s reused for %s", old->id.c_str(), dc.id.c_str());
                d = old.get();
                d->id = dc.id;
                d->cfg = DisplayConfig{};
                d->mapped = nullptr;
                d->mismatches = 0;
                d->loggedNoMatch = false;
                d->nextCaptureSec = 0;
                g_forceProbe = true;
                break;
            }
            if (!d) continue;
        }
        if (!d) {
            g_displays.push_back(std::make_unique<Display>());
            d = g_displays.back().get();
            d->id = dc.id;
        }
        bool moved = d->cfg.readX != dc.readX || d->cfg.readY != dc.readY || memcmp(d->cfg.marker, dc.marker, sizeof dc.marker) != 0;
        // Unwatched displays are not probed, so their mapping may be stale: look again when watched.
        bool woke = dc.enabled && !d->wasEnabled;
        if (woke) d->watchedSinceMs = NowMs();
        d->cfg = dc;
        if (moved || woke) {
            d->mapped = nullptr;
            g_forceProbe = true;
        }
    }
    g_cfg = c;
}

int DisplayIndex(const Display* d) {
    for (size_t i = 0; i < g_displays.size(); ++i)
        if (g_displays[i].get() == d) return int(i);
    return -1;
}

const Tracked* FindTracked(ID3D12Resource* r) {
    for (const Tracked& t : g_tracked)
        if (t.res == r) return &t;
    return nullptr;
}

bool IsMapped(ID3D12Resource* r) {
    for (auto& d : g_displays)
        if (d->mapped == r) return true;
    return false;
}

// Move new candidates into the tracked list; let go of textures nobody draws into any more.
void UpdateTracked(uint64_t now, uint64_t completed) {
    std::vector<ID3D12Resource*> fresh;
    {
        std::lock_guard<std::mutex> lock(g_candMutex);
        fresh.swap(g_candidates);
        // Forget rejected textures after 10 s, so a recycled pointer gets checked again.
        for (auto it = g_seen.begin(); it != g_seen.end();) {
            if (!it->second.accepted && now - it->second.firstMs > 10000) it = g_seen.erase(it);
            else ++it;
        }
        // Decay tracked textures not drawn into for a while.
        for (size_t i = 0; i < g_tracked.size();) {
            Tracked& t = g_tracked[i];
            auto it = g_seen.find(t.res);
            uint64_t last = it != g_seen.end() ? it->second.lastMs : 0;
            bool unwanted = !g_trackAny || !SizeWanted(t.desc);
            if ((now - last > kDecayMs || unwanted) && completed >= t.lastUseFence) {
                for (auto& d : g_displays)
                    if (d->mapped == t.res) {
                        LogFileOnly("%s: texture %p no longer drawn; unmapped", d->id.c_str(), (void*)t.res);
                        d->mapped = nullptr;
                    }
                if (it != g_seen.end()) g_seen.erase(it);
                t.res->Release();
                g_tracked.erase(g_tracked.begin() + i);
                g_forceProbe = true;
            } else {
                ++i;
            }
        }
    }
    for (ID3D12Resource* r : fresh) {
        bool wanted;
        {
            std::lock_guard<std::mutex> lock(g_candMutex);
            wanted = g_trackAny && SizeWanted(r->GetDesc());
            if (!wanted) g_seen.erase(r);  // looked at again if the rules change
        }
        if (!wanted) {
            r->Release();
            continue;
        }
        if ((int)g_tracked.size() >= kMaxTracked) {
            // Full: make room by dropping the oldest texture no display uses, if it is idle.
            size_t victim = SIZE_MAX;
            for (size_t i = 0; i < g_tracked.size(); ++i)
                if (!IsMapped(g_tracked[i].res) && completed >= g_tracked[i].lastUseFence) {
                    victim = i;
                    break;
                }
            if (victim == SIZE_MAX) {
                std::lock_guard<std::mutex> lock(g_candMutex);
                g_seen.erase(r);
                r->Release();
                continue;
            }
            std::lock_guard<std::mutex> lock(g_candMutex);
            g_seen.erase(g_tracked[victim].res);
            g_tracked[victim].res->Release();
            g_tracked.erase(g_tracked.begin() + victim);
        }
        Tracked t;
        t.res = r;
        t.desc = r->GetDesc();
        t.addedMs = now;
        g_tracked.push_back(t);
        g_forceProbe = true;
    }
}

// Should this display be part of the next probe? Only watched ones: those not found yet, and (when
// rechecking) those found. Unwatched displays cost nothing.
bool WantsProbe(const Display& d, bool recheck) {
    return d.cfg.enabled && d.cfg.maxFps > 0 && (!d.mapped || recheck);
}

// Record marker-pixel copies from every tracked texture for the displays that need it.
void RecordProbe(ID3D12GraphicsCommandList* list, bool recheck) {
    g_probeEntries.clear();
    g_probed.assign(g_displays.size(), false);
    for (size_t di = 0; di < g_displays.size(); ++di) g_probed[di] = WantsProbe(*g_displays[di], recheck);
    for (size_t t = 0; t < g_tracked.size(); ++t) {
        const Tracked& tr = g_tracked[t];
        for (size_t di = 0; di < g_displays.size(); ++di) {
            if (!g_probed[di]) continue;
            const DisplayConfig& c = g_displays[di]->cfg;
            if (uint64_t(c.readX) + 2 > tr.desc.Width || uint64_t(c.readY) + 1 > tr.desc.Height) continue;
            uint64_t offset = (uint64_t(t) * kMaxDisplays + di) * kProbeCellBytes;
            D3D12_TEXTURE_COPY_LOCATION dst{};
            dst.pResource = g_probeBuf;
            dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
            dst.PlacedFootprint.Offset = offset;
            dst.PlacedFootprint.Footprint = {tr.desc.Format, 2, 1, 1, D3D12_TEXTURE_DATA_PITCH_ALIGNMENT};
            D3D12_TEXTURE_COPY_LOCATION src{};
            src.pResource = tr.res;
            src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
            src.SubresourceIndex = 0;
            D3D12_BOX box{UINT(c.readX), UINT(c.readY), 0, UINT(c.readX + 2), UINT(c.readY + 1), 1};
            list->CopyTextureRegion(&dst, 0, 0, 0, &src, &box);
            g_probeEntries.push_back({tr.res, int(di), offset, IsBgra(tr.desc.Format)});
        }
    }
}

bool PixelNear(const uint8_t* p, bool bgra, const uint8_t rgb[3]) {
    uint8_t r = bgra ? p[2] : p[0], g = p[1], b = bgra ? p[0] : p[2];
    auto near3 = [](uint8_t a, uint8_t c) { return (a > c ? a - c : c - a) <= 3; };
    return near3(r, rgb[0]) && near3(g, rgb[1]) && near3(b, rgb[2]);
}

void EvaluateProbe(uint64_t now) {
    g_probePending = false;
    std::vector<std::vector<ID3D12Resource*>> found(g_displays.size());
    for (const ProbeEntry& e : g_probeEntries) {
        if (e.display >= (int)g_displays.size()) continue;
        const uint8_t* px = g_probeMapped + e.offset;
        const DisplayConfig& c = g_displays[e.display]->cfg;
        if (PixelNear(px, e.bgra, c.marker[0]) && PixelNear(px + 4, e.bgra, c.marker[1])) found[e.display].push_back(e.res);
    }
    std::lock_guard<std::mutex> lock(g_candMutex);  // for lastMs in g_seen
    for (size_t di = 0; di < g_displays.size(); ++di) {
        if (di >= g_probed.size() || !g_probed[di]) continue;  // not looked for in this probe: keep as is
        Display& d = *g_displays[di];
        ID3D12Resource* pick = nullptr;
        uint64_t bestLast = 0;
        bool bestSize = false;
        for (ID3D12Resource* r : found[di]) {
            const Tracked* t = FindTracked(r);
            if (!t) continue;
            bool sizeOk = d.cfg.texW && t->desc.Width == uint64_t(d.cfg.texW) && t->desc.Height == UINT(d.cfg.texH);
            auto it = g_seen.find(r);
            uint64_t last = it != g_seen.end() ? it->second.lastMs : 0;
            // Prefer the texture whose size the hook reported, then the one drawn into most recently.
            if (!pick || (sizeOk && !bestSize) || (sizeOk == bestSize && last > bestLast)) {
                pick = r;
                bestLast = last;
                bestSize = sizeOk;
            }
        }
        if (pick != d.mapped) {
            if (pick) {
                const Tracked* t = FindTracked(pick);
                Log("%s: matched texture %p (%llux%u, %s, %zu candidate%s)", d.id.c_str(), (void*)pick, (unsigned long long)t->desc.Width, t->desc.Height,
                    IsBgra(t->desc.Format) ? "BGRA" : "RGBA", found[di].size(), found[di].size() == 1 ? "" : "s");
                d.loggedNoMatch = false;
            } else if (d.mapped) {
                Log("%s: marker no longer found; looking again", d.id.c_str());
            }
            d.mapped = pick;
            d.mismatches = 0;
        }
        if (pick) d.matchedMs = now;
        else if (!d.loggedNoMatch && d.cfg.enabled && !g_tracked.empty()) {
            LogFileOnly("%s: no texture with its marker among %zu tracked (is the hook installed and the cockpit loaded?)", d.id.c_str(), g_tracked.size());
            d.loggedNoMatch = true;
        }
    }
}

// Region of the texture a display occupies, clamped. Returns false if too small.
bool DisplayRegion(const Display& d, const D3D12_RESOURCE_DESC& desc, D3D12_BOX& box) {
    UINT x0 = UINT(d.cfg.readX), y0 = UINT(d.cfg.readY);
    UINT texW = UINT(desc.Width), texH = desc.Height;
    if (x0 + 2 > texW || y0 + 2 > texH) return false;
    UINT w = d.cfg.cropW ? std::min<UINT>(UINT(d.cfg.cropW), texW - x0) : texW - x0;
    UINT h = d.cfg.cropH ? std::min<UINT>(UINT(d.cfg.cropH), texH - y0) : texH - y0;
    if (w < 16 || h < 16) return false;
    box = {x0, y0, 0, x0 + w, y0 + h, 1};
    return true;
}

// Hand finished copies to the encoder; free slots the encoder is done with.
void ServiceSlots(uint64_t completed, uint64_t now) {
    for (size_t di = 0; di < g_displays.size(); ++di) {
        Display& d = *g_displays[di];
        for (Slot& s : d.slots) {
            if (s.state == Slot::Encoding && s.done.load()) s.state = Slot::Free;
            if (s.state == Slot::Copying && completed >= s.fence) {
                s.state = Slot::Copied;
                s.readyMs = now;
            }
            if (s.state == Slot::Copied) {
                EncodeJob j;
                j.display = int(di);
                j.id = d.id;
                j.pixels = s.mapped;
                j.rowPitch = s.rowPitch;
                j.width = s.w;
                j.height = s.h;
                j.bgra = s.bgra;
                memcpy(j.marker, d.cfg.marker, sizeof j.marker);
                j.quality = g_cfg.jpegQuality;
                j.doneFlag = &s.done;
                s.done = 0;
                if (EncoderSubmit(j)) s.state = Slot::Encoding;
                else if (now - s.readyMs > 250) s.state = Slot::Free;  // encoder too busy: drop this one
            }
        }
        int mism = 0;
        EncoderTakeMismatch(int(di), mism);
        if (mism) {
            d.mismatches += mism;
            g_forceProbe = true;
            if (d.mismatches >= 3 && d.mapped) {
                Log("%s: marker missing in %d captured frames; looking for the texture again", d.id.c_str(), d.mismatches);
                d.mapped = nullptr;
                d.mismatches = 0;
            }
        }
    }
}

bool RecordCaptures(ID3D12GraphicsCommandList* list, double nowSec, uint64_t nextFence, int& count) {
    count = 0;
    for (auto& dp : g_displays) {
        Display& d = *dp;
        if (!d.cfg.enabled || d.cfg.maxFps <= 0 || !d.mapped) continue;
        if (nowSec < d.nextCaptureSec) continue;
        const Tracked* t = FindTracked(d.mapped);
        if (!t) {
            d.mapped = nullptr;
            continue;
        }
        Slot* s = nullptr;
        for (Slot& c : d.slots)
            if (c.state == Slot::Free) {
                s = &c;
                break;
            }
        if (!s) continue;  // all buffers busy: skip this frame for this display
        D3D12_BOX box;
        if (!DisplayRegion(d, t->desc, box)) continue;
        int w = int(box.right - box.left), h = int(box.bottom - box.top);
        uint32_t rowPitch = uint32_t(Align(uint64_t(w) * 4, D3D12_TEXTURE_DATA_PITCH_ALIGNMENT));
        uint64_t bytes = uint64_t(rowPitch) * h;
        if (!s->buf || s->capacity < bytes) {
            if (s->buf) {
                s->buf->Unmap(0, nullptr);
                s->buf->Release();
                s->buf = nullptr;
                s->mapped = nullptr;
            }
            s->buf = CreateReadback(bytes);
            if (!s->buf) return false;
            D3D12_RANGE none{0, 0};
            if (FAILED(s->buf->Map(0, &none, (void**)&s->mapped))) {
                s->buf->Release();
                s->buf = nullptr;
                return false;
            }
            s->capacity = bytes;
        }
        D3D12_TEXTURE_COPY_LOCATION dst{};
        dst.pResource = s->buf;
        dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
        dst.PlacedFootprint.Offset = 0;
        dst.PlacedFootprint.Footprint = {t->desc.Format, UINT(w), UINT(h), 1, rowPitch};
        D3D12_TEXTURE_COPY_LOCATION src{};
        src.pResource = d.mapped;
        src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
        src.SubresourceIndex = 0;
        list->CopyTextureRegion(&dst, 0, 0, 0, &src, &box);
        s->state = Slot::Copying;
        s->fence = nextFence;
        s->rowPitch = rowPitch;
        s->w = w;
        s->h = h;
        s->bgra = IsBgra(t->desc.Format);
        const_cast<Tracked*>(t)->lastUseFence = nextFence;
        double interval = 1.0 / d.cfg.maxFps;
        d.nextCaptureSec = std::max(d.nextCaptureSec + interval, nowSec - interval * 0.5);
        d.submitted++;
        ++count;
    }
    return true;
}

// Decide what the barrier hook keeps, from the displays being watched (see g_trackAny).
void UpdateTrackRules(uint64_t now) {
    bool any = false, filter = true;
    std::vector<std::pair<uint64_t, UINT>> sizes;
    for (auto& d : g_displays) {
        if (!d->cfg.enabled || d->cfg.maxFps <= 0) continue;
        any = true;
        // Size unknown, or not found by size for a while (the hook's size may be off): all sizes.
        if (d->cfg.texW <= 0 || d->cfg.texH <= 0 || (!d->mapped && now - d->watchedSinceMs > kSizeTrustMs)) filter = false;
        else sizes.push_back({uint64_t(d->cfg.texW), UINT(d->cfg.texH)});
    }
    std::lock_guard<std::mutex> lock(g_candMutex);
    if (any == g_trackAny && filter == g_sizeFilter && sizes == g_wantSizes) return;
    if (any != g_trackAny) LogFileOnly(any ? "watching displays: tracking textures" : "nothing watched: textures released");
    g_trackAny = any;
    g_sizeFilter = filter;
    g_wantSizes = sizes;
    // Textures rejected under the old rules get looked at again.
    for (auto it = g_seen.begin(); it != g_seen.end();) {
        if (!it->second.accepted) it = g_seen.erase(it);
        else ++it;
    }
    g_forceProbe = true;
}

// Readback buffers of displays nobody has watched for a while are freed (re-created when watched).
void FreeIdleBuffers(uint64_t now) {
    for (auto& d : g_displays) {
        if (d->cfg.enabled) {
            d->idleSinceMs = 0;
            continue;
        }
        if (!d->idleSinceMs) {
            d->idleSinceMs = now;
            continue;
        }
        if (now - d->idleSinceMs < kFreeIdleMs) continue;
        for (Slot& s : d->slots) {
            if (!s.buf || s.state != Slot::Free) continue;
            s.buf->Unmap(0, nullptr);
            s.buf->Release();
            s.buf = nullptr;
            s.mapped = nullptr;
            s.capacity = 0;
            LogFileOnly("%s: not watched; readback buffer freed", d->id.c_str());
        }
    }
}

void RunFrame() {
    std::unique_lock<std::mutex> lock(g_engineMutex, std::try_to_lock);
    if (!lock.owns_lock() || g_disabled || g_released) return;
    ID3D12CommandQueue* queue = g_queue.load();
    if (!queue || g_resourcesFailed) return;
    if (!g_resourcesReady) {
        if (!CreateResources()) {
            Log("could not create capture resources; capture off");
            g_resourcesFailed = true;
            return;
        }
        g_resourcesReady = true;
        LogFileOnly("capture resources created");
    }
    ++g_runFrames;
    uint64_t now = NowMs();
    double nowSec = NowSec();

    uint64_t completed = g_fence->GetCompletedValue();
    if (completed == UINT64_MAX) {
        HRESULT why = g_device->GetDeviceRemovedReason();
        Log("graphics device removed (0x%08lx); capture off", why);
        g_disabled = true;
        return;
    }

    CaptureConfig cfg = GetConfig();
    if (cfg.generation != g_cfg.generation) ApplyConfig(cfg);
    UpdateTrackRules(now);
    FreeIdleBuffers(now);

    if (g_probePending && completed >= g_probeFence) EvaluateProbe(now);
    ServiceSlots(completed, now);

    if (g_shutdown) {
        bool busy = g_probePending;
        for (auto& d : g_displays)
            for (Slot& s : d->slots)
                if (s.state == Slot::Copying || (s.state == Slot::Encoding && !s.done)) busy = true;
        for (Cmd& c : g_cmds)
            if (c.fence > completed) busy = true;
        if (!busy) ReleaseAll();
        return;
    }

    // Capture only with a config and a live host.
    bool hostAlive = cfg.valid && PipeConnected() && now - g_lastHeartbeatMs.load() <= uint64_t(cfg.heartbeatTimeoutMs);
    if (hostAlive != g_wasActive) {
        LogFileOnly(hostAlive ? "host alive: capturing" : "no heartbeat from the host: capture paused");
        g_wasActive = hostAlive;
    }
    if (!hostAlive) return;

    UpdateTracked(now, completed);

    bool anyMissing = false, anyFound = false;
    for (auto& d : g_displays) {
        anyMissing = anyMissing || WantsProbe(*d, false);
        anyFound = anyFound || (WantsProbe(*d, true) && d->mapped);
    }
    bool recheck = anyFound && now - g_lastRecheckMs >= kRecheckMs;
    bool wantProbe = !g_probePending && !g_tracked.empty() &&
                     ((anyMissing && (g_forceProbe ? now - g_lastProbeMs >= 250 : now - g_lastProbeMs >= kReprobeMs)) || recheck);
    bool anyDue = false;
    for (auto& d : g_displays)
        if (d->cfg.enabled && d->mapped && nowSec >= d->nextCaptureSec) anyDue = true;
    if (!wantProbe && !anyDue) return;

    Cmd* cmd = nullptr;
    for (Cmd& c : g_cmds)
        if (c.fence <= completed) {
            cmd = &c;
            break;
        }
    if (!cmd) {
        ++g_skippedNoCmd;
        return;
    }
    if (FAILED(cmd->alloc->Reset()) || FAILED(cmd->list->Reset(cmd->alloc, nullptr))) {
        Log("command list reset failed; capture off");
        g_disabled = true;
        return;
    }
    uint64_t nextFence = g_fenceValue + 1;
    if (wantProbe) {
        RecordProbe(cmd->list, recheck);
        g_probeRechecks = recheck;
        for (Tracked& t : g_tracked) t.lastUseFence = nextFence;
    }
    int copies = 0;
    bool ok = RecordCaptures(cmd->list, nowSec, nextFence, copies);
    cmd->list->Close();
    if (!ok) {
        g_resourcesFailed = true;
        Log("out of GPU memory for readback buffers; capture off");
        return;
    }
    if (g_probeEntries.empty() && wantProbe) wantProbe = false;
    if (!wantProbe && !copies) {
        cmd->fence = 0;
        return;
    }
    ID3D12CommandList* lists[] = {cmd->list};
    g_origExecuteCommandLists(queue, 1, (void* const*)lists);
    queue->Signal(g_fence, nextFence);
    g_fenceValue = nextFence;
    cmd->fence = nextFence;
    if (wantProbe) {
        g_probePending = true;
        g_probeFence = nextFence;
        g_lastProbeMs = now;
        if (g_probeRechecks) g_lastRecheckMs = now;
        g_forceProbe = false;
        ++g_probes;
    }
    g_copies += copies;
}

void PickQueue(uint64_t now) {
    // Called with g_queueMutex held, once the observation time is over.
    QueueSeen* best = nullptr;
    for (int i = 0; i < g_queueCount; ++i)
        if (g_queues[i].direct && (!best || g_queues[i].submits > best->submits)) best = &g_queues[i];
    std::string all;
    for (int i = 0; i < g_queueCount; ++i) {
        char b[96];
        snprintf(b, sizeof b, "%s%p %s x%llu", all.empty() ? "" : ", ", (void*)g_queues[i].q, g_queues[i].direct ? "direct" : "other",
                 (unsigned long long)g_queues[i].submits);
        all += b;
    }
    if (!best) {
        LogFileOnly("no DIRECT queue seen yet (%s)", all.c_str());
        g_firstEclMs = now;  // look again
        return;
    }
    ID3D12Device* dev = nullptr;
    if (FAILED(best->q->GetDevice(IID_PPV_ARGS(&dev)))) return;
    best->q->AddRef();
    g_device = dev;
    g_queue = best->q;
    Log("using queue %p for copies (queues seen: %s)", (void*)best->q, all.c_str());
}

}  // namespace

void OnExecuteCommandLists(ID3D12CommandQueue* q) {
    if (!g_queue.load()) {
        std::lock_guard<std::mutex> lock(g_queueMutex);
        if (!g_queue.load()) {
            uint64_t now = NowMs();
            if (!g_firstEclMs) g_firstEclMs = now;
            int i = 0;
            while (i < g_queueCount && g_queues[i].q != q) ++i;
            if (i == g_queueCount && g_queueCount < 16) {
                g_queues[i].q = q;
                g_queues[i].direct = q->GetDesc().Type == D3D12_COMMAND_LIST_TYPE_DIRECT;
                ++g_queueCount;
            }
            if (i < g_queueCount) g_queues[i].submits++;
            if (now - g_firstEclMs >= kQueuePickMs) PickQueue(now);
        }
        return;
    }
    // Fallback when no Present hook fires (e.g. an unusual swap chain): run from here, ~60 Hz max.
    uint64_t now = NowMs();
    if (now - g_lastPresentMs.load() > 500 && now - g_lastFallbackRunMs.load() >= 16) {
        g_lastFallbackRunMs = now;
        RunFrameTimed();
    }
}

void OnResourceBarrier(UINT count, const D3D12_RESOURCE_BARRIER* barriers) {
    uint64_t now = 0;
    for (UINT i = 0; i < count; ++i) {
        const D3D12_RESOURCE_BARRIER& b = barriers[i];
        if (b.Type != D3D12_RESOURCE_BARRIER_TYPE_TRANSITION || !(b.Transition.StateAfter & D3D12_RESOURCE_STATE_RENDER_TARGET)) continue;
        ID3D12Resource* r = b.Transition.pResource;
        if (!r) continue;
        if (!now) now = NowMs();
        std::lock_guard<std::mutex> lock(g_candMutex);
        ++g_rtTransitions;
        auto it = g_seen.find(r);
        if (it != g_seen.end()) {
            it->second.lastMs = now;
            continue;
        }
        if (g_seen.size() > 8192) continue;  // something is churning textures; skip new ones for now
        if (!g_trackAny) continue;           // nothing watched: keep nothing
        SeenInfo info;
        info.firstMs = info.lastMs = now;
        D3D12_RESOURCE_DESC desc = r->GetDesc();
        info.accepted = Acceptable(desc) && SizeWanted(desc);
        g_seen.emplace(r, info);
        if (info.accepted) {
            r->AddRef();
            g_candidates.push_back(r);
            ++g_accepted;
        }
    }
    g_barrierCalls.fetch_add(1, std::memory_order_relaxed);
}

void OnPresent() {
    g_lastPresentMs = NowMs();
    RunFrameTimed();
}

void StatsTick() {
    EncoderStats es = EncoderGetStats();
    std::string displays;
    size_t tracked = 0;
    uint64_t runFrames, probes, copies, skipped;
    {
        std::lock_guard<std::mutex> lock(g_engineMutex);  // pipe thread: may wait briefly; RunFrame never waits
        tracked = g_tracked.size();
        for (auto& d : g_displays) {
            char b[256];
            const Tracked* t = d->mapped ? FindTracked(d->mapped) : nullptr;
            snprintf(b, sizeof b, "%s\"%s\":{\"enabled\":%s,\"fps\":%g,\"matched\":%s,\"texture\":\"%llux%u\",\"submitted\":%llu}", displays.empty() ? "" : ",",
                     d->id.c_str(), d->cfg.enabled ? "true" : "false", d->cfg.maxFps, t ? "true" : "false", t ? (unsigned long long)t->desc.Width : 0ull,
                     t ? t->desc.Height : 0u, (unsigned long long)d->submitted);
            displays += b;
        }
        runFrames = g_runFrames;
        probes = g_probes;
        copies = g_copies;
        skipped = g_skippedNoCmd;
    }
    double runAvg, runMax;
    {
        std::lock_guard<std::mutex> lock(g_timeMutex);
        runAvg = g_runCount ? g_runMsSum / double(g_runCount) : 0;
        runMax = g_runMsMax;
        g_runMsSum = g_runMsMax = 0;
        g_runCount = 0;
    }
    uint64_t barrierCalls, rt, accepted;
    size_t seen;
    {
        std::lock_guard<std::mutex> lock(g_candMutex);
        barrierCalls = g_barrierCalls.load();
        rt = g_rtTransitions;
        accepted = g_accepted;
        seen = g_seen.size();
    }
    char buf[2048];
    snprintf(buf, sizeof buf,
             "{\"disabled\":%s,\"queue\":%s,\"presentHook\":%s,\"runFrames\":%llu,\"runFrameMsAvg\":%.3f,\"runFrameMsMax\":%.3f,\"barrierCalls\":%llu,\"rtTransitions\":%llu,\"texturesSeen\":%zu,"
             "\"accepted\":%llu,\"tracked\":%zu,\"probes\":%llu,\"copies\":%llu,\"noFreeCmd\":%llu,"
             "\"encoder\":{\"frames\":%llu,\"unchanged\":%llu,\"mismatches\":%llu,\"dropped\":%llu,\"failed\":%llu,\"encodeMsAvg\":%.2f},"
             "\"displays\":{%s}}",
             g_disabled ? "true" : "false", g_queue.load() ? "true" : "false", NowMs() - g_lastPresentMs.load() < 1000 ? "true" : "false",
             (unsigned long long)runFrames, runAvg, runMax, (unsigned long long)barrierCalls, (unsigned long long)rt, seen, (unsigned long long)accepted, tracked,
             (unsigned long long)probes, (unsigned long long)copies, (unsigned long long)skipped, (unsigned long long)es.frames,
             (unsigned long long)es.unchanged, (unsigned long long)es.mismatches, (unsigned long long)es.dropped, (unsigned long long)es.failed,
             es.encodeMsAvg, displays.c_str());
    PipeSendStats(buf);
}
