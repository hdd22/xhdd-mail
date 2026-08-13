# 安全与隐私说明

## 公开仓库中可以保存的内容

- Worker 源码、HTML、CSS、数据库表结构和 `wrangler.example.jsonc`
- D1/R2 的绑定名称，例如 `TEMP_MAIL_DB`、`MAIL_EML`
- 非敏感配置名称和公开示例值

## 不应提交的内容

- Cloudflare API Token、Global API Key 或其他访问令牌
- 真实管理员密码、`admin.sql`、`.dev.vars`、`.env`
- 运行安装脚本后生成的本地 `wrangler.jsonc`
- 真实 Cloudflare Account ID、D1 Database ID、个人化 R2 存储桶名称
- D1 数据导出、R2 中的 `.eml` 邮件、Cookie、会话令牌
- 真实用户邮箱、转发邮箱和生产日志

Cloudflare 资源 ID 通常不是访问凭证，但可能泄露账号和基础设施元数据，因此公开模板使用占位符。真正的密钥应通过 Wrangler Secret 或 Cloudflare 控制台配置，不能写入 `wrangler.jsonc`。

## 发布前检查

```powershell
npm run privacy:check
npm run privacy:check -- --forbid your-real-domain.example --forbid your-private-username
git status --short
git diff --cached
```

如果敏感数据曾进入 Git 提交，仅删除当前文件并不够；应在推送前重建干净仓库，或使用 `git filter-repo` 清理全部历史，并立即轮换已经暴露的凭证。

## 报告漏洞

请不要在公开 Issue 中粘贴令牌、真实邮件或用户数据。仓库维护者应在 GitHub 的 Security Policy 中补充自己的私密联系方式。
