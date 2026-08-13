[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9.-]+\.[a-z]{2,}$')]
  [string]$Domain,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')]
  [string]$AdminEmail,

  [ValidatePattern('^[a-zA-Z0-9_-]{3,32}$')]
  [string]$AdminUsername = 'admin',

  [ValidatePattern('^[a-z0-9][a-z0-9-]{1,62}$')]
  [string]$WorkerName = 'cloudmail-temp-mail',

  [ValidatePattern('^[a-z0-9][a-z0-9-_]{1,62}$')]
  [string]$DatabaseName = 'cloudmail-db',

  [ValidatePattern('^[a-z0-9][a-z0-9-]{1,62}$')]
  [string]$BucketName = 'cloudmail-eml',

  [string]$ExistingDatabaseId,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$configPath = Join-Path $projectRoot 'wrangler.jsonc'
$configTemplatePath = Join-Path $projectRoot 'wrangler.example.jsonc'
$adminSqlPath = Join-Path $projectRoot 'admin.sql'

function Invoke-Checked {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & npx @Arguments
  if ($LASTEXITCODE -ne 0) { throw "命令执行失败：npx $($Arguments -join ' ')" }
}

foreach ($command in @('node', 'npm', 'npx')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "未找到 $command，请先安装 Node.js。" }
}

Push-Location $projectRoot
try {
  Write-Host '1/7 安装项目依赖...'
  & npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install 执行失败。' }

  Write-Host '2/7 检查 Cloudflare 登录状态...'
  Invoke-Checked @('wrangler', 'whoami')

  $databaseId = $ExistingDatabaseId
  if (-not $databaseId) {
    Write-Host "3/7 创建 D1 数据库 $DatabaseName ..."
    $d1Output = (& npx wrangler d1 create $DatabaseName 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "D1 创建失败。若数据库已存在，请使用 -ExistingDatabaseId 传入其 ID。`n$d1Output" }
    $databaseId = [regex]::Match($d1Output, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'IgnoreCase').Value
    if (-not $databaseId) { throw '已创建 D1，但无法从 Wrangler 输出中识别 database_id。' }
  } else {
    Write-Host '3/7 使用已有 D1 数据库...'
  }

  Write-Host "4/7 创建 R2 存储桶 $BucketName ..."
  Invoke-Checked @('wrangler', 'r2', 'bucket', 'create', $BucketName)

  Copy-Item -LiteralPath $configTemplatePath -Destination $configPath -Force
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $config.name = $WorkerName
  $config.d1_databases[0].database_name = $DatabaseName
  $config.d1_databases[0].database_id = $databaseId
  $config.r2_buckets[0].bucket_name = $BucketName
  $config.vars.MAIL_DOMAIN = $Domain
  $config.vars.SUPER_ADMIN_USERNAME = $AdminUsername
  $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8

  Write-Host '5/7 初始化 D1 数据表...'
  Invoke-Checked @('wrangler', 'd1', 'execute', 'TEMP_MAIL_DB', '--remote', '--file=./schema.sql')

  $securePassword = Read-Host '请输入超级管理员密码（至少 12 位）' -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($plainPassword.Length -lt 12) { throw '超级管理员密码至少需要 12 位。' }
    $env:CLOUDMAIL_ADMIN_USERNAME = $AdminUsername
    $env:CLOUDMAIL_ADMIN_PASSWORD = $plainPassword
    $env:CLOUDMAIL_ADMIN_EMAIL = $AdminEmail
    & node .\scripts\generate-admin.mjs | Set-Content -LiteralPath $adminSqlPath -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw '管理员 SQL 生成失败。' }
  } finally {
    $env:CLOUDMAIL_ADMIN_USERNAME = $null
    $env:CLOUDMAIL_ADMIN_PASSWORD = $null
    $env:CLOUDMAIL_ADMIN_EMAIL = $null
    $plainPassword = $null
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  }

  Write-Host '6/7 写入超级管理员...'
  try { Invoke-Checked @('wrangler', 'd1', 'execute', 'TEMP_MAIL_DB', '--remote', '--file=./admin.sql') }
  finally { if (Test-Path -LiteralPath $adminSqlPath) { Remove-Item -LiteralPath $adminSqlPath -Force } }

  if (-not $SkipDeploy) {
    Write-Host '7/7 部署 Worker...'
    Invoke-Checked @('wrangler', 'deploy')
  } else {
    Write-Host '7/7 已跳过部署。稍后可运行 npm run deploy。'
  }

  Write-Host ''
  Write-Host 'Cloudflare 资源和管理员已配置完成。'
  Write-Host "下一步：在 Cloudflare 控制台为 $Domain 启用 Email Routing，并将 Catch-all 操作设置为发送到 Worker $WorkerName。"
} finally {
  if (Test-Path -LiteralPath $adminSqlPath) { Remove-Item -LiteralPath $adminSqlPath -Force }
  Pop-Location
}
