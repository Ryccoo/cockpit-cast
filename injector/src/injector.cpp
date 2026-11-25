// cockpit-link-injector: finds the sim process and loads cockpit-link-capture.dll into it.
// Called by the host (host/src/injector.mjs). Prints exactly one JSON line on stdout.
//
//   cockpit-link-injector status --exe FlightSimulator2024.exe
//       {"ok":true,"processes":[{"pid":123,"ours":null}]}
//   cockpit-link-injector inject --pid 123 --dll C:\path\cockpit-link-capture.dll
//       {"ok":true,"pid":123,"module":"C:\\path\\cockpit-link-capture.dll"}
//       {"ok":true,"pid":123,"already":true,"module":"..."}
//       {"ok":false,"error":"...","code":5}
//
// Injection is the standard LoadLibraryW remote thread: write the DLL path into the target,
// start a thread at LoadLibraryW with that path as its argument, wait, check the module loaded.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>

#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

namespace {

const wchar_t* kOurModule = L"cockpit-link-capture.dll";

std::string Utf8(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
    return s;
}

std::string Json(const std::wstring& w) {
    std::string in = Utf8(w), out = "\"";
    for (char c : in) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if ((unsigned char)c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
        else out += c;
    }
    return out + "\"";
}

std::string JsonOrNull(const std::wstring& w) { return w.empty() ? "null" : Json(w); }

std::wstring Lower(std::wstring s) {
    for (auto& c : s) c = (wchar_t)towlower(c);
    return s;
}

std::wstring ErrorText(DWORD code) {
    wchar_t* buf = nullptr;
    FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, code, 0, (LPWSTR)&buf, 0, nullptr);
    std::wstring s = buf ? buf : L"unknown error";
    if (buf) LocalFree(buf);
    while (!s.empty() && (s.back() == L'\n' || s.back() == L'\r' || s.back() == L'.')) s.pop_back();
    return s;
}

int Fail(const std::wstring& what, DWORD code = 0) {
    std::wstring msg = what;
    if (code) msg += L": " + ErrorText(code);
    if (code == ERROR_ACCESS_DENIED) msg += L" (if the sim runs as administrator, run the host as administrator too)";
    printf("{\"ok\":false,\"error\":%s,\"code\":%lu}\n", Json(msg).c_str(), code);
    return 1;
}

struct LoadedModules {
    bool ok = false;
    DWORD error = 0;
    std::wstring ours;  // full path of our DLL if loaded
};

LoadedModules ScanModules(DWORD pid) {
    LoadedModules r;
    HANDLE snap = INVALID_HANDLE_VALUE;
    // ERROR_BAD_LENGTH means the target was changing its module list; retry a few times.
    for (int i = 0; i < 5; ++i) {
        snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if (snap != INVALID_HANDLE_VALUE || GetLastError() != ERROR_BAD_LENGTH) break;
        Sleep(50);
    }
    if (snap == INVALID_HANDLE_VALUE) {
        r.error = GetLastError();
        return r;
    }
    MODULEENTRY32W me{sizeof me};
    for (BOOL more = Module32FirstW(snap, &me); more; more = Module32NextW(snap, &me)) {
        if (Lower(me.szModule) == Lower(kOurModule)) r.ours = me.szExePath;
    }
    CloseHandle(snap);
    r.ok = true;
    return r;
}

std::vector<DWORD> FindProcesses(const std::wstring& exe) {
    std::vector<DWORD> pids;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return pids;
    PROCESSENTRY32W pe{sizeof pe};
    for (BOOL more = Process32FirstW(snap, &pe); more; more = Process32NextW(snap, &pe))
        if (_wcsicmp(pe.szExeFile, exe.c_str()) == 0) pids.push_back(pe.th32ProcessID);
    CloseHandle(snap);
    return pids;
}

