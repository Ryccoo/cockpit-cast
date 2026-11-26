// cockpitcast-screens.exe: local screens on the sim PC. Started and steered by the host; no window of its
// own beyond the screens.
//
// Each local screen is a borderless window on any part of any monitor (full, a half, or a custom area),
// so for example the PFD and the MFD can share one monitor side by side. A glass display is drawn straight
// from the shared GPU textures cockpitcast-capture.dll fills inside the sim (capture/src/localshare.h):
// no readback, no JPEG, no network.
// Two modes (per window, "onTop" in the windows command; the editor's Screens tab sets it for all):
//   always on top (default)  not in Alt+Tab, in front of every other window and put back above the
//                            taskbar every 2 s, so the taskbar does not cover a cockpit monitor;
//   normal windows           in Alt+Tab and on the taskbar ("CockpitCast · <screen>"); whatever was used
//                            last is in front; clicking one brings all local screens to the front.
// Either way, clicking a screen never takes the keyboard focus from the sim, and right-click offers
// Turn local screens off / Open CockpitCast (the way out when a screen covers what you need).
//
// Host -> viewer (stdin, one JSON object per line):
//   {"type":"windows","windows":[{"id":"1","monitor":1,"area":"left","display":"pfd","fit":"contain","label":"PFD","note":null,"onTop":true}]}
//     area: "full", "left", "right", "top", "bottom", or {"x":0,"y":0,"w":0.5,"h":1} (fractions of the monitor)
//     display: the glass display to draw, or null (the window stays black)
//     fit: "contain" (default; letterbox), "fill" (stretch), "cover" (crop to fill)
//     label, note: shown dimly in the middle while there is no picture (the screen's name; why it is empty)
// Viewer -> host (stdout, one JSON object per line):
//   {"type":"monitors","monitors":[{"index":0,"name":"\\\\.\\DISPLAY1","x":0,"y":0,"w":2560,"h":1440,"primary":true}]}
//   {"type":"stats","windows":[{"id":"1","display":"pfd","frames":1800,"state":"live"}]}   every 5 s
//   {"type":"log","message":"..."}
//   {"type":"action","action":"off"|"open"}   from a screen's right-click menu: turn local screens off,
//                                             or show the CockpitCast window
// The viewer ends when stdin closes (the host is gone).

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>

#include <d2d1.h>
#include <d3d11_1.h>
#include <d3dcompiler.h>
#include <dwrite.h>
#include <dxgi1_2.h>
#include <timeapi.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../../capture/src/json.h"
#include "../../capture/src/localshare.h"

namespace {

const UINT WM_LINE = WM_APP + 1;     // lParam: new std::string (a line from the host)
const UINT WM_HOSTGONE = WM_APP + 2;
const wchar_t* kClass = L"CockpitCastScreen";

// ---------------- output to the host ----------------
std::mutex g_outMutex;
void Out(const std::string& json) {
    std::lock_guard<std::mutex> lock(g_outMutex);
    fwrite(json.data(), 1, json.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}
std::string Esc(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') o += '\\';
        if (static_cast<unsigned char>(c) < 0x20) continue;
        o += c;
    }
    return o;
}
void LogLine(const std::string& m) { Out("{\"type\":\"log\",\"message\":\"" + Esc(m) + "\"}"); }
std::string Narrow(const wchar_t* w) {
    char b[256];
    WideCharToMultiByte(CP_UTF8, 0, w, -1, b, sizeof b, nullptr, nullptr);
    return b;
}

// ---------------- monitors ----------------
struct Monitor {
    RECT rc;
    std::wstring name;
    bool primary;
};
std::vector<Monitor> g_monitors;

BOOL CALLBACK MonitorProc(HMONITOR h, HDC, LPRECT, LPARAM) {
    MONITORINFOEXW mi{};
    mi.cbSize = sizeof mi;
    if (GetMonitorInfoW(h, &mi)) g_monitors.push_back({mi.rcMonitor, mi.szDevice, (mi.dwFlags & MONITORINFOF_PRIMARY) != 0});
    return TRUE;
}

void ReadMonitors() {
    g_monitors.clear();
    EnumDisplayMonitors(nullptr, nullptr, MonitorProc, 0);
    std::string j = "{\"type\":\"monitors\",\"monitors\":[";
    for (size_t i = 0; i < g_monitors.size(); ++i) {
        const auto& m = g_monitors[i];
        char b[384];
        snprintf(b, sizeof b, "%s{\"index\":%zu,\"name\":\"%s\",\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld,\"primary\":%s}", i ? "," : "", i,
                 Esc(Narrow(m.name.c_str())).c_str(), m.rc.left, m.rc.top, m.rc.right - m.rc.left, m.rc.bottom - m.rc.top, m.primary ? "true" : "false");
        j += b;
    }
    Out(j + "]}");
}

// ---------------- shared block from the DLL ----------------
HANDLE g_map = nullptr;
localshare::Header* g_share = nullptr;

bool ShareOk() {
    if (!g_share) {
        g_map = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, localshare::kMapName);
        if (!g_map) return false;
        g_share = static_cast<localshare::Header*>(MapViewOfFile(g_map, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(localshare::Header)));
        if (!g_share) {
            CloseHandle(g_map);
            g_map = nullptr;
            return false;
        }
    }
    return g_share->magic == localshare::kMagic && g_share->version == localshare::kVersion &&
           GetTickCount() - static_cast<DWORD>(g_share->heartbeat) < 3000;
}

