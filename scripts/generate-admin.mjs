import { webcrypto } from "node:crypto";

const crypto = webcrypto;
const encoder = new TextEncoder();
const [argumentUsername, argumentPassword, argumentEmail] = process.argv.slice(2);
const username = argumentUsername || process.env.CLOUDMAIL_ADMIN_USERNAME;
const password = argumentPassword || process.env.CLOUDMAIL_ADMIN_PASSWORD;
const email = argumentEmail || process.env.CLOUDMAIL_ADMIN_EMAIL;

if (!username || !password || !email) {
  throw new Error("请通过参数或 CLOUDMAIL_ADMIN_USERNAME / CLOUDMAIL_ADMIN_PASSWORD / CLOUDMAIL_ADMIN_EMAIL 环境变量提供管理员资料");
}

if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) throw new Error("管理员账号格式不正确");
if (password.length < 12) throw new Error("管理员密码至少需要 12 位");

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const passwordHash = `pbkdf2$${hex(salt)}$${hex(new Uint8Array(bits))}`;
const sqlValue = (value) => `'${String(value).replaceAll("'", "''")}'`;

console.log(`INSERT INTO users(username,email,password_hash,role,status,quota)
VALUES(${sqlValue(username)},${sqlValue(email)},${sqlValue(passwordHash)},'admin','active',999)
ON CONFLICT(username) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,role='admin',status='active',quota=999;`);
