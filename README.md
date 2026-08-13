# CloudMail 临时邮箱系统

CloudMail 是一个部署在 Cloudflare 上的临时邮箱管理系统，使用 Workers 提供网页与 API、Email Routing 接收邮件、D1 保存业务数据、R2 保存原始 `.eml` 邮件。

本仓库是可公开发布的通用版本：不包含生产域名、管理员账号密码、个人邮箱、Cloudflare Account ID、真实 D1 Database ID、API Token、邮件数据或本机路径。

## 功能

- 超级管理员、管理员和普通用户权限
- 管理员添加用户、设置状态和邮箱额度
- 随机邮箱、随机人名邮箱和自定义邮箱
- 收件箱、邮件详情、复制地址、删除邮件
- 仅从正文评分识别 4–8 位验证码，排除日期、订单号和链接参数
- 每 20 秒后台刷新，也可手动刷新
- 历史邮箱按真实创建时间排序
- 桌面、平板和手机响应式布局
- D1 保存用户、邮箱和邮件索引，R2 保存原始邮件

## 技术结构

```text
index.html                         页面和 SVG 图标
styles.css                        一屏式响应布局与深色模式
app.js                            前端渲染、交互和验证码识别
worker.js                         Worker HTTP API 与 Email Worker
schema.sql                        D1 数据表及索引
wrangler.example.jsonc            Cloudflare 绑定公开模板
scripts/generate-admin.mjs        生成带随机盐的管理员密码哈希 SQL
scripts/setup-cloudflare.ps1      Windows 一键初始化和部署脚本
scripts/privacy-check.mjs         GitHub 发布前隐私扫描
SECURITY.md                       安全与隐私发布清单
```

## 环境要求

- 一个托管在 Cloudflare DNS 中的域名
- Node.js 与 npm
- 一个 Cloudflare 账号
- Windows PowerShell（使用自动安装脚本时）

## 推荐安装方式（Windows）

克隆仓库后，在项目目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-cloudflare.ps1 `
  -Domain "example.com" `
  -AdminEmail "admin@example.com" `
  -AdminUsername "admin"
```

脚本会依次：

1. 安装 Wrangler 并确认 Cloudflare 登录状态。
2. 创建 D1 数据库与 R2 存储桶。
3. 从 `wrangler.example.jsonc` 生成被 Git 忽略的本地 `wrangler.jsonc`，再写入资源名称、资源 ID、域名和超级管理员账号。
4. 初始化数据库表。
5. 安全提示输入管理员密码，在本机生成 PBKDF2 哈希并写入 D1。
6. 删除临时 `admin.sql` 并部署 Worker。

脚本不会把管理员明文密码写入项目文件。若已有 D1，可添加：

```powershell
-ExistingDatabaseId "YOUR_EXISTING_D1_DATABASE_ID"
```

R2 存储桶需要使用一个尚未占用的名称。

## 手动部署

### 1. 安装与登录

```powershell
npm install
npx wrangler login
```

### 2. 创建资源

```powershell
npx wrangler d1 create cloudmail-db
npx wrangler r2 bucket create cloudmail-eml
```

先复制配置模板：

```powershell
Copy-Item .\wrangler.example.jsonc .\wrangler.jsonc
```

然后编辑本地 `wrangler.jsonc`，替换：

- `REPLACE_WITH_YOUR_D1_DATABASE_NAME`
- `REPLACE_WITH_YOUR_D1_DATABASE_ID`
- `REPLACE_WITH_YOUR_R2_BUCKET_NAME`
- `example.com`
- `SUPER_ADMIN_USERNAME` 的示例账号

### 3. 初始化数据库

```powershell
npm run db:init
```

### 4. 创建超级管理员

不要把真实密码直接写进 README、脚本或 Git。可以只在当前终端临时设置环境变量：

```powershell
$env:CLOUDMAIL_ADMIN_USERNAME = "admin"
$env:CLOUDMAIL_ADMIN_PASSWORD = Read-Host "管理员密码"
$env:CLOUDMAIL_ADMIN_EMAIL = "admin@example.com"
node .\scripts\generate-admin.mjs | Set-Content -Encoding utf8 admin.sql
npx wrangler d1 execute TEMP_MAIL_DB --remote --file=./admin.sql
Remove-Item -LiteralPath .\admin.sql -Force
$env:CLOUDMAIL_ADMIN_USERNAME = $null
$env:CLOUDMAIL_ADMIN_PASSWORD = $null
$env:CLOUDMAIL_ADMIN_EMAIL = $null
```

### 5. 部署 Worker

```powershell
npm run deploy
```

### 6. 配置邮件接收

在 Cloudflare 控制台中：

1. 进入 **Email Routing**，为域名完成启用流程。
2. 确认 Cloudflare 添加的 MX/SPF/DKIM 记录生效。
3. 在 **Routing Rules** 中启用 Catch-all。
4. Catch-all 的 Action 选择 **Send to a Worker**。
5. 选择刚部署的 `cloudmail-temp-mail` Worker。
6. 给系统中已经创建的邮箱发送测试邮件。

Cloudflare 官方说明：[Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/) 与 [Routing Rules](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)。

## GitHub 发布前检查

```powershell
npm run privacy:check
npm run privacy:check -- --forbid your-real-domain.example --forbid your-private-username
```

然后人工确认：

```powershell
git status --short
git diff --cached
```

确认无误后可以创建一个全新的 Git 仓库，避免把旧目录中可能存在的历史敏感信息带入 GitHub：

```powershell
git init
git add .
git commit -m "Initial public release"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_NAME/YOUR_REPOSITORY.git
git push -u origin main
```

在 GitHub 创建空仓库时，不要预先添加 README 或 `.gitignore`，可避免第一次推送产生无关冲突。

`.gitignore` 已排除本地 `wrangler.jsonc`、`.env`、`.dev.vars`、`admin.sql`、日志、截图、Wrangler 本地状态和依赖目录；仓库只提交无真实资源 ID 的 `wrangler.example.jsonc`。更完整的说明见 [SECURITY.md](./SECURITY.md)。

## 本地开发

```powershell
npm install
npm run dev
```

真实收件需要 Cloudflare Email Routing。不要在本地开发时连接包含真实用户和邮件的生产 D1/R2，除非你明确理解远程绑定带来的数据风险。

## 注意

- `SUPER_ADMIN_USERNAME` 不是密码，但决定哪个账号拥有最高权限。
- 管理员密码只以带随机盐的 PBKDF2 哈希保存在 D1。
- `database_id` 和 Account ID 不等同于 API Token，但公开模板仍将其替换，以减少基础设施元数据暴露。
- 本仓库未预设开源许可证；公开发布前请根据你希望授予他人的权限选择许可证。
