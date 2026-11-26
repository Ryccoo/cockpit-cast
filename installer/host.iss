; CockpitCast host installer (Inno Setup 6). Build with installer\build.ps1, which stages the files in
; installer\stage\host first.
;
; Installs per user (no admin rights): %LOCALAPPDATA%\Programs\CockpitCast
;   cockpitcast.exe   tray icon and launcher: starts the host (bundled Node.js, no console window)
;   node\              Node.js runtime
;   host\              the host (JavaScript) with its packages
;   bin\               capture.dll and the injector
;   hook\              builds the Community hook from the sim's own BaseInstrument.js, on this PC
;   config\            built-in display table
; Learned displays, layouts and logs live in %LOCALAPPDATA%\CockpitCast (kept on uninstall unless chosen).

#ifndef AppVersion
  #define AppVersion "0.2.5-beta.2"
#endif

[Setup]
AppId={{DE835CCC-B853-46D3-AD4A-AEAD8762D9A5}
AppName=CockpitCast
AppVersion={#AppVersion}
AppVerName=CockpitCast {#AppVersion}
AppPublisher=CockpitCast contributors
DefaultDirName={localappdata}\Programs\CockpitCast
DefaultGroupName=CockpitCast
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=CockpitCast-Host-{#AppVersion}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; No AppMutex: setup and the uninstaller close a running CockpitCast themselves (CloseCockpitCast in
; [Code]); AppMutex only told people to close it, which needs the tray icon's menu or Task Manager.
; Install into the folder named after the current name, not into an old install's folder.
UsePreviousAppDir=no
UsePreviousGroup=no
CloseApplications=yes
; Programs only: the sim keeps bin\cockpitcast-capture.dll loaded, and with the default filter (which
; includes *.dll) Windows' Restart Manager would offer to close the sim. PrepareToInstall moves that DLL
; aside instead.
CloseApplicationsFilter=*.exe
UninstallDisplayIcon={app}\cockpitcast.exe
UninstallDisplayName=CockpitCast (host)
#ifexist "..\LICENSE"
LicenseFile=..\LICENSE
#endif

[InstallDelete]
; Up to 0.1.1 the project was called "Cockpit Link": remove that version's program folder and shortcuts
; (this install replaces it; the host moves learned displays and layouts on its first start).
Type: filesandordirs; Name: "{localappdata}\Programs\Cockpit Link"
Type: files; Name: "{userprograms}\Cockpit Link\Cockpit Link.lnk"
Type: files; Name: "{userprograms}\Cockpit Link\Repair Community hook.lnk"
Type: files; Name: "{userprograms}\Cockpit Link\Uninstall Cockpit Link.lnk"
Type: dirifempty; Name: "{userprograms}\Cockpit Link"
Type: files; Name: "{userstartup}\Cockpit Link.lnk"
; Capture DLLs moved aside by earlier installs while the sim had them loaded (PrepareToInstall). One the
; sim still has loaded is not deleted (no error); a later install removes it.
Type: files; Name: "{app}\bin\*.old"

[Tasks]
Name: hook; Description: "Install the Community hook into MSFS 2024 (close the sim first)"
Name: startup; Description: "Start CockpitCast when I sign in to Windows"; Flags: unchecked

[Files]
Source: "stage\host\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\CockpitCast"; Filename: "{app}\cockpitcast.exe"; Comment: "Start the host (tray icon). If it already runs: open the layout editor."
Name: "{group}\Repair Community hook"; Filename: "{app}\node\node.exe"; Parameters: """{app}\hook\setup-hook.mjs"" --pause"; WorkingDir: "{app}"; Comment: "Rebuild and reinstall the hook (after every MSFS update)"
Name: "{group}\Uninstall CockpitCast"; Filename: "{uninstallexe}"
Name: "{userstartup}\CockpitCast"; Filename: "{app}\cockpitcast.exe"; Tasks: startup

[Run]
; runasoriginaluser: even if setup was started "as administrator", CockpitCast runs as the normal user
; (an elevated CockpitCast can be refused the MS Store sim's Community folder).
Filename: "{app}\cockpitcast.exe"; Description: "Start CockpitCast now"; Flags: postinstall nowait skipifsilent runasoriginaluser
; Updates from CockpitCast itself (/SILENT /UPDATE=1; host/src/updater.mjs): start it again when done.
Filename: "{app}\cockpitcast.exe"; Flags: nowait runasoriginaluser; Check: IsUpdate

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\hook\install-hook.mjs"" --remove"; WorkingDir: "{app}"; Flags: runhidden; RunOnceId: "RemoveHook"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\hook\dist"

[Code]
const
  WM_CLOSE = $0010;
  // The tray's single-instance mutexes and window classes (the second: the former name, up to 0.1.1).
  TrayMutexes = 'Local\CockpitCastTray,Local\CockpitLinkTray';

// Started by CockpitCast's own updater.
function IsUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

function TrayRunning: Boolean;
begin
  Result := CheckForMutexes(TrayMutexes);
end;

function WaitTrayGone(Seconds: Integer): Boolean;
var
  I: Integer;
begin
  for I := 1 to Seconds * 4 do
  begin
    if not TrayRunning then
      Break;
    Sleep(250);
  end;
  Result := not TrayRunning;
end;

// Ends a running CockpitCast host so its files can be replaced or removed. First the polite way: the
// tray's window gets WM_CLOSE, it stops the host (up to 5 s) and exits. If that does not work, the
// host's processes are ended: cockpitcast.exe next to a host\src\index.mjs (not the display app, which
// has the same name in another folder) and node.exe running host\src\index.mjs. Our own updater has
// already closed the tray (and released the mutex) before it starts setup, so nothing happens then.
function CloseCockpitCast: Boolean;
var
  Wnd: HWND;
  Code: Integer;
begin
  Result := True;
  if not TrayRunning then
    Exit;
  Wnd := FindWindowByClassName('CockpitCastTray');
  if Wnd <> 0 then
    PostMessage(Wnd, WM_CLOSE, 0, 0);
  Wnd := FindWindowByClassName('CockpitLinkTray');
  if Wnd <> 0 then
    PostMessage(Wnd, WM_CLOSE, 0, 0);
  if WaitTrayGone(10) then
    Exit;
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
       '-NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { ' +
       '($_.Name -eq ''node.exe'' -and $_.CommandLine -like ''*host\src\index.mjs*'') -or ' +
       '($_.Name -eq ''cockpitcast.exe'' -and $_.ExecutablePath -and ' +
       '(Test-Path (Join-Path (Split-Path $_.ExecutablePath) ''host\src\index.mjs''))) } | ' +
       'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
       '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := WaitTrayGone(5);
end;

function InitializeSetup: Boolean;
begin
  Result := CloseCockpitCast;
  if not Result then
    SuppressibleMsgBox('CockpitCast is running and could not be closed. Right-click its tray icon, choose ' +
                       '"Quit CockpitCast host", then run setup again.', mbError, MB_OK, IDOK);
end;

function InitializeUninstall: Boolean;
begin
  Result := CloseCockpitCast;
  if not Result then
    MsgBox('CockpitCast is running and could not be closed. Right-click its tray icon, choose ' +
           '"Quit CockpitCast host", then uninstall again.', mbError, MB_OK);
end;

// The sim keeps the capture DLL loaded until it exits, so it cannot be overwritten then; a loaded DLL
// can be renamed, though. Move it aside: the new one is installed under the real name and used from the
// next injection (the next sim start); [InstallDelete] removes the old copies later.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dll: String;
begin
  Result := '';
  Dll := ExpandConstant('{app}\bin\cockpitcast-capture.dll');
  if FileExists(Dll) and not DeleteFile(Dll) then
    RenameFile(Dll, Dll + '.' + GetDateTimeString('yyyymmddhhnnss', #0, #0) + '.old');
end;

// ---- Community folder page: where the hook goes ----
// Shown whenever the hook task is ticked (not in silent updates, which use the remembered folder), filled
// in with the folder found in the same order as hook\install-hook.mjs: the folder chosen last time, the
// Community folder set in MSFS Addons Linker, the sim's packages folder (UserCfg.opt, Steam or MS Store),
// the default locations. Addons Linker keeps add-ons in its own library and links the enabled ones into
// the sim's real Community folder: the hook goes there, never into the library.
var
  CommunityPage: TInputDirWizardPage;

// A folder the normal user can open. Setup may run elevated ("as administrator"), and an elevated
// process can be refused a Store app's folder that the user (and Explorer) opens fine, so a folder
// setup cannot see is checked again as the original user.
function FolderOk(P: String): Boolean;
var
  Code: Integer;
begin
  P := RemoveBackslashUnlessRoot(Trim(P));
  Result := (P <> '') and DirExists(P);
  if not Result and (P <> '') then
    Result := ExecAsOriginalUser(ExpandConstant('{cmd}'), '/c if exist "' + AddBackslash(P) + '" (exit 0) else (exit 1)', '',
                                 SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

// Only the MS Store version is installed: its package folder exists and the Steam version's UserCfg.opt
// does not. Steam-style folders (also a remembered one) are then leftovers (as in hook\install-hook.mjs).
function StoreOnly: Boolean;
begin
  Result := FolderOk(ExpandConstant('{localappdata}\Packages\Microsoft.Limitless_8wekyb3d8bbwe')) and
            not FileExists(ExpandConstant('{userappdata}\Microsoft Flight Simulator 2024\UserCfg.opt'));
end;

function IsSteamPath(const P: String): Boolean;
begin
  Result := Pos(Lowercase(ExpandConstant('{userappdata}\Microsoft Flight Simulator 2024\')), Lowercase(P)) = 1;
end;

// %LOCALAPPDATA%\CockpitCast\hook.json: { "community": "C:\\...\\Community" }
function SavedCommunity: String;
var
  S: AnsiString;
  T: String;
  I: Integer;
begin
  Result := '';
  if not LoadStringFromFile(ExpandConstant('{localappdata}\CockpitCast\hook.json'), S) then
    Exit;
  T := String(S);
  I := Pos('"community"', T);
  if I = 0 then
    Exit;
  T := Copy(T, I + 11, MaxInt);
  I := Pos('"', T);
  if I = 0 then
    Exit;
  T := Copy(T, I + 1, MaxInt);
  I := Pos('"', T);
  if I = 0 then
    Exit;
  Result := Copy(T, 1, I - 1);
  StringChangeEx(Result, '\\', '\', True);
end;

// A setting in MSFS Addons Linker's .ini files (C:\ProgramData\MSFS Addons Linker*) whose value is an
// existing folder named Community or Community2024 (its key names are not documented).
function AddonsLinkerCommunity: String;
var
  DirRec, IniRec: TFindRec;
  Base, Dir, V, L: String;
  Lines: TArrayOfString;
  I, Eq: Integer;
begin
  Result := '';
  Base := ExpandConstant('{commonappdata}');
  if not FindFirst(Base + '\MSFS Addons Linker*', DirRec) then
    Exit;
  try
    repeat
      if (DirRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then
        Continue;
      Dir := Base + '\' + DirRec.Name;
      if FindFirst(Dir + '\*.ini', IniRec) then
      try
        repeat
          if LoadStringsFromFile(Dir + '\' + IniRec.Name, Lines) then
            for I := 0 to GetArrayLength(Lines) - 1 do
            begin
              Eq := Pos('=', Lines[I]);
              if Eq < 2 then
                Continue;
              V := Trim(Copy(Lines[I], Eq + 1, MaxInt));
              StringChangeEx(V, '"', '', True);
              L := Lowercase(RemoveBackslashUnlessRoot(V));
              if ((Copy(L, Length(L) - 9, 10) = '\community') or (Copy(L, Length(L) - 13, 14) = '\community2024')) and DirExists(V) then
              begin
                Result := RemoveBackslashUnlessRoot(V);
                Exit;
              end;
            end;
        until not FindNext(IniRec);
      finally
        FindClose(IniRec);
      end;
    until not FindNext(DirRec);
  finally
    FindClose(DirRec);
  end;
end;

// InstalledPackagesPath "D:\MSFS" in UserCfg.opt -> D:\MSFS\Community
function UserCfgCommunity(const F: String): String;
var
  Lines: TArrayOfString;
  I, Q: Integer;
  L: String;
begin
  Result := '';
  if not LoadStringsFromFile(F, Lines) then
    Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    L := Trim(Lines[I]);
    if Pos('InstalledPackagesPath', L) <> 1 then
      Continue;
    Q := Pos('"', L);
    if Q = 0 then
      Exit;
    L := Copy(L, Q + 1, MaxInt);
    Q := Pos('"', L);
    if Q = 0 then
      Exit;
    Result := AddBackslash(Copy(L, 1, Q - 1)) + 'Community';
    Exit;
  end;
end;

function DetectCommunity: String;
var
  C: array[0..5] of String;
  I: Integer;
  Store: Boolean;
begin
  C[0] := SavedCommunity;
  C[1] := AddonsLinkerCommunity;
  C[2] := UserCfgCommunity(ExpandConstant('{localappdata}\Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\UserCfg.opt'));
  C[3] := UserCfgCommunity(ExpandConstant('{userappdata}\Microsoft Flight Simulator 2024\UserCfg.opt'));
  C[4] := ExpandConstant('{localappdata}\Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalCache\Packages\Community');
  C[5] := ExpandConstant('{userappdata}\Microsoft Flight Simulator 2024\Packages\Community');
  Store := StoreOnly;
  Result := '';
  for I := 0 to 5 do
    if (C[I] <> '') and not (Store and IsSteamPath(C[I])) and FolderOk(C[I]) then
    begin
      Result := C[I];
      Exit;
    end;
end;

procedure InitializeWizard;
begin
  CommunityPage := CreateInputDirPage(wpSelectTasks, 'MSFS Community folder', 'Where should the CockpitCast hook go?',
    'The hook is a small add-on for MSFS 2024. It goes into the folder MSFS loads add-ons from: its Community folder. ' +
    'Setup filled in the folder it found; check it, or choose another.' + #13#10#13#10 +
    'Using MSFS Addons Linker, or keeping add-ons on another drive? Choose the Community folder set in its options ' +
    '(where it puts the links), not your add-ons library: MSFS does not read the library.' + #13#10#13#10 +
    'Browse does not show hidden folders such as AppData: paste the path instead (copy it from Explorer''s address bar).',
    False, '');
  CommunityPage.Add('Community folder:');
  CommunityPage.Values[0] := DetectCommunity;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = CommunityPage.ID) and not WizardIsTaskSelected('hook');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  V: String;
begin
  Result := True;
  if CurPageID <> CommunityPage.ID then
    Exit;
  // Windows' "Copy as path" adds quotes; spaces around the path are never part of it.
  V := CommunityPage.Values[0];
  StringChangeEx(V, '"', '', True);
  V := RemoveBackslashUnlessRoot(Trim(V));
  CommunityPage.Values[0] := V;
  if not FolderOk(V) then
  begin
    MsgBox('Setup cannot find or open this folder:' + #13#10 + V + #13#10#13#10 +
           'Copy the path from the address bar of Explorer showing your Community folder. ' +
           'If Explorer opens it but setup does not, start setup normally (not "Run as administrator").',
           mbError, MB_OK);
    Result := False;
  end;
end;

// Runs hook\setup-hook.mjs with Extra arguments; its exit code (-1 if it could not start).
// As the original user: even when setup runs elevated, the hook is built and copied with the same
// rights as Explorer (an elevated process can be refused the MS Store sim's Community folder).
function SetupHook(const Extra: String): Integer;
begin
  if not ExecAsOriginalUser(ExpandConstant('{app}\node\node.exe'), '"' + ExpandConstant('{app}\hook\setup-hook.mjs') + '"' + Extra,
              ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Result) then
    Result := -1;
end;

// The hook is built from the sim's own BaseInstrument.js, so it is made here, on this PC.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Dir: String;
  Log: AnsiString;
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('hook') then
  begin
    WizardForm.StatusLabel.Caption := 'Installing the Community hook into MSFS 2024...';
    // The folder from the Community folder page (remembered by the hook). Silent updates skip the page
    // and use the remembered folder.
    Dir := '';
    if not WizardSilent then
      Dir := RemoveBackslashUnlessRoot(Trim(CommunityPage.Values[0]));
    // A trailing backslash would escape the closing quote ("E:" as a drive root).
    if (Dir <> '') and (Dir[Length(Dir)] = '') then
      Dir := Dir + '.';
    if Dir <> '' then
      Code := SetupHook(' --community "' + Dir + '"')
    else
      Code := SetupHook('');
    // 3: no Community folder found (a silent update, and the folder is gone). Ask for it; the hook
    // remembers the answer. Also during CockpitCast's own updates: someone clicked Install update.
    Dir := '';
    while (Code = 3) and
          BrowseForFolder('MSFS 2024''s Community folder was not found. Choose the Community folder the sim ' +
                          'loads add-ons from (for example E:\MSFS2024\Community). If you use Addons Linker ' +
                          'or moved your add-ons, pick the folder the sim reads them from.', Dir, False) do
    begin
      // A trailing backslash would escape the closing quote ("E:\" as a drive root).
      if (Dir <> '') and (Dir[Length(Dir)] = '\') then
        Dir := Dir + '.';
      Code := SetupHook(' --community "' + Dir + '"');
    end;
    if Code <> 0 then
    begin
      LoadStringFromFile(ExpandConstant('{localappdata}\CockpitCast\logs\hook-setup.log'), Log);
      MsgBox('The Community hook could not be installed:' + #13#10#13#10 + String(Log) + #13#10 +
             'CockpitCast is installed. Fix the problem above, then run "Repair Community hook" from the Start menu.',
             mbError, MB_OK);
    end;
  end;
end;

// Keep or remove the user's data (learned displays, layouts, screens, logs).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DirExists(ExpandConstant('{localappdata}\CockpitCast')) then
    if MsgBox('Also delete your CockpitCast data (learned displays, layouts, screens and logs)?',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{localappdata}\CockpitCast'), True, True, True);
end;