int FindEntry(const std::string& id) {
    if (!g_share) return -1;
    for (int i = 0; i < localshare::kMaxDisplays; ++i) {
        const auto& e = g_share->displays[i];
        if (e.active && id == std::string(e.id, strnlen(e.id, sizeof e.id))) return i;
    }
    return -1;
}

// ---------------- D3D11 ----------------
ID3D11Device* g_dev = nullptr;
ID3D11Device1* g_dev1 = nullptr;
ID3D11DeviceContext* g_ctx = nullptr;
IDXGIFactory2* g_factory = nullptr;
LUID g_devLuid{};
ID3D11VertexShader* g_vs = nullptr;
ID3D11PixelShader* g_ps = nullptr;
ID3D11SamplerState* g_sampler = nullptr;

const char* kShader = R"(
Texture2D tex : register(t0);
SamplerState smp : register(s0);
cbuffer C : register(b0) { float4 uv; };   // xy: offset, zw: scale (for "cover")
struct V { float4 pos : SV_Position; float2 uv : TEXCOORD; };
V vs(uint id : SV_VertexID) {
  V o; float2 p = float2((id << 1) & 2, id & 2);
  o.pos = float4(p * float2(2, -2) + float2(-1, 1), 0, 1); o.uv = uv.xy + p * uv.zw; return o;
}
float4 ps(V i) : SV_Target { return float4(tex.Sample(smp, i.uv).rgb, 1); }
)";
ID3D11Buffer* g_cb = nullptr;
ID2D1Factory* g_d2d = nullptr;
IDWriteFactory* g_dwrite = nullptr;

void ReleaseDevice();

