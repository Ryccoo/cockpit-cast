// D3D12/DXGI hooks by function-table (vtable) patching.
//
// The addresses come from throwaway objects: a hidden window, a D3D12 device, queue and command list,
// and a DXGI swap chain. Their implementation classes are the same ones the sim uses, so patching
// their function tables hooks the sim's objects too:
//   ID3D12CommandQueue::ExecuteCommandLists  (slot 10): find the sim's main queue
//   ID3D12GraphicsCommandList::ResourceBarrier (slot 26): spot textures being drawn into
//   IDXGISwapChain::Present (slot 8), IDXGISwapChain1::Present1 (slot 22): once per frame, run capture
//
// Every hook body runs under a structured-exception guard: if our code ever faults, capture is
// switched off for good and the hooks only pass calls through. A thread-local depth counter keeps
// us from re-entering ourselves.

#include "common.h"

#include <d3d12.h>
#include <dxgi1_4.h>

#include <type_traits>

PFN_ECL g_origExecuteCommandLists = nullptr;

namespace {

using PFN_RB = void(STDMETHODCALLTYPE*)(ID3D12GraphicsCommandList*, UINT, const D3D12_RESOURCE_BARRIER*);
using PFN_Present = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);
using PFN_Present1 = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain1*, UINT, UINT, const DXGI_PRESENT_PARAMETERS*);

PFN_RB g_origResourceBarrier = nullptr;
PFN_Present g_origPresent = nullptr;
PFN_Present1 g_origPresent1 = nullptr;

thread_local int t_depth = 0;

// ---- exception guard ----
bool SehCall(void (*fn)(void*), void* ctx) {
    __try {
        fn(ctx);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

template <class F>
void Trampoline(void* p) {
    (*static_cast<F*>(p))();
}

template <class F>
void Guarded(const char* where, F&& f) {
    if (g_disabled || t_depth > 0) return;
    ++t_depth;
    using FT = std::remove_reference_t<F>;
    bool ok = SehCall(&Trampoline<FT>, (void*)&f);
    --t_depth;
    if (!ok && !g_disabled.exchange(true)) Log("exception in the %s hook: capture switched off, the sim continues normally", where);
}

// ---- hooks ----
void STDMETHODCALLTYPE HookExecuteCommandLists(ID3D12CommandQueue* q, UINT n, ID3D12CommandList* const* lists) {
    Guarded("ExecuteCommandLists", [&] { OnExecuteCommandLists(q); });
    g_origExecuteCommandLists(q, n, (void* const*)lists);
}

void STDMETHODCALLTYPE HookResourceBarrier(ID3D12GraphicsCommandList* list, UINT n, const D3D12_RESOURCE_BARRIER* b) {
    Guarded("ResourceBarrier", [&] { OnResourceBarrier(n, b); });
    g_origResourceBarrier(list, n, b);
}

HRESULT STDMETHODCALLTYPE HookPresent(IDXGISwapChain* sc, UINT sync, UINT flags) {
    if (!(flags & DXGI_PRESENT_TEST)) Guarded("Present", [&] { OnPresent(); });
    return g_origPresent(sc, sync, flags);
}

HRESULT STDMETHODCALLTYPE HookPresent1(IDXGISwapChain1* sc, UINT sync, UINT flags, const DXGI_PRESENT_PARAMETERS* p) {
    if (!(flags & DXGI_PRESENT_TEST)) Guarded("Present1", [&] { OnPresent(); });
    return g_origPresent1(sc, sync, flags, p);
}

bool Patch(void** vtable, int index, void* hook, void** original, const char* name) {
    if (vtable[index] == hook) return true;  // already ours
    DWORD old = 0;
    if (!VirtualProtect(&vtable[index], sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) {
        Log("cannot unprotect the %s slot (error %lu)", name, GetLastError());
        return false;
    }
    *original = vtable[index];
    // An aligned pointer-sized store is atomic: other threads see either the old or the new function.
    InterlockedExchangePointer(&vtable[index], hook);
    VirtualProtect(&vtable[index], sizeof(void*), old, &old);
    HMODULE mod = nullptr;
    char modName[MAX_PATH] = "?";
    if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCSTR)*original, &mod))
        GetModuleFileNameA(mod, modName, MAX_PATH);
    const char* base = strrchr(modName, '\\');
    LogFileOnly("hooked %s (slot %d); original in %s", name, index, base ? base + 1 : modName);
    return true;
}

