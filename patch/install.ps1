<#
.SYNOPSIS
  Enables login persistence for the Douyin sidebar by patching DSH's app.asar.

.DESCRIPTION
  DeepSeek Harness gives every sidebar webview a throwaway Electron session, so the
  Douyin login dies with the process.  This script applies the persistence patch to
  the installed DSH desktop application:

    1. locates DeepSeek Harness.exe and its resources\app.asar
    2. refuses to run while DSH is open (the archive is locked, and patching a
       running app would only take effect after a restart anyway)
    3. re-launches itself elevated, because app.asar lives under Program Files
    4. runs patch\cli.mjs, which verifies the archive, writes a timestamped backup,
       patches, and re-verifies the result
    5. optionally starts DSH again

  Nothing is downloaded.  Re-running is safe: an already patched archive is
  reported and left alone.

.PARAMETER DshExe
  Path to "DeepSeek Harness.exe".  Auto-detected when omitted.

.PARAMETER NoRelaunch
  Do not start DSH again after patching.

.PARAMETER CheckOnly
  Read-only: report archive state and whether the patch would apply.  Runs without
  elevation and with DSH open.

.PARAMETER Restore
  Disabled: backups cannot be reliably bound to the current archive.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File patch\install.ps1 -CheckOnly

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File patch\install.ps1
#>
[CmdletBinding()]
param(
  [string]$DshExe,
  [switch]$NoRelaunch,
  [switch]$CheckOnly,
  [switch]$Restore
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Host ""
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

if ($Restore) { Fail 'automatic restore disabled: backups cannot be reliably bound to the current archive; no files were changed' }

function Info([string]$Message) { Write-Host $Message }
function Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------- locate DSH
function Find-DshExe {
  param([string]$Explicit)

  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit)) { Fail "not found: $Explicit" }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }

  $candidates = New-Object System.Collections.Generic.List[string]
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs")
  foreach ($root in $roots) {
    if ($root) { $candidates.Add((Join-Path $root 'DeepSeek Harness\DeepSeek Harness.exe')) }
  }

  # Uninstall entries name the real location even for per-user installs.
  $uninstallRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($key in $uninstallRoots) {
    foreach ($entry in (Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
      if ($entry.DisplayName -like '*DeepSeek Harness*' -and $entry.InstallLocation) {
        $candidates.Add((Join-Path $entry.InstallLocation 'DeepSeek Harness.exe'))
      }
    }
  }

  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path) { return (Resolve-Path -LiteralPath $path).Path }
  }

  Fail ("could not find DeepSeek Harness.exe. Pass -DshExe with its full path, " +
        "for example -DshExe 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'")
}

$exe = Find-DshExe -Explicit $DshExe
$asar = Join-Path (Split-Path -Parent $exe) 'resources\app.asar'
if (-not (Test-Path -LiteralPath $asar)) { Fail "not found: $asar" }

# The archive ships its own Node runtime; prefer it over whatever is on PATH.
$node = Join-Path (Split-Path -Parent $exe) 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if (-not $onPath) { Fail "no Node runtime found next to DSH and none on PATH" }
  $node = $onPath.Source
}

$cli = Join-Path $PSScriptRoot 'cli.mjs'
if (-not (Test-Path -LiteralPath $cli)) { Fail "not found: $cli" }

Info "DSH    : $exe"
Info "archive: $asar"
Info "node   : $node"

# ---------------------------------------------------------------- read-only path
if ($CheckOnly) {
  Step 'checking archive (read only)'
  & $node $cli check --asar $asar
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------- target DSH must be closed
# Only the installation being patched matters, so a second copy of DSH somewhere else
# does not block this one.  Process paths can be unreadable for other users'
# processes, in which case fall back to matching by executable name and refuse.
$locked = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $path = $null
  try { $path = $_.Path } catch { $path = $null }
  if ($path) { return [string]::Equals($path, $exe, 'OrdinalIgnoreCase') }
  return ($_.ProcessName -like 'DeepSeek*Harness*' -or $_.ProcessName -eq 'DeepSeek Harness')
}
if ($locked) {
  $ids = ($locked | Select-Object -ExpandProperty Id) -join ', '
  Info ""
  Info "This DeepSeek Harness is still running (process ids: $ids)."
  Info "Close it completely first - the archive is locked while the app is open,"
  Info "and a running app would keep using the old code anyway."
  Info ""
  Info "Then run this script again."
  exit 2
}

# ---------------------------------------------------------------- elevation
# Only ask for administrator rights when the archive really needs them: a DSH
# installed somewhere the user can already write (a portable copy, a dev checkout)
# must not trigger a pointless UAC prompt.
function Test-Writable([string]$Path) {
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $stream.Close()
    return $true
  } catch {
    return $false
  }
}

$needsElevation = (-not (Test-Administrator)) -and (-not (Test-Writable $asar))
if ($needsElevation) {
  Step 'requesting administrator rights'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-DshExe', "`"$exe`"")
  if ($NoRelaunch) { $arguments += '-NoRelaunch' }
  if ($Restore) { $arguments += '-Restore' }
  try {
    $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -PassThru -Wait
  } catch {
    Fail "administrator rights are required to write $asar (request was cancelled or refused)"
  }
  exit $elevated.ExitCode
}

# ---------------------------------------------------------------- patch or restore
if ($Restore) {
  Step 'restoring the newest backup'
  & $node $cli restore --asar $asar --apply
  if ($LASTEXITCODE -ne 0) { Fail 'restore failed; the archive was left untouched' }
} else {
  Step 'applying the persistence patch'
  & $node $cli apply --asar $asar --apply
  if ($LASTEXITCODE -ne 0) { Fail 'patch failed; the archive was left untouched (a backup may exist next to it)' }
}

if (-not $NoRelaunch) {
  Step 'starting DeepSeek Harness'
  Start-Process -FilePath $exe | Out-Null
}

Info ""
if ($Restore) {
  Info "Done. The original archive is back in place."
} else {
  Info "Done. Open the Douyin panel once and sign in; the login now survives a restart."
}