bool CreateDevice(const LUID* want) {
    ReleaseDevice();
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&g_factory)))) return false;
    IDXGIAdapter1* adapter = nullptr;
    if (want) {
        IDXGIAdapter1* a = nullptr;
        for (UINT i = 0; g_factory->EnumAdapters1(i, &a) != DXGI_ERROR_NOT_FOUND; ++i) {
            DXGI_ADAPTER_DESC1 d;
            a->GetDesc1(&d);
            if (d.AdapterLuid.LowPart == want->LowPart && d.AdapterLuid.HighPart == want->HighPart) {
                adapter = a;
                break;
            }
            a->Release();
        }
    }
    D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0};
    HRESULT hr = D3D11CreateDevice(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels,
                                   ARRAYSIZE(levels), D3D11_SDK_VERSION, &g_dev, nullptr, &g_ctx);
    if (adapter) adapter->Release();
    if (FAILED(hr)) {
        LogLine("cannot create a Direct3D 11 device");
        return false;
    }
    g_dev->QueryInterface(IID_PPV_ARGS(&g_dev1));
    IDXGIDevice* dx = nullptr;
    if (SUCCEEDED(g_dev->QueryInterface(IID_PPV_ARGS(&dx)))) {
        IDXGIAdapter* a = nullptr;
        if (SUCCEEDED(dx->GetAdapter(&a))) {
            DXGI_ADAPTER_DESC d;
            a->GetDesc(&d);
            g_devLuid = d.AdapterLuid;
            a->Release();
        }
        dx->Release();
    }
    ID3DBlob *vsb = nullptr, *psb = nullptr, *err = nullptr;
    if (FAILED(D3DCompile(kShader, strlen(kShader), nullptr, nullptr, nullptr, "vs", "vs_4_0", 0, 0, &vsb, &err)) ||
        FAILED(D3DCompile(kShader, strlen(kShader), nullptr, nullptr, nullptr, "ps", "ps_4_0", 0, 0, &psb, &err))) {
        LogLine(err ? static_cast<const char*>(err->GetBufferPointer()) : "shader compile failed");
        return false;
    }
    g_dev->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &g_vs);
    g_dev->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &g_ps);
    vsb->Release();
    psb->Release();
    D3D11_SAMPLER_DESC sd{};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    g_dev->CreateSamplerState(&sd, &g_sampler);
    D3D11_BUFFER_DESC bd{};
    bd.ByteWidth = 16;
    bd.Usage = D3D11_USAGE_DYNAMIC;
    bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    bd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    g_dev->CreateBuffer(&bd, nullptr, &g_cb);
    return g_vs && g_ps && g_sampler && g_cb && g_dev1;
}

// ---------------- the sim's textures, opened by name ----------------
struct Opened {
    long gen = -1;
    UINT w = 0, h = 0;
    ID3D11ShaderResourceView* srv[localshare::kSlots] = {};
    void Release() {
        for (auto*& s : srv)
            if (s) {
                s->Release();
                s = nullptr;
            }
        gen = -1;
    }
};
std::map<int, Opened> g_opened;  // by entry index

DXGI_FORMAT Unorm(uint32_t typeless) {
    return typeless == DXGI_FORMAT_B8G8R8A8_TYPELESS ? DXGI_FORMAT_B8G8R8A8_UNORM : DXGI_FORMAT_R8G8B8A8_UNORM;
}

Opened* OpenEntry(int entry) {
    auto& e = g_share->displays[entry];
    Opened& o = g_opened[entry];
    long gen = e.gen;
    if (o.gen == gen) return &o;
    o.Release();
    for (int k = 0; k < localshare::kSlots; ++k) {
        ID3D11Texture2D* tex = nullptr;
        HRESULT hr = g_dev1->OpenSharedResourceByName(e.names[k], DXGI_SHARED_RESOURCE_READ, IID_PPV_ARGS(&tex));
        if (FAILED(hr)) {
            char b[160];
            snprintf(b, sizeof b, "cannot open the shared texture for %s (0x%08lx)", e.id, hr);
            LogLine(b);
            o.Release();
            return nullptr;
        }
        D3D11_SHADER_RESOURCE_VIEW_DESC vd{};
        vd.Format = Unorm(e.dxgiFormat);
        vd.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
        vd.Texture2D.MipLevels = 1;
        hr = g_dev->CreateShaderResourceView(tex, &vd, &o.srv[k]);
        tex->Release();
        if (FAILED(hr)) {
            o.Release();
            return nullptr;
        }
    }
    if (e.gen != gen) {  // changed while opening: try again next time
        o.Release();
        return nullptr;
    }
    o.gen = gen;
    o.w = e.width;
    o.h = e.height;
    return &o;
}

// ---------------- screen windows ----------------
struct Screen {
    std::string id, display, fit = "contain", label, note;
    std::wstring drawnText;  // the waiting text last drawn
    bool onTop = true;        // always on top (else a normal window); see the top of this file
    int monitor = 0;
    double ax = 0, ay = 0, aw = 1, ah = 1;  // area, fractions of the monitor
    HWND hwnd = nullptr;
    IDXGISwapChain1* chain = nullptr;
    ID3D11RenderTargetView* rtv = nullptr;
    UINT bw = 0, bh = 0;
    long drawnSeq = -1, drawnGen = -1;
    bool dirty = true;
    uint64_t frames = 0;
};
std::vector<std::unique_ptr<Screen>> g_screens;

