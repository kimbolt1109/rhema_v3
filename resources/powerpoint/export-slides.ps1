<#
  Verger slide renderer (PowerPoint backend).

  Renders EVERY slide of a .pptx to <Out>\slide-NNN.png using the installed PowerPoint via COM. This
  exists because LibreOffice's one-shot `--convert-to png` only emits the first slide, so the app
  prefers PowerPoint on Windows when it is present.

  The deck is opened READ-ONLY with automation macros FORCE-DISABLED (msoAutomationSecurityForceDisable
  = 3), so a hostile deck cannot run macros through this path. Runs in its own process, spawned by the
  main process as a child — the untrusted file is never opened inside Electron.

  Exit 0 with all slides exported, non-zero on any failure (the app then falls back to its other
  renderer / embedded pictures). Only a count is printed; slide text is never emitted.

  Usage: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File export-slides.ps1 -Deck <path> -Out <dir>
#>
param(
  [Parameter(Mandatory = $true)][string]$Deck,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
$pp = $null
$pres = $null
try {
  if (-not (Test-Path -LiteralPath $Deck)) { throw "deck not found: $Deck" }
  New-Item -ItemType Directory -Force -Path $Out | Out-Null

  $pp = New-Object -ComObject PowerPoint.Application
  # Force-disable macros for any file opened by this automation session.
  try { $pp.AutomationSecurity = 3 } catch { }

  # Open(FileName, ReadOnly, Untitled, WithWindow) — read-only, keep the name, no visible window.
  $pres = $pp.Presentations.Open($Deck, $true, $false, $false)
  $count = $pres.Slides.Count
  for ($i = 1; $i -le $count; $i++) {
    $n = '{0:000}' -f $i
    $pres.Slides.Item($i).Export((Join-Path $Out "slide-$n.png"), 'PNG')
  }
  Write-Output "exported $count"
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($null -ne $pres) { try { $pres.Close() } catch { } }
  if ($null -ne $pp) {
    try { $pp.Quit() } catch { }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($pp) } catch { }
  }
}
