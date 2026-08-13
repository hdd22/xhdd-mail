import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skippedDirectories = new Set([".git", ".wrangler", "node_modules"]);
const textExtensions = new Set([".css", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".ps1", ".sh", ".sql", ".toml", ".txt", ".yml", ".yaml"]);
const extraForbidden = process.argv.flatMap((value, index, values) => value === "--forbid" ? [values[index + 1]] : []).filter(Boolean);

const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["Cloudflare/account-like ID", /\b[0-9a-f]{32}\b/i],
  ["resource UUID", /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i],
  ["local Windows path", /\b[A-Z]:\\(?:Users|Documents|Desktop|Downloads|hdd-xm)\\/i],
  ["non-example email", /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["assigned credential", /\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|API_TOKEN|API_SECRET|ACCESS_KEY|PRIVATE_KEY)\s*[:=]\s*["']?(?!REPLACE_|CHANGE_ME|example)[^\s"']{8,}/i],
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (textExtensions.has(extname(entry.name)) || entry.name === ".gitignore") files.push(path);
  }
  return files;
}

const findings = [];
for (const path of await filesUnder(root)) {
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [label, pattern] of checks) if (pattern.test(line)) findings.push({ file: relative(root, path), line: index + 1, label });
    for (const value of extraForbidden) if (line.toLowerCase().includes(value.toLowerCase())) findings.push({ file: relative(root, path), line: index + 1, label: "user-supplied private value" });
  });
}

if (findings.length) {
  console.error("发现可能不适合公开的信息：");
  for (const finding of findings) console.error(`- ${finding.file}:${finding.line} (${finding.label})`);
  process.exitCode = 1;
} else {
  console.log("隐私扫描通过：未发现常见密钥、真实资源 ID、个人邮箱或本机路径。");
}