void ReleaseTarget(Screen& s) {
    if (s.rtv) s.rtv->Release();
    s.rtv = nullptr;
}
void ReleaseChain(Screen& s) {
    ReleaseTarget(s);
    if (s.chain) s.chain->Release();
    s.chain = nullptr;
}

void ReleaseDevice() {
    if (g_d2d) g_d2d->Release();
    g_d2d = nullptr;
    for (auto& [k, o] : g_opened) o.Release();
    g_opened.clear();
    for (auto& s : g_screens)
        if (s) ReleaseChain(*s);
    for (IUnknown** p : {(IUnknown**)&g_vs, (IUnknown**)&g_ps, (IUnknown**)&g_sampler, (IUnknown**)&g_cb, (IUnknown**)&g_dev1, (IUnknown**)&g_ctx,
                         (IUnknown**)&g_dev, (IUnknown**)&g_factory})
        if (*p) {
            (*p)->Release();
            *p = nullptr;
        }
}

// All local screens to the front, without activating them: normal windows in front of the other normal
// windows; always-on-top ones above the other topmost windows, the taskbar included.
void RaiseScreens() {
    for (auto& s : g_screens)
        if (s && s->hwnd) SetWindowPos(s->hwnd, s->onTop ? HWND_TOPMOST : HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_MOUSEACTIVATE:
            RaiseScreens();        // a click brings the local screens to the front...
            return MA_NOACTIVATE;  // ...without taking the keyboard focus from the sim
        case WM_RBUTTONUP: {  // the way out: turn local screens off, or open CockpitCast
            HMENU m = CreatePopupMenu();
            AppendMenuW(m, MF_STRING, 1, L"Turn local screens off");
            AppendMenuW(m, MF_STRING, 2, L"Open CockpitCast");
            POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
            ClientToScreen(h, &pt);
            SetForegroundWindow(h);  // so the menu closes when clicking elsewhere
            UINT cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, pt.x, pt.y, 0, h, nullptr);
            DestroyMenu(m);
            if (cmd == 1) Out("{\"type\":\"action\",\"action\":\"off\"}");
            else if (cmd == 2) AllowSetForegroundWindow(ASFW_ANY), Out("{\"type\":\"action\",\"action\":\"open\"}");
            return 0;
        }
        case WM_ERASEBKGND:
            return 1;
        case WM_SIZE:
            for (auto& s : g_screens)
                if (s && s->hwnd == h) s->dirty = true;
            return 0;
        case WM_DISPLAYCHANGE:
            PostMessageW(nullptr, WM_DISPLAYCHANGE, 0, 0);
            return 0;
        case WM_CLOSE:
            return 0;  // only the host decides
    }
    return DefWindowProcW(h, msg, wp, lp);
}

RECT AreaRect(const Screen& s) {
    RECT m = s.monitor >= 0 && s.monitor < (int)g_monitors.size() ? g_monitors[s.monitor].rc : g_monitors.empty() ? RECT{0, 0, 800, 600} : g_monitors[0].rc;
    double W = m.right - m.left, H = m.bottom - m.top;
    RECT r;
    r.left = m.left + LONG(std::lround(W * s.ax));
    r.top = m.top + LONG(std::lround(H * s.ay));
    r.right = m.left + LONG(std::lround(W * (s.ax + s.aw)));
    r.bottom = m.top + LONG(std::lround(H * (s.ay + s.ah)));
    return r;
}