template <class T>
void SafeRelease(T*& p) {
    if (p) p->Release();
    p = nullptr;
}

}  // namespace

bool InstallHooks() {
    WNDCLASSEXW wc{sizeof wc};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"CockpitLinkDummy";
    RegisterClassExW(&wc);
    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"", WS_OVERLAPPEDWINDOW, 0, 0, 64, 64, nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd) {
        Log("cannot create the helper window (error %lu)", GetLastError());
        return false;
    }

    ID3D12Device* device = nullptr;
    ID3D12CommandQueue* queue = nullptr;
    ID3D12CommandAllocator* alloc = nullptr;
    ID3D12GraphicsCommandList* list = nullptr;
    IDXGIFactory2* factory = nullptr;
    IDXGISwapChain1* swap = nullptr;
    bool ok = false;
    do {
        HRESULT hr = D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device));
        if (FAILED(hr)) { Log("D3D12CreateDevice failed (0x%08lx)", hr); break; }
        D3D12_COMMAND_QUEUE_DESC qd{};
        qd.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
        if (FAILED(hr = device->CreateCommandQueue(&qd, IID_PPV_ARGS(&queue)))) { Log("CreateCommandQueue failed (0x%08lx)", hr); break; }
        if (FAILED(hr = device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&alloc)))) { Log("CreateCommandAllocator failed (0x%08lx)", hr); break; }
        if (FAILED(hr = device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, alloc, nullptr, IID_PPV_ARGS(&list)))) { Log("CreateCommandList failed (0x%08lx)", hr); break; }
        list->Close();
        if (FAILED(hr = CreateDXGIFactory2(0, IID_PPV_ARGS(&factory)))) { Log("CreateDXGIFactory2 failed (0x%08lx)", hr); break; }
        DXGI_SWAP_CHAIN_DESC1 sd{};
        sd.Width = 64;
        sd.Height = 64;
        sd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        sd.SampleDesc.Count = 1;
        sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        sd.BufferCount = 2;
        sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
        if (FAILED(hr = factory->CreateSwapChainForHwnd(queue, hwnd, &sd, nullptr, nullptr, &swap))) { Log("CreateSwapChainForHwnd failed (0x%08lx)", hr); break; }

        void** queueVt = *reinterpret_cast<void***>(queue);
        void** listVt = *reinterpret_cast<void***>(list);
        void** swapVt = *reinterpret_cast<void***>(swap);
        ok = Patch(queueVt, 10, (void*)&HookExecuteCommandLists, (void**)&g_origExecuteCommandLists, "ID3D12CommandQueue::ExecuteCommandLists") &&
             Patch(listVt, 26, (void*)&HookResourceBarrier, (void**)&g_origResourceBarrier, "ID3D12GraphicsCommandList::ResourceBarrier");
        if (!ok) break;
        // Present hooks are not essential: without them capture runs from ExecuteCommandLists.
        if (!Patch(swapVt, 8, (void*)&HookPresent, (void**)&g_origPresent, "IDXGISwapChain::Present") ||
            !Patch(swapVt, 22, (void*)&HookPresent1, (void**)&g_origPresent1, "IDXGISwapChain1::Present1"))
            Log("Present hooks not installed; capture will run from ExecuteCommandLists");
    } while (false);

    SafeRelease(swap);
    SafeRelease(factory);
    SafeRelease(list);
    SafeRelease(alloc);
    SafeRelease(queue);
    SafeRelease(device);
    DestroyWindow(hwnd);
    UnregisterClassW(wc.lpszClassName, wc.hInstance);
    return ok;
}