int Status(const std::wstring& exe) {
    std::string list;
    for (DWORD pid : FindProcesses(exe)) {
        LoadedModules m = ScanModules(pid);
        char head[64];
        snprintf(head, sizeof head, "{\"pid\":%lu", pid);
        list += (list.empty() ? "" : ",") + std::string(head);
        if (m.ok) list += ",\"ours\":" + JsonOrNull(m.ours) + "}";
        else list += ",\"error\":" + Json(ErrorText(m.error)) + ",\"code\":" + std::to_string(m.error) + "}";
    }
    printf("{\"ok\":true,\"processes\":[%s]}\n", list.c_str());
    return 0;
}

int Inject(DWORD pid, const std::wstring& dllArg) {
    wchar_t full[MAX_PATH * 2];
    DWORD n = GetFullPathNameW(dllArg.c_str(), (DWORD)std::size(full), full, nullptr);
    if (!n || n >= std::size(full)) return Fail(L"bad DLL path", GetLastError());
    if (GetFileAttributesW(full) == INVALID_FILE_ATTRIBUTES) return Fail(L"DLL not found: " + std::wstring(full), GetLastError());

    LoadedModules before = ScanModules(pid);
    if (!before.ok) return Fail(L"cannot read the process's modules", before.error);
    if (!before.ours.empty()) {
        printf("{\"ok\":true,\"pid\":%lu,\"already\":true,\"module\":%s}\n", pid, Json(before.ours).c_str());
        return 0;
    }

    HANDLE proc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid);
    if (!proc) return Fail(L"cannot open the process", GetLastError());

    // Only inject into a 64-bit target from this 64-bit injector.
    BOOL wow64 = FALSE;
    if (IsWow64Process(proc, &wow64) && wow64) {
        CloseHandle(proc);
        return Fail(L"target is a 32-bit process");
    }

    size_t bytes = (wcslen(full) + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(proc, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {
        DWORD e = GetLastError();
        CloseHandle(proc);
        return Fail(L"VirtualAllocEx failed", e);
    }
    int rc = 0;
    if (!WriteProcessMemory(proc, remote, full, bytes, nullptr)) {
        rc = Fail(L"WriteProcessMemory failed", GetLastError());
    } else {
        // kernel32 is mapped at the same address in every process of a session.
        auto loadLibrary = (LPTHREAD_START_ROUTINE)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
        HANDLE th = CreateRemoteThread(proc, nullptr, 0, loadLibrary, remote, 0, nullptr);
        if (!th) {
            rc = Fail(L"CreateRemoteThread failed", GetLastError());
        } else {
            DWORD wait = WaitForSingleObject(th, 15000);
            CloseHandle(th);
            if (wait != WAIT_OBJECT_0) {
                // The thread may still be running LoadLibrary; leave the path buffer allocated.
                CloseHandle(proc);
                return Fail(L"LoadLibraryW did not return within 15 s");
            }
            LoadedModules after = ScanModules(pid);
            if (after.ok && !after.ours.empty())
                printf("{\"ok\":true,\"pid\":%lu,\"module\":%s}\n", pid, Json(after.ours).c_str());
            else
                rc = Fail(L"LoadLibraryW ran but the DLL is not loaded (missing dependency, or DllMain failed)");
        }
    }
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    CloseHandle(proc);
    return rc;
}

const wchar_t* Arg(int argc, wchar_t** argv, const wchar_t* name) {
    for (int i = 1; i + 1 < argc; ++i)
        if (_wcsicmp(argv[i], name) == 0) return argv[i + 1];
    return nullptr;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc >= 2 && _wcsicmp(argv[1], L"status") == 0) {
        const wchar_t* exe = Arg(argc, argv, L"--exe");
        return Status(exe ? exe : L"FlightSimulator2024.exe");
    }
    if (argc >= 2 && _wcsicmp(argv[1], L"inject") == 0) {
        const wchar_t* pid = Arg(argc, argv, L"--pid");
        const wchar_t* dll = Arg(argc, argv, L"--dll");
        if (!pid || !dll) return Fail(L"usage: inject --pid <pid> --dll <path>");
        return Inject((DWORD)wcstoul(pid, nullptr, 10), dll);
    }
    return Fail(L"usage: cockpit-link-injector status --exe <name.exe> | inject --pid <pid> --dll <path>");
}
