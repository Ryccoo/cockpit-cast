// panel-sim: a stand-in for MSFS when testing capture.dll.
// Renders, every frame, with plain D3D12 clears:
//   - "PFD" texture 1024x768 RGBA8 with the pfd marker pixels at (0,0),(1,0) and a moving pattern;
//   - "MFD" texture 1024x768 BGRA8 with the mfd marker pixels, changing only once a second
//     (exercises the unchanged-frame path and the BGRA byte order);
//   - two decoy render targets without markers (must never be matched);
// and presents a small window. Panel textures go PIXEL_SHADER_RESOURCE -> RENDER_TARGET -> back, as
// in a real renderer.
//
// Test: start panel-sim.exe, then the host with COCKPIT_LINK_SIM_EXE=panel-sim.exe and
// COCKPIT_LINK_REQUIRE_FLIGHT=0, and watch pfd/mfd in a client.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>

#include <cmath>
#include <cstdio>

namespace {

template <class T>
void Check(HRESULT hr, const char* what, T) {
    if (FAILED(hr)) {
        fprintf(stderr, "%s failed: 0x%08lx\n", what, hr);
        ExitProcess(1);
    }
}
#define CHECK(x) Check((x), #x, 0)

struct Panel {
    ID3D12Resource* tex = nullptr;
    D3D12_CPU_DESCRIPTOR_HANDLE rtv{};
    DXGI_FORMAT format;
    UINT w, h;
    float marker[2][4];
};

D3D12_RESOURCE_BARRIER Transition(ID3D12Resource* r, D3D12_RESOURCE_STATES a, D3D12_RESOURCE_STATES b) {
    D3D12_RESOURCE_BARRIER x{};
    x.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    x.Transition.pResource = r;
    x.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    x.Transition.StateBefore = a;
    x.Transition.StateAfter = b;
    return x;
}

LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_DESTROY) {
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(h, m, w, l);
}

void Rgb(float out[4], int r, int g, int b) {
    out[0] = r / 255.0f;
    out[1] = g / 255.0f;
    out[2] = b / 255.0f;
    out[3] = 1.0f;
}

}  // namespace

