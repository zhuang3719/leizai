# A1 · 免构建前端发布（webui 源 → webui/dist 静态根，供 src/server.js serveStatic 托管）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-webui.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'webui'
$dst  = Join-Path $src  'dist'

if (-not (Test-Path $src)) { throw "webui 源目录不存在: $src" }
# 清理旧 dist（若被占用则跳过清理，改为覆盖复制，避免整体失败）
if (Test-Path $dst) {
  try { Remove-Item -Recurse -Force $dst -ErrorAction Stop } catch { Write-Warning "dist 占用中，改为覆盖复制：$($_.Exception.Message)" }
}
New-Item -ItemType Directory -Path $dst -Force | Out-Null

# 仅发布运行时需要的部分（排除 dist 自身与草稿备份）
$items = @('index.html', 'styles', 'assets', 'js', 'vendor')
foreach ($it in $items) {
  $s = Join-Path $src $it
  if (Test-Path $s) { Copy-Item -Recurse -Force $s (Join-Path $dst $it) }
}

# 清理误入 dist 的备份/临时文件（*.bak* / *~），避免污染部署目录
Get-ChildItem -Recurse -File $dst -Include *.bak*,*~ -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# 校验关键文件
$need = @('index.html', 'js\app.js', 'vendor\vue.esm-browser.js', 'styles\themes.css')
foreach ($n in $need) {
  if (-not (Test-Path (Join-Path $dst $n))) { throw "发布缺失关键文件: $n" }
}
Write-Output ("WEBUI BUILD OK -> " + $dst)
Get-ChildItem -Recurse $dst -File | Measure-Object -Property Length -Sum | ForEach-Object { Write-Output ("files=" + $_.Count + " bytes=" + $_.Sum) }
