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
  #define AppVersion "0.2.3"
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
; The second mutex is the tray's under the project's former name (up to 0.1.1).
AppMutex=Local\CockpitCastTray,Local\CockpitLinkTray
; Install into the folder named after the current name, not into an old install's folder.
UsePreviousAppDir=no
UsePreviousGroup=no
CloseApplications=yes
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
Filename: "{app}\cockpitcast.exe"; Description: "Start CockpitCast now"; Flags: postinstall nowait skipifsilent
; Updates from CockpitCast itself (/SILENT /UPDATE=1; host/src/updater.mjs): start it again when done.
Filename: "{app}\cockpitcast.exe"; Flags: nowait; Check: IsUpdate

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\hook\install-hook.mjs"" --remove"; WorkingDir: "{app}"; Flags: runhidden; RunOnceId: "RemoveHook"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\hook\dist"

[Code]
// Started by CockpitCast's own updater.
function IsUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;

// Runs hook\setup-hook.mjs with Extra arguments; its exit code (-1 if it could not start).
function SetupHook(const Extra: String): Integer;
begin
  if not Exec(ExpandConstant('{app}\node\node.exe'), '"' + ExpandConstant('{app}\hook\setup-hook.mjs') + '"' + Extra,
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
    Code := SetupHook('');
    // 3: no Community folder found (moved add-ons, Addons Linker, ...). Ask for it; the hook remembers
    // the answer, so later repairs and updates use it too. Not during silent updates.
    Dir := '';
    while (Code = 3) and not WizardSilent and
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
