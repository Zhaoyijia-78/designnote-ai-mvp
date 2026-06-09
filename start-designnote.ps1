$ErrorActionPreference = "Stop"
$SystemNode = "C:\Program Files\nodejs\node.exe"
$BundledNode = "C:\Users\86182\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (Test-Path $SystemNode) {
  & $SystemNode server.js
  exit $LASTEXITCODE
}

if (Test-Path $BundledNode) {
  & $BundledNode server.js
  exit $LASTEXITCODE
}

Write-Host "Node.js was not found. Please install Node.js LTS and run: node server.js"
exit 1
