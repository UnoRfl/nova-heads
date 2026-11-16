# Builds NovaStreamHub-win-x64.zip: the app + an untouched copy of the Electron runtime + launcher.
# Run from the repo root after `cd app; npm install`.   Output: dist\NovaStreamHub-win-x64.zip
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "dist"
$stage = Join-Path $out "NovaStreamHub"
$electron = Join-Path $root "app\node_modules\electron\dist"
if (-not (Test-Path (Join-Path $electron "electron.exe"))) { throw "Run 'npm install' in app\ first." }

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force (Join-Path $stage "app\fonts"), (Join-Path $stage "heads") | Out-Null

# app files (no node_modules)
Get-ChildItem (Join-Path $root "app") -File | Where-Object { $_.Name -ne "package-lock.json" } |
  Copy-Item -Destination (Join-Path $stage "app")
Copy-Item (Join-Path $root "app\fonts\*.woff2") (Join-Path $stage "app\fonts")
# any other asset folders (petals, ...) - everything except node_modules and fonts (done above)
Get-ChildItem (Join-Path $root "app") -Directory | Where-Object { $_.Name -notin @("node_modules", "fonts") } |
  ForEach-Object { Copy-Item -Recurse $_.FullName (Join-Path $stage "app\$($_.Name)") }
# runtime: the official Electron build, unmodified (keeps its signature/reputation for SmartScreen & Smart App Control)
Copy-Item -Recurse $electron (Join-Path $stage "runtime")
Copy-Item (Join-Path $root "Start Nova StreamHub.bat"), (Join-Path $root "Start Nova Heads.bat"), (Join-Path $root "README.md"), (Join-Path $root "LICENSE") $stage
Copy-Item (Join-Path $root "heads\README.txt") (Join-Path $stage "heads")

$zip = Join-Path $out "NovaStreamHub-win-x64.zip"
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
"built $zip ($([math]::Round((Get-Item $zip).Length / 1MB)) MB)"
