// CockpitCast tray icon (Windows): shows that the host is running.
//
//   click            open the layout editor in the default browser
//   right-click      menu: layout editor, monitor, current status, install an update, quit the host
//
// Two ways to run:
//   started by the host (npm start): talks to the host over its own stdin/stdout, and goes away when
//                    the host exits (stdin closes).
//   launcher         started by itself (Start menu, sign-in): starts the host (node, no console window)
//                    and talks to it over the host's stdin/stdout. Restarts the host if it stops
//                    unexpectedly. A second launcher only opens the editor.
// One UTF-8 line per message:
//   host -> tray   "editor <url>", "monitor <url>", "support <url>" (donations; menu item shown when
//                  given), "status <idle|sim|live> <text, lines split by \n>",
//                  "update <version>" (a newer version can be installed: menu item and a notification),
//                  "install <installer path>" (stop the host, run that installer silently, exit)
//   tray -> host   "quit", "update" (install the newer version)

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <objidl.h>
#include <gdiplus.h>

#include <string>
#include <vector>

namespace {

constexpr UINT WM_TRAY = WM_APP + 1;   // notifications from the tray icon
constexpr UINT WM_LINE = WM_APP + 2;   // a line from the host (lParam: std::string*)
constexpr UINT WM_HOSTGONE = WM_APP + 3;  // the host's output closed (it exited)
constexpr UINT_PTR TIMER_RESTART = 1, TIMER_KILL = 2;
constexpr int MAX_RESTARTS = 3;
constexpr UINT ICON_ID = 1;
constexpr UINT CMD_EDITOR = 1, CMD_MONITOR = 2, CMD_QUIT = 3, CMD_SUPPORT = 4, CMD_UPDATE = 5;

HWND g_wnd = nullptr;
UINT g_taskbarCreated = 0;
HICON g_icon = nullptr;
std::wstring g_editor = L"http://localhost:8800/editor";
std::wstring g_monitor = L"http://localhost:8800/";
std::wstring g_support;  // donation page, from the host
std::wstring g_update;   // newer version that can be installed, from the host
std::wstring g_installer;  // set by "install": run it once the host has stopped
HANDLE g_single = nullptr; // the single-instance mutex (the installer checks it)
std::wstring g_level = L"idle";
std::wstring g_status = L"CockpitCast host";

// The host's channel: our stdin/stdout when the host started us; pipes to the node process in launcher mode.
HANDLE g_fromHost = nullptr, g_toHost = nullptr;
bool g_launcher = false;
bool g_quitting = false;
int g_restarts = 0;
PROCESS_INFORMATION g_host{};
std::wstring g_node, g_script, g_hostDir;

std::wstring Widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

std::vector<std::wstring> Lines(const std::wstring& s) {
  std::vector<std::wstring> out;
  size_t a = 0;
  for (;;) {
    size_t b = s.find(L'\n', a);
    out.push_back(s.substr(a, b == std::wstring::npos ? std::wstring::npos : b - a));
    if (b == std::wstring::npos) break;
    a = b + 1;
  }
  return out;
}

// A small round gauge: dark face, a ring coloured by state, one needle.
//   idle: grey (host only)   sim: blue (sim running)   live: green (glass displays captured)
HICON MakeIcon(const std::wstring& level) {
  int size = GetSystemMetrics(SM_CXSMICON);
  UINT dpi = GetDpiForWindow(g_wnd);
  if (dpi) size = GetSystemMetricsForDpi(SM_CXSMICON, dpi);
  Gdiplus::Bitmap bmp(size, size, PixelFormat32bppARGB);
  Gdiplus::Graphics g(&bmp);
  g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  g.Clear(Gdiplus::Color(0, 0, 0, 0));
  Gdiplus::Color ring = level == L"live" ? Gdiplus::Color(255, 46, 204, 113)
                      : level == L"sim"  ? Gdiplus::Color(255, 52, 152, 219)
                                         : Gdiplus::Color(255, 150, 156, 164);
  const float s = (float)size, w = s * 0.14f;
  Gdiplus::SolidBrush face(Gdiplus::Color(255, 24, 26, 30));
  g.FillEllipse(&face, w / 2, w / 2, s - w - 0.5f, s - w - 0.5f);
  Gdiplus::Pen ringPen(ring, w);
  g.DrawEllipse(&ringPen, w / 2, w / 2, s - w - 0.5f, s - w - 0.5f);
  Gdiplus::Pen needle(Gdiplus::Color(255, 240, 180, 41), s * 0.12f);
  needle.SetStartCap(Gdiplus::LineCapRound);
  needle.SetEndCap(Gdiplus::LineCapRound);
  g.DrawLine(&needle, s * 0.5f, s * 0.55f, s * 0.74f, s * 0.28f);
  Gdiplus::SolidBrush hub(Gdiplus::Color(255, 230, 230, 230));
  g.FillEllipse(&hub, s * 0.42f, s * 0.47f, s * 0.16f, s * 0.16f);
  HICON icon = nullptr;
  bmp.GetHICON(&icon);
  return icon;
}

void FillTip(NOTIFYICONDATAW& nid) {
  wcsncpy_s(nid.szTip, g_status.c_str(), _TRUNCATE);
}

void AddIcon() {
  NOTIFYICONDATAW nid{sizeof(nid)};
  nid.hWnd = g_wnd;
  nid.uID = ICON_ID;
  nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
  nid.uCallbackMessage = WM_TRAY;
  nid.hIcon = g_icon;
  FillTip(nid);
  Shell_NotifyIconW(NIM_ADD, &nid);
  nid.uVersion = NOTIFYICON_VERSION_4;
  Shell_NotifyIconW(NIM_SETVERSION, &nid);
}

void UpdateIcon() {
  NOTIFYICONDATAW nid{sizeof(nid)};
  nid.hWnd = g_wnd;
  nid.uID = ICON_ID;
  nid.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
  nid.hIcon = g_icon;
  FillTip(nid);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void RemoveIcon() {
  NOTIFYICONDATAW nid{sizeof(nid)};
  nid.hWnd = g_wnd;
  nid.uID = ICON_ID;
  Shell_NotifyIconW(NIM_DELETE, &nid);
}

void Open(const std::wstring& url) {
  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

void SendToHost(const char* line) {
  DWORD n = 0;
  if (g_toHost) WriteFile(g_toHost, line, (DWORD)strlen(line), &n, nullptr);
}

void Notify(const wchar_t* title, const std::wstring& text, DWORD flags = NIIF_WARNING) {
  NOTIFYICONDATAW nid{sizeof(nid)};
  nid.hWnd = g_wnd;
  nid.uID = ICON_ID;
  nid.uFlags = NIF_INFO;
  wcsncpy_s(nid.szInfoTitle, title, _TRUNCATE);
  wcsncpy_s(nid.szInfo, text.c_str(), _TRUNCATE);
  nid.dwInfoFlags = flags;
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void ShowMenu(int x, int y) {
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING, CMD_EDITOR, L"Open layout editor");
  AppendMenuW(m, MF_STRING, CMD_MONITOR, L"Open monitor");
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  for (const auto& line : Lines(g_status)) AppendMenuW(m, MF_STRING | MF_GRAYED, 0, line.c_str());
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  if (!g_update.empty()) AppendMenuW(m, MF_STRING, CMD_UPDATE, (L"Install update " + g_update + L" and restart").c_str());
  if (!g_support.empty()) AppendMenuW(m, MF_STRING, CMD_SUPPORT, L"Support CockpitCast \u2665 (Ko-fi)");
  AppendMenuW(m, MF_STRING, CMD_QUIT, L"Quit CockpitCast host");
  SetMenuDefaultItem(m, CMD_EDITOR, FALSE);
  SetForegroundWindow(g_wnd); // so the menu closes when clicking elsewhere
  UINT cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, x, y, 0, g_wnd, nullptr);
  DestroyMenu(m);
  if (cmd == CMD_EDITOR) Open(g_editor);
  else if (cmd == CMD_MONITOR) Open(g_monitor);
  else if (cmd == CMD_SUPPORT) Open(g_support);
  else if (cmd == CMD_UPDATE) {
    SendToHost("update\n");
    Notify(L"CockpitCast", L"Downloading the update. CockpitCast restarts by itself when it is installed.", NIIF_INFO);
  }
  else if (cmd == CMD_QUIT) {
    SendToHost("quit\n");
    if (g_launcher) {
      g_quitting = true;
      SetTimer(g_wnd, TIMER_KILL, 5000, nullptr);  // the host did not stop by itself: end it
      if (!g_host.hProcess) DestroyWindow(g_wnd);
    }
  }
}

void OnLine(const std::wstring& line) {
  size_t sp = line.find(L' ');
  std::wstring cmd = line.substr(0, sp), rest = sp == std::wstring::npos ? L"" : line.substr(sp + 1);
  if (cmd == L"editor" && !rest.empty()) g_editor = rest;
  else if (cmd == L"monitor" && !rest.empty()) g_monitor = rest;
  else if (cmd == L"support" && rest.rfind(L"https://", 0) == 0) g_support = rest;
  else if (cmd == L"update" && !rest.empty() && rest.size() < 32) {
    if (rest != g_update) Notify(L"CockpitCast update", L"Version " + rest + L" is available. Right-click the CockpitCast icon to install it.", NIIF_INFO);
    g_update = rest;
  }
  else if (cmd == L"install" && g_launcher && rest.size() > 4 && _wcsicmp(rest.c_str() + rest.size() - 4, L".exe") == 0) {
    g_installer = rest;
    g_quitting = true;
    SendToHost("quit\n");
    SetTimer(g_wnd, TIMER_KILL, 10000, nullptr);  // the host did not stop by itself: end it
  }
  else if (cmd == L"status") {
    size_t sp2 = rest.find(L' ');
    std::wstring level = rest.substr(0, sp2);
    std::wstring text = sp2 == std::wstring::npos ? L"CockpitCast host" : rest.substr(sp2 + 1);
    for (size_t i; (i = text.find(L"\\n")) != std::wstring::npos;) text.replace(i, 2, L"\n");
    g_status = text;
    if (level != g_level) {
      g_level = level;
      if (HICON old = g_icon) {
        g_icon = MakeIcon(g_level);
        UpdateIcon();
        DestroyIcon(old);
        return;
      }
    }
    UpdateIcon();
  }
}

bool StartHost();

// Update: run the installer silently. It shows its progress, closes what is still open, and starts
// CockpitCast again when done (/UPDATE=1; installer/host.iss). Its log goes next to the host's.
void RunInstaller() {
  if (g_single) {  // the installer refuses to run while this mutex exists
    CloseHandle(g_single);
    g_single = nullptr;
  }
  wchar_t logPath[MAX_PATH] = L"";
  ExpandEnvironmentStringsW(L"%LOCALAPPDATA%\\CockpitCast\\logs\\update-install.log", logPath, MAX_PATH);
  std::wstring cmd = L"\"" + g_installer + L"\" /SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /UPDATE=1 /LOG=\"" + logPath + L"\"";
  STARTUPINFOW si{sizeof(si)};
  PROCESS_INFORMATION pi{};
  if (CreateProcessW(g_installer.c_str(), cmd.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  } else {
    std::wstring msg = L"CockpitCast could not start the update installer:\n" + g_installer;
    MessageBoxW(nullptr, msg.c_str(), L"CockpitCast", MB_ICONERROR);
  }
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == g_taskbarCreated && g_taskbarCreated) { // Explorer restarted: put the icon back
    AddIcon();
    return 0;
  }
  switch (msg) {
    case WM_TRAY:
      switch (LOWORD(lp)) {
        case NIN_SELECT:
        case NIN_KEYSELECT:
          Open(g_editor);
          break;
        case WM_CONTEXTMENU:
          ShowMenu(GET_X_LPARAM(wp), GET_Y_LPARAM(wp));
          break;
      }
      return 0;
    case WM_LINE: {
      auto* s = reinterpret_cast<std::string*>(lp);
      OnLine(Widen(*s));
      delete s;
      return 0;
    }
    case WM_HOSTGONE:
      if (!g_installer.empty()) {
        RunInstaller();
        DestroyWindow(hwnd);
      } else if (!g_launcher || g_quitting) {
        DestroyWindow(hwnd);
      } else if (++g_restarts <= MAX_RESTARTS) {
        Notify(L"CockpitCast", L"The host stopped unexpectedly; starting it again.");
        SetTimer(hwnd, TIMER_RESTART, 3000, nullptr);
      } else {
        g_level = L"idle";
        g_status = L"CockpitCast host stopped\nSee %LOCALAPPDATA%\\CockpitCast\\logs\\host.log";
        if (HICON old = g_icon) {
          g_icon = MakeIcon(g_level);
          DestroyIcon(old);
        }
        UpdateIcon();
        Notify(L"CockpitCast", L"The host keeps stopping (is another copy running?). Details in the host log.");
      }
      return 0;
    case WM_TIMER:
      KillTimer(hwnd, wp);
      if (wp == TIMER_RESTART && !g_quitting) StartHost();
      if (wp == TIMER_KILL && g_host.hProcess) TerminateProcess(g_host.hProcess, 0);
      return 0;
    case WM_DPICHANGED:
    case WM_SETTINGCHANGE:
      if (HICON old = g_icon) {
        g_icon = MakeIcon(g_level);
        UpdateIcon();
        DestroyIcon(old);
      }
      return 0;
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      RemoveIcon();
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// Reads lines from the host until its output closes (it exited, or we were started by it and it exited).
DWORD WINAPI ReadHost(LPVOID param) {
  HANDLE in = static_cast<HANDLE>(param);
  std::string buf;
  char chunk[1024];
  DWORD n = 0;
  while (in && in != INVALID_HANDLE_VALUE && ReadFile(in, chunk, sizeof(chunk), &n, nullptr) && n > 0) {
    buf.append(chunk, n);
    for (size_t i; (i = buf.find('\n')) != std::string::npos;) {
      std::string line = buf.substr(0, i);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      buf.erase(0, i + 1);
      PostMessageW(g_wnd, WM_LINE, 0, reinterpret_cast<LPARAM>(new std::string(std::move(line))));
    }
  }
  if (g_launcher) CloseHandle(in);  // our end of the pipe to the host
  PostMessageW(g_wnd, WM_HOSTGONE, 0, 0);
  return 0;
}

std::wstring ExeDir() {
  wchar_t p[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, p, MAX_PATH);
  std::wstring s(p, n);
  return s.substr(0, s.find_last_of(L"\\/"));
}

bool Exists(const std::wstring& p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }

// The host: <dir>\host\src\index.mjs next to us (installed) or a few folders up (tray\build\Release in a
// checkout). Node: <dir>\node\node.exe if bundled, else node.exe from PATH.
bool FindHost() {
  std::wstring d = ExeDir();
  for (int up = 0; up < 5; ++up) {
    if (Exists(d + L"\\host\\src\\index.mjs")) {
      g_script = d + L"\\host\\src\\index.mjs";
      g_hostDir = d + L"\\host";
      g_node = Exists(d + L"\\node\\node.exe") ? d + L"\\node\\node.exe" : L"node.exe";
      return true;
    }
    size_t k = d.find_last_of(L"\\/");
    if (k == std::wstring::npos) break;
    d = d.substr(0, k);
  }
  return false;
}

void CloseHostHandles() {
  if (g_host.hProcess) CloseHandle(g_host.hProcess);
  if (g_host.hThread) CloseHandle(g_host.hThread);
  g_host = {};
  if (g_toHost) CloseHandle(g_toHost);
  g_toHost = nullptr;
}

// Launcher mode: start the host (no console window) with pipes for its stdin/stdout.
bool StartHost() {
  CloseHostHandles();
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE outR = nullptr, outW = nullptr, inR = nullptr, inW = nullptr;
  if (!CreatePipe(&outR, &outW, &sa, 0) || !CreatePipe(&inR, &inW, &sa, 0)) return false;
  SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);
  HANDLE nul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
  STARTUPINFOW si{sizeof(si)};
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = inR;
  si.hStdOutput = outW;
  si.hStdError = nul;
  std::wstring cmd = L"\"" + g_node + L"\" \"" + g_script + L"\"";
  SetEnvironmentVariableW(L"COCKPITCAST_TRAY_PARENT", L"1");  // the host talks to us over its stdin/stdout
  BOOL ok = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, g_hostDir.c_str(), &si, &g_host);
  CloseHandle(inR);
  CloseHandle(outW);
  if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
  if (!ok) {
    CloseHandle(outR);
    CloseHandle(inW);
    return false;
  }
  g_toHost = inW;
  CloseHandle(CreateThread(nullptr, 0, ReadHost, outR, 0, nullptr));
  return true;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  // Started by the host (its pipe on our stdin), or by itself (launcher).
  HANDLE stdIn = GetStdHandle(STD_INPUT_HANDLE);
  g_launcher = !stdIn || stdIn == INVALID_HANDLE_VALUE || GetFileType(stdIn) != FILE_TYPE_PIPE;
  if (g_launcher) {
    g_single = CreateMutexW(nullptr, TRUE, L"Local\\CockpitCastTray");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {  // already running: just open the editor
      Open(g_editor);
      return 0;
    }
    if (!FindHost()) {
      MessageBoxW(nullptr, L"CockpitCast: the host program (host\\src\\index.mjs) was not found next to this program.", L"CockpitCast", MB_ICONERROR);
      return 1;
    }
  } else {
    g_fromHost = stdIn;
    g_toHost = GetStdHandle(STD_OUTPUT_HANDLE);
  }

  Gdiplus::GdiplusStartupInput gsi;
  ULONG_PTR gdiplus = 0;
  Gdiplus::GdiplusStartup(&gdiplus, &gsi, nullptr);

  WNDCLASSW wc{};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = inst;
  wc.lpszClassName = L"CockpitCastTray";
  RegisterClassW(&wc);
  // A hidden top-level window (not message-only: it must receive the TaskbarCreated broadcast).
  g_wnd = CreateWindowExW(0, wc.lpszClassName, L"CockpitCast", WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, inst, nullptr);
  g_taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  g_icon = MakeIcon(g_level);
  AddIcon();
  if (g_launcher) {
    if (!StartHost()) {
      std::wstring msg = L"CockpitCast: could not start the host (" + g_node + L").";
      MessageBoxW(nullptr, msg.c_str(), L"CockpitCast", MB_ICONERROR);
      RemoveIcon();
      return 1;
    }
  } else {
    CloseHandle(CreateThread(nullptr, 0, ReadHost, g_fromHost, 0, nullptr));
  }

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  if (g_launcher && g_host.hProcess) {
    // Leaving while the host still runs (Explorer closing us, logoff): stop it too.
    SendToHost("quit\n");
    if (WaitForSingleObject(g_host.hProcess, 5000) != WAIT_OBJECT_0) TerminateProcess(g_host.hProcess, 0);
  }
  CloseHostHandles();
  if (g_icon) DestroyIcon(g_icon);
  Gdiplus::GdiplusShutdown(gdiplus);
  if (g_single) CloseHandle(g_single);
  return 0;
}
