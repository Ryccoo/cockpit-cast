; CockpitCast client installer for Windows (Inno Setup 6). Build with installer\build.ps1, which stages
; the files in installer\stage\client first (the Flutter release build plus the Visual C++ runtime DLLs,
; so it runs on PCs without the VC++ redistributable).
;
; Installs per user (no admin rights): %LOCALAPPDATA%\Programs\CockpitCast Client. "Start when I sign in"
; is a setting in the app itself.

#ifndef AppVersion
  #define AppVersion "0.2.4"
#endif

[Setup]
AppId={{D7EBAF9B-AF2F-4ED0-AF17-66EA5C06E26B}
AppName=CockpitCast Client
AppVersion={#AppVersion}
AppVerName=CockpitCast Client {#AppVersion}
AppPublisher=CockpitCast contributors
DefaultDirName={localappdata}\Programs\CockpitCast Client
DefaultGroupName=CockpitCast
; Install into the folder named after the current name, not into an old install's folder.
UsePreviousAppDir=no
UsePreviousGroup=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=CockpitCast-Client-{#AppVersion}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
UninstallDisplayIcon={app}\cockpitcast.exe
#ifexist "..\LICENSE"
LicenseFile=..\LICENSE
#endif

[InstallDelete]
; Up to 0.1.1 the project was called "Cockpit Link": remove that version's program folder and shortcuts.
Type: filesandordirs; Name: "{localappdata}\Programs\Cockpit Link Client"
Type: files; Name: "{userprograms}\Cockpit Link\Cockpit Link Client.lnk"
Type: files; Name: "{userprograms}\Cockpit Link\Uninstall Cockpit Link Client.lnk"
Type: dirifempty; Name: "{userprograms}\Cockpit Link"
Type: files; Name: "{userdesktop}\Cockpit Link Client.lnk"

[Tasks]
Name: desktop; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "stage\client\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\CockpitCast Client"; Filename: "{app}\cockpitcast.exe"
Name: "{group}\Uninstall CockpitCast Client"; Filename: "{uninstallexe}"
Name: "{userdesktop}\CockpitCast Client"; Filename: "{app}\cockpitcast.exe"; Tasks: desktop

[Run]
Filename: "{app}\cockpitcast.exe"; Description: "Start CockpitCast Client now"; Flags: postinstall nowait skipifsilent
; Updates from the app itself (/SILENT /UPDATE=1 /ARGS="<its command line>"; client/lib/updater.dart):
; start it again, as it was started.
Filename: "{app}\cockpitcast.exe"; Parameters: "{param:ARGS|}"; Flags: nowait; Check: IsUpdate

[Code]
// Started by the app's own updater.
function IsUpdate: Boolean;
begin
  Result := ExpandConstant('{param:UPDATE|0}') = '1';
end;