void Place(Screen& s) {
    RECT r = AreaRect(s);
    if (!s.hwnd) {
        // Always on top: a tool window (not in Alt+Tab) above everything. Normal: in Alt+Tab and on the
        // taskbar (APPWINDOW: NOACTIVATE alone would hide it there).
        DWORD ex = s.onTop ? WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST : WS_EX_APPWINDOW | WS_EX_NOACTIVATE;
        s.hwnd = CreateWindowExW(ex, kClass, L"CockpitCast screen", WS_POPUP, r.left, r.top, r.right - r.left, r.bottom - r.top,
                                 nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
        ShowWindow(s.hwnd, SW_SHOWNOACTIVATE);
    } else {
        SetWindowPos(s.hwnd, s.onTop ? HWND_TOPMOST : nullptr, r.left, r.top, r.right - r.left, r.bottom - r.top, (s.onTop ? 0 : SWP_NOZORDER) | SWP_NOACTIVATE);
    }
    s.dirty = true;
}

bool EnsureChain(Screen& s) {
    RECT cr;
    GetClientRect(s.hwnd, &cr);
    UINT w = UINT(std::max<LONG>(1, cr.right)), h = UINT(std::max<LONG>(1, cr.bottom));
    if (!s.chain) {
        DXGI_SWAP_CHAIN_DESC1 d{};
        d.Width = w;
        d.Height = h;
        d.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        d.SampleDesc.Count = 1;
        d.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        d.BufferCount = 2;
        d.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
        if (FAILED(g_factory->CreateSwapChainForHwnd(g_dev, s.hwnd, &d, nullptr, nullptr, &s.chain))) return false;
        g_factory->MakeWindowAssociation(s.hwnd, DXGI_MWA_NO_ALT_ENTER);
        s.bw = w;
        s.bh = h;
    } else if (w != s.bw || h != s.bh) {
        ReleaseTarget(s);
        if (FAILED(s.chain->ResizeBuffers(0, w, h, DXGI_FORMAT_UNKNOWN, 0))) return false;
        s.bw = w;
        s.bh = h;
    }
    if (!s.rtv) {
        ID3D11Texture2D* bb = nullptr;
        if (FAILED(s.chain->GetBuffer(0, IID_PPV_ARGS(&bb)))) return false;
        g_dev->CreateRenderTargetView(bb, nullptr, &s.rtv);
        bb->Release();
    }
    return s.rtv != nullptr;
}

// Draw the screen's display (or black). Returns false if the device is gone.
bool Draw(Screen& s, ID3D11ShaderResourceView* srv, UINT tw, UINT th) {
    if (!EnsureChain(s)) return true;
    float black[4] = {0, 0, 0, 1};
    g_ctx->OMSetRenderTargets(1, &s.rtv, nullptr);
    g_ctx->ClearRenderTargetView(s.rtv, black);
    if (srv && tw && th) {
        float W = float(s.bw), H = float(s.bh), k = 1, ux = 0, uy = 0, us = 1, vs = 1;
        float vx = 0, vy = 0, vw = W, vh = H;
        if (s.fit == "contain" || s.fit.empty()) {
            k = std::min(W / tw, H / th);
            vw = tw * k;
            vh = th * k;
            vx = (W - vw) / 2;
            vy = (H - vh) / 2;
        } else if (s.fit == "cover") {
            k = std::max(W / tw, H / th);
            us = W / (tw * k);
            vs = H / (th * k);
            ux = (1 - us) / 2;
            uy = (1 - vs) / 2;
        }
        D3D11_VIEWPORT vp{vx, vy, vw, vh, 0, 1};
        g_ctx->RSSetViewports(1, &vp);
        D3D11_MAPPED_SUBRESOURCE m;
        if (SUCCEEDED(g_ctx->Map(g_cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) {
            float c[4] = {ux, uy, us, vs};
            memcpy(m.pData, c, sizeof c);
            g_ctx->Unmap(g_cb, 0);
        }
        g_ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        g_ctx->IASetInputLayout(nullptr);
        g_ctx->VSSetShader(g_vs, nullptr, 0);
        g_ctx->VSSetConstantBuffers(0, 1, &g_cb);
        g_ctx->PSSetShader(g_ps, nullptr, 0);
        g_ctx->PSSetShaderResources(0, 1, &srv);
        g_ctx->PSSetSamplers(0, 1, &g_sampler);
        g_ctx->Draw(3, 0);
        ID3D11ShaderResourceView* none = nullptr;
        g_ctx->PSSetShaderResources(0, 1, &none);
    }
    HRESULT hr = s.chain->Present(0, 0);
    return hr != DXGI_ERROR_DEVICE_REMOVED && hr != DXGI_ERROR_DEVICE_RESET;
}

// ---------------- waiting text (Direct2D / DirectWrite on the swap chain's buffer) ----------------

std::wstring Wide(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), nullptr, 0);
    std::wstring w(size_t(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), int(s.size()), w.data(), n);
    return w;
}

// Black, with the screen's name and a dim line saying why there is no picture, in the middle.
bool DrawWaiting(Screen& s, const std::wstring& title, const std::wstring& line) {
    if (!EnsureChain(s)) return true;
    float black[4] = {0, 0, 0, 1};
    g_ctx->ClearRenderTargetView(s.rtv, black);
    g_ctx->Flush();
    if (!g_d2d) D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, &g_d2d);
    if (!g_dwrite) DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), reinterpret_cast<IUnknown**>(&g_dwrite));
    IDXGISurface* surface = nullptr;
    if (g_d2d && g_dwrite && SUCCEEDED(s.chain->GetBuffer(0, IID_PPV_ARGS(&surface)))) {
        D2D1_RENDER_TARGET_PROPERTIES rp = D2D1::RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_IGNORE), 96, 96);
        ID2D1RenderTarget* rt = nullptr;
        HRESULT hrRt = g_d2d->CreateDxgiSurfaceRenderTarget(surface, &rp, &rt);
        if (FAILED(hrRt)) {
            char b[96];
            snprintf(b, sizeof b, "waiting text: no Direct2D target (0x%08lx)", hrRt);
            LogLine(b);
        }
        if (SUCCEEDED(hrRt)) {
            float W = float(s.bw), H = float(s.bh);
            float big = std::clamp(std::min(W, H) * 0.07f, 12.0f, 48.0f), note = std::clamp(big * 0.55f, 10.0f, 24.0f);
            IDWriteTextFormat *f1 = nullptr, *f2 = nullptr;
            g_dwrite->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, big, L"", &f1);
            g_dwrite->CreateTextFormat(L"Segoe UI", nullptr, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, note, L"", &f2);
            ID2D1SolidColorBrush *b1 = nullptr, *b2 = nullptr;
            rt->CreateSolidColorBrush(D2D1::ColorF(0.55f, 0.6f, 0.65f), &b1);
            rt->CreateSolidColorBrush(D2D1::ColorF(0.38f, 0.42f, 0.46f), &b2);
            rt->BeginDraw();
            if (f1 && f2 && b1 && b2) {
                for (IDWriteTextFormat* f : {f1, f2}) {
                    f->SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
                    f->SetWordWrapping(DWRITE_WORD_WRAPPING_WRAP);
                }
                float pad = W * 0.06f, mid = H / 2;
                rt->DrawText(title.c_str(), UINT32(title.size()), f1, D2D1::RectF(pad, mid - big * 1.5f, W - pad, mid), b1);
                rt->DrawText(line.c_str(), UINT32(line.size()), f2, D2D1::RectF(pad, mid + note * 0.3f, W - pad, H - pad), b2);
            }
            HRESULT hrEnd = rt->EndDraw();
            if (FAILED(hrEnd)) {
                char b[96];
                snprintf(b, sizeof b, "waiting text: drawing failed (0x%08lx)", hrEnd);
                LogLine(b);
            }
            for (IUnknown* u : std::initializer_list<IUnknown*>{f1, f2, b1, b2, rt})
                if (u) u->Release();
        }
        surface->Release();
    }
    HRESULT hr = s.chain->Present(0, 0);
    return hr != DXGI_ERROR_DEVICE_REMOVED && hr != DXGI_ERROR_DEVICE_RESET;
}

