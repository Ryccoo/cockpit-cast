; Cockpit Link client installer for Windows (Inno Setup 6). Build with installer\build.ps1, which stages
; the files in installer\stage\client first (the Flutter release build plus the Visual C++ runtime DLLs,
; so it runs on PCs without the VC++ redistributable).
;
; Installs per user (no admin rights): %LOCALAPPDATA%\Programs\Cockpit Link Client. "Start when I sign in"
; is a setting in the app itself.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{D7EBAF9B-AF2F-4ED0-AF17-66EA5C06E26B}
AppName=Cockpit Link Client
AppVersion={#AppVersion}
AppVerName=Cockpit Link Client {#AppVersion}
AppPublisher=Cockpit Link contributors
DefaultDirName={localappdata}\Programs\Cockpit Link Client
DefaultGroupName=Cockpit Link
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=CockpitLink-Client-{#AppVersion}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
UninstallDisplayIcon={app}\cockpit_link.exe
#ifexist "..\LICENSE"
LicenseFile=..\LICENSE
#endif

[Tasks]
Name: desktop; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "stage\client\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Cockpit Link Client"; Filename: "{app}\cockpit_link.exe"
Name: "{group}\Uninstall Cockpit Link Client"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Cockpit Link Client"; Filename: "{app}\cockpit_link.exe"; Tasks: desktop

[Run]
Filename: "{app}\cockpit_link.exe"; Description: "Start Cockpit Link Client now"; Flags: postinstall nowait skipifsilent
