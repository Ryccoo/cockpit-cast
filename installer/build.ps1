<#
Builds the Windows installers (Inno Setup 6) and the portable client zip:

  installer\output\CockpitCast-Host-<version>-Setup.exe     sim PC: host, capture.dll, injector, tray, hook tools
  installer\output\CockpitCast-Client-<version>-Setup.exe   display PCs: the client app
  installer\output\CockpitCast-Client-<version>-windows.zip the client without installing (unzip and run)

Needs: Visual Studio 2022 (C++, CMake), Node.js, the Flutter SDK, Inno Setup 6.

  powershell -ExecutionPolicy Bypass -File installer\build.ps1 [-SkipBuild] [-SkipClient] [-SkipHost]

-SkipBuild uses the C++ and Flutter builds already there.
#>
param([switch]$SkipBuild, [switch]$SkipClient, [switch]$SkipHost)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$here = $PSScriptRoot
$stage = Join-Path $here 'stage'
$out = Join-Path $here 'output'
$version = (Get-Content (Join-Path $root 'host\package.json') -Raw | ConvertFrom-Json).version
Write-Host "CockpitCast $version"

function Find-Tool($name, $candidates) {
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "$name not found"
}
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath
# CMake: on the PATH (CI machines), at Visual Studio's usual place, or anywhere in the VS folder (Build Tools).
$cmake = (Get-Command cmake.exe -ErrorAction SilentlyContinue).Source
if (-not $cmake) { $cmake = "$vs\Common7\IDE\CommonExtensionTools\Microsoft\CMake\CMake\bin\cmake.exe" }
if (-not (Test-Path $cmake)) { $cmake = Get-ChildItem -Recurse -Filter cmake.exe $vs -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
if (-not $cmake) { throw 'cmake.exe not found' }
# The generator for the installed Visual Studio (GitHub's windows-latest has VS 2026, older PCs VS 2022).
$vsMajor = [int](& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationVersion).Split('.')[0]
$generator = switch ($vsMajor) { 17 { 'Visual Studio 17 2022' } 18 { 'Visual Studio 18 2026' } default { throw "Visual Studio $vsMajor is not supported by this script" } }
Write-Host "CMake: $cmake ($generator)"
$iscc = Find-Tool 'ISCC.exe' @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe")
$node = (Get-Command node.exe).Source
$flutter = Find-Tool 'flutter.bat' @("$env:USERPROFILE\Tools\flutter\bin\flutter.bat")

function Run($exe, [string[]]$argList, $dir = $root) {
  Push-Location $dir
  try {
    & $exe @argList
    if ($LASTEXITCODE -ne 0) { throw "$exe $($argList -join ' ') failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
}

# ---- builds ----
if (-not $SkipBuild) {
  foreach ($p in 'capture', 'injector', 'tray', 'screens') {
    if (-not (Test-Path "$root\$p\build")) { Run $cmake @('-S', $p, '-B', "$p/build", '-G', $generator, '-A', 'x64') }
    Run $cmake @('--build', "$p/build", '--config', 'Release')
  }
  if (-not $SkipClient) { Run $flutter @('build', 'windows', '--release') "$root\client" }
}

New-Item -ItemType Directory -Force $out | Out-Null
$notices = Join-Path $here 'THIRD-PARTY-NOTICES.txt'

# ---- host ----
if (-not $SkipHost) {
  $h = Join-Path $stage 'host'
  if (Test-Path $h) { Remove-Item -Recurse -Force $h }
  New-Item -ItemType Directory -Force "$h\bin", "$h\node", "$h\host", "$h\config", "$h\hook\src" | Out-Null
  Copy-Item "$root\tray\build\Release\cockpitcast-tray.exe" "$h\cockpitcast.exe"
  Copy-Item "$root\capture\build\Release\cockpitcast-capture.dll", "$root\injector\build\Release\cockpitcast-injector.exe", "$root\screens\build\Release\cockpitcast-screens.exe" "$h\bin"
  Copy-Item $node "$h\node\node.exe"
  $nodeLicense = Join-Path (Split-Path $node) 'LICENSE'
  if (Test-Path $nodeLicense) { Copy-Item $nodeLicense "$h\node\LICENSE" }
  foreach ($d in 'src', 'public', 'defaults') { Copy-Item -Recurse "$root\host\$d" "$h\host\$d" }
  Copy-Item "$root\host\package.json", "$root\host\package-lock.json" "$h\host"
  Run 'npm.cmd' @('ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline') "$h\host"
  Copy-Item "$root\config\displays.json" "$h\config"
  Copy-Item "$root\hook\build-hook.mjs", "$root\hook\install-hook.mjs", "$root\hook\setup-hook.mjs" "$h\hook"
  Copy-Item "$root\hook\src\*" "$h\hook\src"
  Copy-Item "$root\README.md" $h
  if (Test-Path "$root\LICENSE") { Copy-Item "$root\LICENSE" $h }
  Copy-Item $notices $h
  Run $iscc @("/DAppVersion=$version", '/Qp', "$here\host.iss") $here
}

# ---- client ----
if (-not $SkipClient) {
  $c = Join-Path $stage 'client'
  if (Test-Path $c) { Remove-Item -Recurse -Force $c }
  Copy-Item -Recurse "$root\client\build\windows\x64\runner\Release" $c
  # The Visual C++ runtime next to the app (Microsoft's redistributable files), for PCs without it.
  $crt = Get-ChildItem "$vs\VC\Redist\MSVC" -Directory | Where-Object { Test-Path "$($_.FullName)\x64" } | Sort-Object Name -Descending | Select-Object -First 1
  $crtDir = Get-ChildItem "$($crt.FullName)\x64" -Directory -Filter 'Microsoft.VC14*.CRT' | Select-Object -First 1
  foreach ($dll in 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll') { Copy-Item "$($crtDir.FullName)\$dll" $c }
  if (Test-Path "$root\LICENSE") { Copy-Item "$root\LICENSE" $c }
  Copy-Item $notices $c
  Run $iscc @("/DAppVersion=$version", '/Qp', "$here\client.iss") $here
  $zip = Join-Path $out "CockpitCast-Client-$version-windows.zip"
  if (Test-Path $zip) { Remove-Item $zip }
  Compress-Archive -Path "$c\*" -DestinationPath $zip
}

Get-ChildItem $out | ForEach-Object { '{0,8:N1} MB  {1}' -f ($_.Length / 1MB), $_.Name }