// What an empty screen says: the sim is not there yet, its display has no picture yet, or the host's note.
std::wstring WaitingLine(const Screen& s, bool share) {
    if (!s.note.empty()) return Wide(s.note);
    if (s.display.empty()) return L"Nothing to show";
    if (!share) return L"Waiting for MSFS";
    std::string d = s.display;
    for (auto& c : d) c = char(toupper(static_cast<unsigned char>(c)));
    return L"Waiting for the " + Wide(d);
}

// One pass over all screens: draw those with a new frame (or a new size). Returns false: recreate the device.
bool Tick() {
    bool share = ShareOk();
    if (share) {
        LUID want{g_share->adapterLuidLow, g_share->adapterLuidHigh};
        if (want.LowPart != g_devLuid.LowPart || want.HighPart != g_devLuid.HighPart) {
            LogLine("using the sim's graphics card for local screens");
            if (!CreateDevice(&want)) return true;
            for (auto& s : g_screens)
                if (s) s->dirty = true;
        }
    }
    if (!g_dev) return CreateDevice(nullptr);
    for (auto& sp : g_screens) {
        if (!sp) continue;
        Screen& s = *sp;
        int entry = share && !s.display.empty() ? FindEntry(s.display) : -1;
        if (entry >= 0 && g_share->displays[entry].latest < 0) entry = -1;  // set up, no picture yet
        if (entry < 0) {
            std::wstring title = Wide(s.label.empty() ? "Screen " + s.id : s.label);
            std::wstring line = WaitingLine(s, share);
            if (s.dirty || s.drawnSeq != -1 || s.drawnText != title + L"\n" + line) {  // nothing to show: say why
                if (!DrawWaiting(s, title, line)) return false;
                s.dirty = false;
                s.drawnSeq = -1;
                s.drawnText = title + L"\n" + line;
            }
            continue;
        }
        s.drawnText.clear();
        auto& e = g_share->displays[entry];
        long seq = e.seq;
        if (!s.dirty && seq == s.drawnSeq && e.gen == s.drawnGen) continue;
        Opened* o = OpenEntry(entry);
        if (!o) continue;
        // Claim the newest slot: tell the DLL first, then check it is still the newest.
        long slot = -1;
        for (int tries = 0; tries < 3; ++tries) {
            slot = e.latest;
            if (slot < 0) break;
            InterlockedExchange(&e.reading, slot);
            if (e.latest == slot) break;
        }
        if (slot < 0 || slot >= localshare::kSlots) continue;
        if (!Draw(s, o->srv[slot], o->w, o->h)) return false;
        s.drawnSeq = seq;
        s.drawnGen = o->gen;
        s.dirty = false;
        ++s.frames;
    }
    return true;
}

