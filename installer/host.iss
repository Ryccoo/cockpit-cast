; Cockpit Link host installer (Inno Setup 6). Build with installer\build.ps1, which stages the files in
; installer\stage\host first.
;
; Installs per user (no admin rights): %LOCALAPPDATA%\Programs\Cockpit Link
;   cockpit-link.exe   tray icon and launcher: starts the host (bundled Node.js, no console window)
;   node\              Node.js runtime
;   host\              the host (JavaScript) with its packages
;   bin\               capture.dll and the injector
;   hook\              builds the Community hook from the sim's own BaseInstrument.js, on this PC
;   config\            built-in display table
; Learned displays, layouts and logs live in %LOCALAPPDATA%\CockpitLink (kept on uninstall unless chosen).

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{DE835CCC-B853-46D3-AD4A-AEAD8762D9A5}
AppName=Cockpit Link
AppVersion={#AppVersion}
AppVerName=Cockpit Link {#AppVersion}
AppPublisher=Cockpit Link contributors
DefaultDirName={localappdata}\Programs\Cockpit Link
DefaultGroupName=Cockpit Link
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=CockpitLink-Host-{#AppVersion}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
AppMutex=Local\CockpitLinkTray
CloseApplications=yes
UninstallDisplayIcon={app}\cockpit-link.exe
UninstallDisplayName=Cockpit Link (host)
#ifexist "..\LICENSE"
LicenseFile=..\LICENSE
#endif

[Tasks]
Name: hook; Description: "Install the Community hook into MSFS 2024 (close the sim first)"
Name: startup; Description: "Start Cockpit Link when I sign in to Windows"; Flags: unchecked

[Files]
Source: "stage\host\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Cockpit Link"; Filename: "{app}\cockpit-link.exe"; Comment: "Start the host (tray icon). If it already runs: open the layout editor."
Name: "{group}\Repair Community hook"; Filename: "{app}\node\node.exe"; Parameters: """{app}\hook\setup-hook.mjs"" --pause"; WorkingDir: "{app}"; Comment: "Rebuild and reinstall the hook (after every MSFS update)"
Name: "{group}\Uninstall Cockpit Link"; Filename: "{uninstallexe}"
Name: "{userstartup}\Cockpit Link"; Filename: "{app}\cockpit-link.exe"; Tasks: startup

[Run]
Filename: "{app}\cockpit-link.exe"; Description: "Start Cockpit Link now"; Flags: postinstall nowait skipifsilent
; Updates from Cockpit Link itself (/SILENT /UPDATE=1; host/src/updater.mjs): start it again when done.
Filename: "{app}\cockpit-link.exe"; Flags: nowait; Check: IsUpdate

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\hook\install-hook.mjs"" --remove"; WorkingDir: "{app}"; Flags: runhidden; RunOnceId: "RemoveHook"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\hook\dist"

[Code]
// Started by Cockpit Link's own updater.
function IsUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

// The hook is built from the sim's own BaseInstrument.js, so it is made here, on this PC.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Log: AnsiString;
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('hook') then
  begin
    WizardForm.StatusLabel.Caption := 'Installing the Community hook into MSFS 2024...';
    if not Exec(ExpandConstant('{app}\node\node.exe'), '"' + ExpandConstant('{app}\hook\setup-hook.mjs') + '"',
                ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
    begin
      LoadStringFromFile(ExpandConstant('{localappdata}\CockpitLink\logs\hook-setup.log'), Log);
      MsgBox('The Community hook could not be installed:' + #13#10#13#10 + String(Log) + #13#10 +
             'Cockpit Link is installed. Fix the problem above, then run "Repair Community hook" from the Start menu.',
             mbError, MB_OK);
    end;
  end;
end;

// Keep or remove the user's data (learned displays, layouts, screens, logs).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DirExists(ExpandConstant('{localappdata}\CockpitLink')) then
    if MsgBox('Also delete your Cockpit Link data (learned displays, layouts, screens and logs)?',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{localappdata}\CockpitLink'), True, True, True);
end;
