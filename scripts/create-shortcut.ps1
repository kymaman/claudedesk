param(
  # Defaults to the parent of this script's folder, so running the script
  # from any clone of the repo creates a shortcut pointing there.
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'ClaudeDesk.lnk'
$target = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$mainJs = Join-Path $ProjectRoot 'dist-electron\main.js'

if (-not (Test-Path $target)) {
  Write-Error "Electron binary not found: $target"
  exit 1
}

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $target
$lnk.Arguments = '"' + $mainJs + '"'
$lnk.WorkingDirectory = $ProjectRoot
$lnk.Description = 'ClaudeDesk - Claude Code session manager'
$lnk.WindowStyle = 1
$lnk.IconLocation = $target + ',0'
$lnk.Save()

Write-Host "Shortcut created at: $lnkPath"