void ApplyWindows(const JValue& list) {
    std::vector<std::unique_ptr<Screen>> next;
    for (size_t i = 0; i < list.size(); ++i) {
        const JValue& w = list[i];
        std::string id = w["id"].asString();
        if (id.empty()) continue;
        std::unique_ptr<Screen> s;
        for (auto& old : g_screens)
            if (old && old->id == id) s = std::move(old);
        if (!s) {
            s = std::make_unique<Screen>();
            s->id = id;
        }
        s->monitor = w["monitor"].asInt(0);
        const JValue& a = w["area"];
        std::string area = a.asString();
        s->ax = 0, s->ay = 0, s->aw = 1, s->ah = 1;
        if (area == "left") s->aw = 0.5;
        else if (area == "right") s->ax = 0.5, s->aw = 0.5;
        else if (area == "top") s->ah = 0.5;
        else if (area == "bottom") s->ay = 0.5, s->ah = 0.5;
        else if (a.type == JValue::Object) {
            s->ax = std::clamp(a["x"].asDouble(0), 0.0, 1.0);
            s->ay = std::clamp(a["y"].asDouble(0), 0.0, 1.0);
            s->aw = std::clamp(a["w"].asDouble(1), 0.05, 1.0 - s->ax);
            s->ah = std::clamp(a["h"].asDouble(1), 0.05, 1.0 - s->ay);
        }
        bool onTop = w["onTop"].asBool(true);
        if (s->hwnd && onTop != s->onTop) {  // another mode: a new window with the other style
            ReleaseChain(*s);
            DestroyWindow(s->hwnd);
            s->hwnd = nullptr;
            s->drawnSeq = -1;
            s->drawnText.clear();
        }
        s->onTop = onTop;
        s->display = w["display"].asString();
        s->fit = w["fit"].asString();
        s->label = w["label"].asString();
        s->note = w["note"].asString();
        Place(*s);
        SetWindowTextW(s->hwnd, (L"CockpitCast \u00b7 " + Wide(s->label.empty() ? "Screen " + s->id : s->label)).c_str());
        next.push_back(std::move(s));
    }
    for (auto& old : g_screens)
        if (old) {
            ReleaseChain(*old);
            if (old->hwnd) DestroyWindow(old->hwnd);
        }
    g_screens = std::move(next);
}