int main() {
    printf("panel-sim pid %lu: rendering fake PFD (RGBA) and MFD (BGRA) panels. Close the window to quit.\n", GetCurrentProcessId());
    fflush(stdout);
    HINSTANCE inst = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc{sizeof wc};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.lpszClassName = L"PanelSim";
    RegisterClassExW(&wc);
    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"panel-sim (Cockpit Link test)", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 100, 100, 640, 360, nullptr, nullptr, inst, nullptr);

    ID3D12Device* dev;
    CHECK(D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&dev)));
    D3D12_COMMAND_QUEUE_DESC qd{};
    qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    ID3D12CommandQueue* queue;
    CHECK(dev->CreateCommandQueue(&qd, IID_PPV_ARGS(&queue)));
    // A second, mostly idle queue, like the extra queues a real game has: the DLL must pick the busy one.
    qd.Type = D3D12_COMMAND_LIST_TYPE_COMPUTE;
    ID3D12CommandQueue* idleQueue;
    CHECK(dev->CreateCommandQueue(&qd, IID_PPV_ARGS(&idleQueue)));

    IDXGIFactory4* factory;
    CHECK(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)));
    DXGI_SWAP_CHAIN_DESC1 sd{};
    sd.Width = 640;
    sd.Height = 360;
    sd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.SampleDesc.Count = 1;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.BufferCount = 2;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    IDXGISwapChain1* sc1;
    CHECK(factory->CreateSwapChainForHwnd(queue, hwnd, &sd, nullptr, nullptr, &sc1));
    IDXGISwapChain3* sc;
    CHECK(sc1->QueryInterface(IID_PPV_ARGS(&sc)));

    D3D12_DESCRIPTOR_HEAP_DESC hd{};
    hd.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    hd.NumDescriptors = 8;
    ID3D12DescriptorHeap* heap;
    CHECK(dev->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&heap)));
    UINT inc = dev->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    D3D12_CPU_DESCRIPTOR_HANDLE base = heap->GetCPUDescriptorHandleForHeapStart();
    auto handle = [&](int i) { D3D12_CPU_DESCRIPTOR_HANDLE h = base; h.ptr += SIZE_T(i) * inc; return h; };

    ID3D12Resource* back[2];
    for (int i = 0; i < 2; ++i) {
        CHECK(sc->GetBuffer(i, IID_PPV_ARGS(&back[i])));
        dev->CreateRenderTargetView(back[i], nullptr, handle(i));
    }

    auto makeTex = [&](DXGI_FORMAT f, UINT w, UINT h, int slot, D3D12_CPU_DESCRIPTOR_HANDLE& rtv) {
        D3D12_HEAP_PROPERTIES hp{};
        hp.Type = D3D12_HEAP_TYPE_DEFAULT;
        D3D12_RESOURCE_DESC rd{};
        rd.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
        rd.Width = w;
        rd.Height = h;
        rd.DepthOrArraySize = 1;
        rd.MipLevels = 1;
        rd.Format = f;
        rd.SampleDesc.Count = 1;
        rd.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;
        ID3D12Resource* t;
        CHECK(dev->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_NONE, &rd, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, nullptr, IID_PPV_ARGS(&t)));
        rtv = handle(slot);
        dev->CreateRenderTargetView(t, nullptr, rtv);
        return t;
    };

    Panel panels[2];
    panels[0].format = DXGI_FORMAT_R8G8B8A8_UNORM;
    panels[1].format = DXGI_FORMAT_B8G8R8A8_UNORM;
    Rgb(panels[0].marker[0], 201, 13, 77);
    Rgb(panels[0].marker[1], 17, 190, 233);
    Rgb(panels[1].marker[0], 77, 201, 13);
    Rgb(panels[1].marker[1], 233, 17, 190);
    for (int i = 0; i < 2; ++i) {
        panels[i].w = 1024;
        panels[i].h = 768;
        panels[i].tex = makeTex(panels[i].format, 1024, 768, 2 + i, panels[i].rtv);
    }
    D3D12_CPU_DESCRIPTOR_HANDLE decoyRtv[2];
    ID3D12Resource* decoys[2] = {makeTex(DXGI_FORMAT_R8G8B8A8_UNORM, 1024, 768, 4, decoyRtv[0]), makeTex(DXGI_FORMAT_B8G8R8A8_UNORM, 512, 512, 5, decoyRtv[1])};

    ID3D12CommandAllocator* alloc;
    CHECK(dev->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&alloc)));
    ID3D12GraphicsCommandList* list;
    CHECK(dev->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, alloc, nullptr, IID_PPV_ARGS(&list)));
    list->Close();
    ID3D12Fence* fence;
    CHECK(dev->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence)));
    HANDLE fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    UINT64 fenceValue = 0;
    ID3D12Fence* idleFence;
    CHECK(dev->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&idleFence)));

    LARGE_INTEGER freq, t0, t;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&t0);
    unsigned frame = 0;
    MSG msg{};
    while (msg.message != WM_QUIT) {
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (msg.message == WM_QUIT) break;
        QueryPerformanceCounter(&t);
        double sec = double(t.QuadPart - t0.QuadPart) / double(freq.QuadPart);

        CHECK(alloc->Reset());
        CHECK(list->Reset(alloc, nullptr));
        D3D12_RESOURCE_BARRIER toRt[4];
        for (int i = 0; i < 2; ++i) toRt[i] = Transition(panels[i].tex, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_RENDER_TARGET);
        for (int i = 0; i < 2; ++i) toRt[2 + i] = Transition(decoys[i], D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, D3D12_RESOURCE_STATE_RENDER_TARGET);
        list->ResourceBarrier(4, toRt);

        for (int i = 0; i < 2; ++i) {
            Panel& p = panels[i];
            // PFD animates every frame; MFD only changes once a second.
            double tt = i == 0 ? sec : std::floor(sec);
            float bg[4] = {0.05f, 0.10f + 0.05f * float(i), 0.20f + 0.10f * float(std::sin(tt * 0.7) * 0.5 + 0.5), 1.0f};
            list->ClearRenderTargetView(p.rtv, bg, 0, nullptr);
            // A moving vertical bar and a horizontal band, so motion is visible in the stream.
            LONG x = LONG((std::sin(tt * 1.3) * 0.5 + 0.5) * (p.w - 80));
            LONG y = LONG((std::cos(tt * 0.9) * 0.5 + 0.5) * (p.h - 40));
            D3D12_RECT bar{x, 0, x + 80, LONG(p.h)};
            D3D12_RECT band{0, y, LONG(p.w), y + 40};
            float white[4] = {0.9f, 0.9f, 0.9f, 1.0f};
            float yellow[4] = {1.0f, 0.83f, 0.0f, 1.0f};
            list->ClearRenderTargetView(p.rtv, white, 1, &bar);
            list->ClearRenderTargetView(p.rtv, yellow, 1, &band);
            // Grid every 128 px.
            float grid[4] = {0.3f, 0.3f, 0.3f, 1.0f};
            for (LONG gx = 128; gx < LONG(p.w); gx += 128) {
                D3D12_RECT r{gx, 0, gx + 1, LONG(p.h)};
                list->ClearRenderTargetView(p.rtv, grid, 1, &r);
            }
            for (LONG gy = 128; gy < LONG(p.h); gy += 128) {
                D3D12_RECT r{0, gy, LONG(p.w), gy + 1};
                list->ClearRenderTargetView(p.rtv, grid, 1, &r);
            }
            // Marker pixels, exactly as the Community hook paints them.
            D3D12_RECT m0{0, 0, 1, 1}, m1{1, 0, 2, 1};
            list->ClearRenderTargetView(p.rtv, p.marker[0], 1, &m0);
            list->ClearRenderTargetView(p.rtv, p.marker[1], 1, &m1);
        }
        float decoyColor[4] = {0.5f, 0.2f, 0.1f, 1.0f};
        for (auto& r : decoyRtv) list->ClearRenderTargetView(r, decoyColor, 0, nullptr);

        D3D12_RESOURCE_BARRIER toSrv[4];
        for (int i = 0; i < 4; ++i) toSrv[i] = Transition(toRt[i].Transition.pResource, D3D12_RESOURCE_STATE_RENDER_TARGET, D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
        list->ResourceBarrier(4, toSrv);

        UINT bi = sc->GetCurrentBackBufferIndex();
        D3D12_RESOURCE_BARRIER b1 = Transition(back[bi], D3D12_RESOURCE_STATE_PRESENT, D3D12_RESOURCE_STATE_RENDER_TARGET);
        list->ResourceBarrier(1, &b1);
        float clear[4] = {0.1f, 0.1f, 0.12f, 1.0f};
        list->ClearRenderTargetView(handle(int(bi)), clear, 0, nullptr);
        D3D12_RESOURCE_BARRIER b2 = Transition(back[bi], D3D12_RESOURCE_STATE_RENDER_TARGET, D3D12_RESOURCE_STATE_PRESENT);
        list->ResourceBarrier(1, &b2);
        CHECK(list->Close());

        ID3D12CommandList* lists[] = {list};
        queue->ExecuteCommandLists(1, lists);
        if (frame % 120 == 0) idleQueue->Signal(idleFence, frame);  // the idle queue sees almost nothing
        CHECK(sc->Present(1, 0));
        CHECK(queue->Signal(fence, ++fenceValue));
        if (fence->GetCompletedValue() < fenceValue) {
            fence->SetEventOnCompletion(fenceValue, fenceEvent);
            WaitForSingleObject(fenceEvent, INFINITE);
        }
        ++frame;
    }
    return 0;
}