void OnLine(const std::string& line) {
    JValue j = JParse(line);
    std::string type = j["type"].asString();
    if (type == "windows") ApplyWindows(j["windows"]);
    else if (type == "monitors") ReadMonitors();
}

void SendStats() {
    std::string j = "{\"type\":\"stats\",\"share\":" + std::string(ShareOk() ? "true" : "false") + ",\"windows\":[";
    for (size_t i = 0; i < g_screens.size(); ++i) {
        const Screen& s = *g_screens[i];
        bool live = ShareOk() && !s.display.empty() && FindEntry(s.display) >= 0;
        char b[256];
        snprintf(b, sizeof b, "%s{\"id\":\"%s\",\"display\":\"%s\",\"frames\":%llu,\"state\":\"%s\"}", i ? "," : "", Esc(s.id).c_str(), Esc(s.display).c_str(),
                 (unsigned long long)s.frames, s.display.empty() ? "empty" : live ? "live" : "waiting");
        j += b;
    }
    Out(j + "]}");
}

}  // namespace

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);  // area rectangles in real pixels
    timeBeginPeriod(1);
    WNDCLASSW wc{};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.lpszClassName = kClass;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    RegisterClassW(&wc);
    ReadMonitors();

    DWORD mainThread = GetCurrentThreadId();
    std::thread([mainThread] {
        HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
        std::string buf;
        char chunk[4096];
        DWORD n = 0;
        while (ReadFile(in, chunk, sizeof chunk, &n, nullptr) && n) {
            buf.append(chunk, n);
            size_t nl;
            while ((nl = buf.find('\n')) != std::string::npos) {
                auto* line = new std::string(buf.substr(0, nl));
                buf.erase(0, nl + 1);
                if (!PostThreadMessageW(mainThread, WM_LINE, 0, reinterpret_cast<LPARAM>(line))) delete line;
            }
        }
        PostThreadMessageW(mainThread, WM_HOSTGONE, 0, 0);
    }).detach();

    CreateDevice(nullptr);
    uint64_t nextStats = GetTickCount64() + 5000, nextRaise = GetTickCount64() + 2000;
    for (;;) {
        MSG msg;
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_LINE) {
                auto* line = reinterpret_cast<std::string*>(msg.lParam);
                OnLine(*line);
                delete line;
            } else if (msg.message == WM_HOSTGONE) {
                ReleaseDevice();
                return 0;
            } else if (msg.message == WM_DISPLAYCHANGE && !msg.hwnd) {
                ReadMonitors();
                for (auto& s : g_screens)
                    if (s) Place(*s);
            } else {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if (!Tick()) {
            LogLine("graphics device lost; starting again");
            ReleaseDevice();
            g_devLuid = {};
        }
        // Always-on-top screens back above the taskbar (Windows puts it in front again from time to time).
        if (GetTickCount64() >= nextRaise) {
            nextRaise = GetTickCount64() + 2000;
            for (auto& s : g_screens)
                if (s && s->hwnd && s->onTop) SetWindowPos(s->hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        if (GetTickCount64() >= nextStats) {
            nextStats = GetTickCount64() + 5000;
            SendStats();
        }
        // Poll for new frames about 250 times a second: frames are drawn within ~4 ms of the sim finishing them.
        MsgWaitForMultipleObjects(0, nullptr, FALSE, 4, QS_ALLINPUT);
    }
}
