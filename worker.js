import HTML from "./index.html";
import STYLES from "./styles.css";
import APP from "./app.js";

const encoder = new TextEncoder();

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function response(body, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  return new Response(body, { ...init, headers });
}

function json(data, status = 200, headers = {}) {
  return response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  return new Uint8Array(String(value).match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) || []);
}

function safeEqual(a, b) {
  const left = hexToBytes(a);
  const right = hexToBytes(b);
  if (left.length !== right.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(left, right);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function derivePassword(password, saltHex = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: 100000 }, key, 256);
  return `pbkdf2$${saltHex}$${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  if (!stored?.startsWith("pbkdf2$")) return safeEqual(await sha256(password), stored || "");
  const [, salt, expected] = stored.split("$");
  const actual = (await derivePassword(password, salt)).split("$")[2];
  return safeEqual(actual, expected);
}

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function cookieToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const part = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("cloudmail_session="));
  return part ? decodeURIComponent(part.slice(13)) : "";
}

function superAdminUsername(env) {
  return String(env.SUPER_ADMIN_USERNAME || "admin").trim();
}

function sameUsername(left, right) {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

async function authenticate(request, env) {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  return env.TEMP_MAIL_DB.prepare(`
    SELECT u.username, u.email, CASE WHEN u.username=? COLLATE NOCASE THEN 'super_admin' ELSE u.role END role, u.status, u.quota, u.last_login_at,
      (SELECT COUNT(*) FROM inboxes i WHERE i.owner_username = u.username) AS used
    FROM sessions s JOIN users u ON u.username = s.username
    WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.status = 'active'
  `).bind(superAdminUsername(env), tokenHash).first();
}

async function requestJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) throw new Error("请求格式错误");
  return request.json();
}

function validLocalPart(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._+-]{2,31}$/i.test(value);
}

function validUsername(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{3,32}$/.test(value);
}

function validEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

async function requireUser(request, env) {
  const user = await authenticate(request, env);
  return user ? { user } : { error: json({ error: "请先登录" }, 401) };
}

async function requireAdmin(request, env) {
  const auth = await requireUser(request, env);
  if (auth.error) return auth;
  return ["super_admin", "admin"].includes(auth.user.role) ? auth : { error: json({ error: "仅管理员可执行此操作" }, 403) };
}

function isAdminRole(role) {
  return role === "super_admin" || role === "admin";
}

async function api(request, env, url) {
  const method = request.method;
  const path = url.pathname;

  if (path === "/api/login" && method === "POST") {
    const body = await requestJson(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const attempts = await env.TEMP_MAIL_DB.prepare("SELECT COUNT(*) count FROM login_attempts WHERE ip=? AND attempted_at > datetime('now','-15 minutes')").bind(ip).first();
    if (Number(attempts?.count) >= 10) return json({ error: "登录尝试过多，请 15 分钟后重试" }, 429);
    const user = await env.TEMP_MAIL_DB.prepare("SELECT username,email,password_hash,CASE WHEN username=? COLLATE NOCASE THEN 'super_admin' ELSE role END role,status,quota FROM users WHERE username = ? COLLATE NOCASE").bind(superAdminUsername(env), username).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      await env.TEMP_MAIL_DB.prepare("INSERT INTO login_attempts(ip) VALUES(?)").bind(ip).run();
      return json({ error: "账号或密码错误" }, 401);
    }
    if (user.status === "disabled") return json({ error: "该账号已被禁用，请联系管理员" }, 403);
    await env.TEMP_MAIL_DB.prepare("DELETE FROM login_attempts WHERE ip=? OR attempted_at <= datetime('now','-15 minutes')").bind(ip).run();
    if (!user.password_hash.startsWith("pbkdf2$")) {
      await env.TEMP_MAIL_DB.prepare("UPDATE users SET password_hash=? WHERE username=?").bind(await derivePassword(password), user.username).run();
    }
    const token = randomToken();
    const tokenHash = await sha256(token);
    await env.TEMP_MAIL_DB.prepare("UPDATE users SET last_login_at=datetime('now') WHERE username=?").bind(user.username).run();
    await env.TEMP_MAIL_DB.prepare("DELETE FROM sessions WHERE username = ? OR expires_at <= datetime('now')").bind(user.username).run();
    await env.TEMP_MAIL_DB.prepare("INSERT INTO sessions(token_hash,username,expires_at) VALUES(?,?,datetime('now','+7 days'))").bind(tokenHash, user.username).run();
    return json({ user: { username: user.username, email: user.email, role: user.role, status: user.status, quota: user.quota }, domain: env.MAIL_DOMAIN }, 200, {
      "Set-Cookie": `cloudmail_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
    });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = cookieToken(request);
    if (token) await env.TEMP_MAIL_DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": "cloudmail_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" });
  }

  if (path === "/api/me" && method === "GET") {
    const auth = await requireUser(request, env);
    return auth.error || json({ user: auth.user, domain: env.MAIL_DOMAIN });
  }

  if (path === "/api/inboxes" && method === "GET") {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    const query = isAdminRole(auth.user.role)
      ? `SELECT i.id,i.local_part,i.owner_username,i.created_at,i.expires_at,i.is_favorite,COUNT(m.id) mail_count,
           SUM(CASE WHEN m.forward_status='success' THEN 1 ELSE 0 END) forwarded_count,
           SUM(CASE WHEN m.forward_status='failed' THEN 1 ELSE 0 END) failed_count
         FROM inboxes i LEFT JOIN messages m ON m.inbox_id=i.id GROUP BY i.id ORDER BY i.created_at DESC`
      : `SELECT i.id,i.local_part,i.owner_username,i.created_at,i.expires_at,i.is_favorite,COUNT(m.id) mail_count,
           SUM(CASE WHEN m.forward_status='success' THEN 1 ELSE 0 END) forwarded_count,
           SUM(CASE WHEN m.forward_status='failed' THEN 1 ELSE 0 END) failed_count
         FROM inboxes i LEFT JOIN messages m ON m.inbox_id=i.id WHERE i.owner_username=? GROUP BY i.id ORDER BY i.created_at DESC`;
    const statement = env.TEMP_MAIL_DB.prepare(query);
    const result = isAdminRole(auth.user.role) ? await statement.all() : await statement.bind(auth.user.username).all();
    return json({ inboxes: result.results || [], domain: env.MAIL_DOMAIN });
  }

  if (path === "/api/inboxes" && method === "POST") {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    const body = await requestJson(request);
    const localPart = String(body.localPart || "").trim().toLowerCase();
    if (!validLocalPart(localPart)) return json({ error: "邮箱名需为 3–32 位字母、数字或 . _ + -" }, 400);
    if (!isAdminRole(auth.user.role) && Number(auth.user.used) >= Number(auth.user.quota)) return json({ error: "邮箱额度已用完" }, 403);
    const id = crypto.randomUUID();
    const inboxTokenHash = await sha256(randomToken());
    const expiry = body.permanent ? "+10 years" : `+${Math.min(720, Math.max(1, Number(body.hours) || 24))} hours`;
    try {
      await env.TEMP_MAIL_DB.prepare("INSERT INTO inboxes(id,local_part,token_hash,expires_at,owner_username) VALUES(?,?,?,datetime('now',?),?)")
        .bind(id, localPart, inboxTokenHash, expiry, auth.user.username).run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return json({ error: "该邮箱地址已存在" }, 409);
      throw error;
    }
    return json({ inbox: { id, local_part: localPart, owner_username: auth.user.username } }, 201);
  }

  const inboxMessages = path.match(/^\/api\/inboxes\/([^/]+)\/messages$/);
  if (inboxMessages && method === "GET") {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    const inboxId = decodeURIComponent(inboxMessages[1]);
    const inbox = await env.TEMP_MAIL_DB.prepare("SELECT id,owner_username FROM inboxes WHERE id=?").bind(inboxId).first();
    if (!inbox || (!isAdminRole(auth.user.role) && inbox.owner_username !== auth.user.username)) return json({ error: "邮箱不存在" }, 404);
    const result = await env.TEMP_MAIL_DB.prepare("SELECT id,sender_address,sender_name,subject,text_body,raw_size,attachment_count,received_at,forward_status,forward_error FROM messages WHERE inbox_id=? ORDER BY received_at DESC LIMIT 200").bind(inboxId).all();
    return json({ messages: result.results || [] });
  }

  const inboxRoute = path.match(/^\/api\/inboxes\/([^/]+)$/);
  if (inboxRoute && (method === "PATCH" || method === "DELETE")) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    const inboxId = decodeURIComponent(inboxRoute[1]);
    const inbox = await env.TEMP_MAIL_DB.prepare("SELECT id,owner_username FROM inboxes WHERE id=?").bind(inboxId).first();
    if (!inbox || (!isAdminRole(auth.user.role) && inbox.owner_username !== auth.user.username)) return json({ error: "邮箱不存在" }, 404);
    if (method === "PATCH") {
      const body = await requestJson(request);
      await env.TEMP_MAIL_DB.prepare("UPDATE inboxes SET is_favorite=? WHERE id=?").bind(body.favorite ? 1 : 0, inboxId).run();
      return json({ ok: true });
    }
    if (env.MAIL_EML) {
      let cursor;
      do {
        const listed = await env.MAIL_EML.list({ prefix: `messages/${inboxId}/`, cursor });
        if (listed.objects.length) await env.MAIL_EML.delete(listed.objects.map((object) => object.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
    await env.TEMP_MAIL_DB.prepare("DELETE FROM inboxes WHERE id=?").bind(inboxId).run();
    return json({ ok: true });
  }

  const messageRoute = path.match(/^\/api\/messages\/([^/]+)$/);
  if (messageRoute && (method === "GET" || method === "DELETE")) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    const id = decodeURIComponent(messageRoute[1]);
    const item = await env.TEMP_MAIL_DB.prepare("SELECT m.*,i.owner_username FROM messages m JOIN inboxes i ON i.id=m.inbox_id WHERE m.id=?").bind(id).first();
    if (!item || (!isAdminRole(auth.user.role) && item.owner_username !== auth.user.username)) return json({ error: "邮件不存在" }, 404);
    if (method === "DELETE") {
      await env.TEMP_MAIL_DB.prepare("DELETE FROM messages WHERE id=?").bind(id).run();
      if (item.r2_key && env.MAIL_EML) await env.MAIL_EML.delete(item.r2_key);
      return json({ ok: true });
    }
    delete item.owner_username;
    return json({ message: item });
  }

  if (path === "/api/forward" && (method === "GET" || method === "PUT")) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (method === "GET") {
      const setting = await env.TEMP_MAIL_DB.prepare("SELECT target_email,enabled,verified FROM forward_settings WHERE username=?").bind(auth.user.username).first();
      return json({ setting: setting || { target_email: "", enabled: 0, verified: 0 } });
    }
    const body = await requestJson(request);
    const target = String(body.targetEmail || "").trim().toLowerCase();
    if (target && !validEmail(target)) return json({ error: "目标邮箱格式错误" }, 400);
    await env.TEMP_MAIL_DB.prepare("INSERT INTO forward_settings(username,target_email,enabled,verified) VALUES(?,?,?,0) ON CONFLICT(username) DO UPDATE SET target_email=excluded.target_email,enabled=excluded.enabled,verified=CASE WHEN target_email=excluded.target_email THEN verified ELSE 0 END")
      .bind(auth.user.username, target, body.enabled ? 1 : 0).run();
    return json({ ok: true, message: target ? "已保存；目标地址需在 Cloudflare Email Routing 中验证后才能转发" : "已关闭转发" });
  }

  if (path === "/api/users" && (method === "GET" || method === "POST")) {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    if (method === "GET") {
      const superAdmin = superAdminUsername(env);
      const keyword = String(url.searchParams.get("keyword") || "").trim().slice(0, 100);
      const role = ["super_admin", "admin", "user"].includes(url.searchParams.get("role")) ? url.searchParams.get("role") : "all";
      const status = ["active", "disabled"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "all";
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const pageSize = [10, 20, 50, 100].includes(Number(url.searchParams.get("pageSize"))) ? Number(url.searchParams.get("pageSize")) : 10;
      const where = [];
      const bindings = [];
      if (keyword) { where.push("(u.username LIKE ? OR u.email LIKE ?)"); bindings.push(`%${keyword}%`, `%${keyword}%`); }
      if (role === "super_admin") { where.push("u.username=? COLLATE NOCASE"); bindings.push(superAdmin); }
      else if (role === "admin") { where.push("u.role='admin' AND u.username<>? COLLATE NOCASE"); bindings.push(superAdmin); }
      else if (role === "user") where.push("u.role='user'");
      if (status !== "all") { where.push("u.status=?"); bindings.push(status); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const stats = await env.TEMP_MAIL_DB.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN date(created_at)=date('now') THEN 1 ELSE 0 END) today,
        SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) disabled FROM users`).first();
      const count = await env.TEMP_MAIL_DB.prepare(`SELECT COUNT(*) count FROM users u ${clause}`).bind(...bindings).first();
      const result = await env.TEMP_MAIL_DB.prepare(`SELECT u.username,u.email,CASE WHEN u.username=? COLLATE NOCASE THEN 'super_admin' ELSE u.role END role,u.status,u.quota,u.created_at,u.last_login_at,
        (SELECT COUNT(*) FROM inboxes i WHERE i.owner_username=u.username) mailbox_count
        FROM users u ${clause}
        ORDER BY CASE WHEN u.username=? COLLATE NOCASE THEN 0 WHEN u.role='admin' THEN 1 ELSE 2 END,u.created_at DESC
        LIMIT ? OFFSET ?`).bind(superAdmin, ...bindings, superAdmin, pageSize, (page - 1) * pageSize).all();
      return json({ users: result.results || [], total: Number(count?.count || 0), page, pageSize, stats: {
        total: Number(stats?.total || 0), today: Number(stats?.today || 0), active: Number(stats?.active || 0), disabled: Number(stats?.disabled || 0),
      } });
    }
    const body = await requestJson(request);
    const username = String(body.username || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const requestedRole = ["admin", "user"].includes(body.role) ? body.role : "user";
    const role = auth.user.role === "super_admin" ? requestedRole : "user";
    const status = body.status === "disabled" ? "disabled" : "active";
    const quota = Math.min(999, Math.max(1, Number(body.quota) || 1));
    if (!validUsername(username) || password.length < 6) return json({ error: "账号需为 3–32 位，密码至少 6 位" }, 400);
    if (!validEmail(email)) return json({ error: "登录邮箱格式错误" }, 400);
    try {
      await env.TEMP_MAIL_DB.prepare("INSERT INTO users(username,email,password_hash,role,status,quota) VALUES(?,?,?,?,?,?)")
        .bind(username, email, await derivePassword(password), role, status, quota).run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return json({ error: "账号或登录邮箱已存在" }, 409);
      throw error;
    }
    return json({ ok: true }, 201);
  }

  if (path === "/api/users/batch" && method === "POST") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    const body = await requestJson(request);
    const usernames = [...new Set((Array.isArray(body.usernames) ? body.usernames : []).map(String))].slice(0, 100);
    if (!usernames.length) return json({ error: "请选择用户" }, 400);
    const action = String(body.action || "");
    const skipped = [];
    for (const username of usernames) {
      const target = await env.TEMP_MAIL_DB.prepare("SELECT username,role FROM users WHERE username=?").bind(username).first();
      if (!target || sameUsername(target.username, auth.user.username) || sameUsername(target.username, superAdminUsername(env)) || (auth.user.role !== "super_admin" && target.role !== "user")) { skipped.push(username); continue; }
      if (action === "enable" || action === "disable") {
        await env.TEMP_MAIL_DB.prepare("UPDATE users SET status=? WHERE username=?").bind(action === "enable" ? "active" : "disabled", username).run();
        if (action === "disable") await env.TEMP_MAIL_DB.prepare("DELETE FROM sessions WHERE username=?").bind(username).run();
      } else if (action === "role" && auth.user.role === "super_admin" && ["admin", "user"].includes(body.role)) {
        await env.TEMP_MAIL_DB.prepare("UPDATE users SET role=? WHERE username=?").bind(body.role, username).run();
      } else if (action === "delete") {
        const count = await env.TEMP_MAIL_DB.prepare("SELECT COUNT(*) count FROM inboxes WHERE owner_username=?").bind(username).first();
        if (Number(count?.count) > 0) { skipped.push(username); continue; }
        await env.TEMP_MAIL_DB.prepare("DELETE FROM users WHERE username=?").bind(username).run();
      } else { skipped.push(username); }
    }
    return json({ ok: true, skipped });
  }

  const userRoute = path.match(/^\/api\/users\/([^/]+)$/);
  if (userRoute && (method === "PATCH" || method === "DELETE")) {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    const username = decodeURIComponent(userRoute[1]);
    const target = await env.TEMP_MAIL_DB.prepare("SELECT username,role,status FROM users WHERE username=? COLLATE NOCASE").bind(username).first();
    if (!target) return json({ error: "用户不存在" }, 404);
    const isSelf = sameUsername(target.username, auth.user.username);
    const protectedTarget = sameUsername(target.username, superAdminUsername(env));
    if (method === "DELETE") {
      if (isSelf || protectedTarget) return json({ error: "不能删除当前超级管理员账号" }, 400);
      if (auth.user.role !== "super_admin" && target.role !== "user") return json({ error: "无权删除该用户" }, 403);
      const count = await env.TEMP_MAIL_DB.prepare("SELECT COUNT(*) count FROM inboxes WHERE owner_username=?").bind(target.username).first();
      if (Number(count?.count) > 0) return json({ error: "该用户仍有邮箱，请先处理邮箱后再删除" }, 409);
      await env.TEMP_MAIL_DB.prepare("DELETE FROM users WHERE username=?").bind(target.username).run();
      return json({ ok: true });
    }
    if (auth.user.role !== "super_admin" && target.role !== "user") return json({ error: "无权修改该用户" }, 403);
    const body = await requestJson(request);
    const updates = [];
    const values = [];
    if (Object.hasOwn(body, "email")) {
      const email = String(body.email || "").trim().toLowerCase();
      if (!validEmail(email)) return json({ error: "登录邮箱格式错误" }, 400);
      updates.push("email=?"); values.push(email);
    }
    if (Object.hasOwn(body, "quota")) { updates.push("quota=?"); values.push(Math.min(999, Math.max(1, Number(body.quota) || 1))); }
    if (body.password) {
      if (String(body.password).length < 6) return json({ error: "密码至少 6 位" }, 400);
      updates.push("password_hash=?"); values.push(await derivePassword(String(body.password)));
    }
    if (Object.hasOwn(body, "status") && !isSelf && !protectedTarget && ["active", "disabled"].includes(body.status)) { updates.push("status=?"); values.push(body.status); }
    if (Object.hasOwn(body, "role") && auth.user.role === "super_admin" && !isSelf && !protectedTarget && ["admin", "user"].includes(body.role)) { updates.push("role=?"); values.push(body.role); }
    if (!updates.length) return json({ ok: true });
    values.push(target.username);
    try {
      await env.TEMP_MAIL_DB.prepare(`UPDATE users SET ${updates.join(",")} WHERE username=?`).bind(...values).run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return json({ error: "登录邮箱已被使用" }, 409);
      throw error;
    }
    if (body.status === "disabled" || body.password) await env.TEMP_MAIL_DB.prepare("DELETE FROM sessions WHERE username=?").bind(target.username).run();
    return json({ ok: true });
  }

  return json({ error: "接口不存在" }, 404);
}

function decodeSubject(value) {
  if (!value) return "(无主题)";
  const input = String(value).replace(/(=\?[^?]+\?[bq]\?[^?]+\?=)\s+(?==\?)/gi, "$1");
  return input.replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (word, charset, encoding, data) => {
    try {
      let bytes;
      if (encoding.toLowerCase() === "b") bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      else {
        const source = data.replace(/_/g, " ");
        const values = [];
        for (let index = 0; index < source.length; index += 1) {
          if (source[index] === "=" && /^[0-9A-F]{2}$/i.test(source.slice(index + 1, index + 3))) {
            values.push(Number.parseInt(source.slice(index + 1, index + 3), 16)); index += 2;
          } else values.push(source.charCodeAt(index));
        }
        bytes = new Uint8Array(values);
      }
      return new TextDecoder(charset).decode(bytes);
    } catch { return word; }
  }).slice(0, 500);
}

function senderParts(from) {
  const match = String(from || "").match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
  return match ? { name: match[1]?.trim() || "", address: match[2].trim() } : { name: "", address: String(from || "") };
}

function decodeMailPart(body, encoding) {
  if (/base64/i.test(encoding || "")) {
    try {
      const bytes = Uint8Array.from(atob(body.replace(/\s+/g, "")), (character) => character.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch { return body; }
  }
  if (/quoted-printable/i.test(encoding || "")) {
    const compact = body.replace(/=\r?\n/g, "");
    const bytes = [];
    for (let index = 0; index < compact.length; index += 1) {
      if (compact[index] === "=" && /^[0-9A-F]{2}$/i.test(compact.slice(index + 1, index + 3))) { bytes.push(Number.parseInt(compact.slice(index + 1, index + 3), 16)); index += 2; }
      else bytes.push(compact.charCodeAt(index));
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  }
  return body;
}

function extractTextBody(rawText) {
  const split = rawText.search(/\r?\n\r?\n/);
  if (split < 0) return "";
  const headers = rawText.slice(0, split);
  const body = rawText.slice(split).replace(/^\r?\n\r?\n/, "");
  const boundary = headers.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (boundary) {
    const parts = body.split(`--${boundary}`);
    const candidates = parts.map((part) => {
      const partSplit = part.search(/\r?\n\r?\n/);
      if (partSplit < 0) return null;
      const partHeaders = part.slice(0, partSplit);
      const partBody = part.slice(partSplit).replace(/^\r?\n\r?\n/, "").replace(/\r?\n--$/, "");
      const type = partHeaders.match(/Content-Type:\s*([^;\r\n]+)/i)?.[1]?.toLowerCase() || "";
      const encoding = partHeaders.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i)?.[1] || "";
      return { type, text: decodeMailPart(partBody, encoding) };
    }).filter(Boolean);
    const selected = candidates.find((part) => part.type === "text/plain") || candidates.find((part) => part.type === "text/html");
    if (selected) return selected.type === "text/html" ? selected.text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "").trim() : selected.text.trim();
  }
  const encoding = headers.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i)?.[1] || "";
  return decodeMailPart(body, encoding).trim();
}

async function receiveEmail(message, env) {
  const localPart = String(message.to || "").split("@")[0].toLowerCase();
  const inbox = await env.TEMP_MAIL_DB.prepare("SELECT id,owner_username,expires_at FROM inboxes WHERE local_part=? COLLATE NOCASE AND expires_at > datetime('now')").bind(localPart).first();
  if (!inbox) {
    message.setReject("Mailbox does not exist or has expired");
    return;
  }
  const maxBytes = Number(env.MAX_EMAIL_BYTES || 5242880);
  if (message.rawSize > maxBytes) {
    message.setReject("Message is too large");
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  const id = crypto.randomUUID();
  const messageId = message.headers.get("Message-ID") || id;
  const from = senderParts(message.headers.get("From") || message.from);
  const subject = decodeSubject(message.headers.get("Subject"));
  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  const textBody = extractTextBody(rawText).slice(0, 200000);
  const r2Key = `messages/${inbox.id}/${id}.eml`;
  if (env.MAIL_EML) await env.MAIL_EML.put(r2Key, raw, { httpMetadata: { contentType: "message/rfc822" } });
  const expiry = new Date(Date.now() + Number(env.MESSAGE_TTL_HOURS || 168) * 3600000).toISOString();
  let forwardStatus = "pending";
  let forwardError = null;
  const setting = await env.TEMP_MAIL_DB.prepare("SELECT target_email,enabled,verified FROM forward_settings WHERE username=?").bind(inbox.owner_username).first();
  if (setting?.enabled && setting?.verified && setting?.target_email && message.canBeForwarded) {
    try {
      await message.forward(setting.target_email, new Headers({ "X-Original-Recipient": message.to, "X-Processed-By": "CloudMail" }));
      forwardStatus = "success";
    } catch (error) {
      forwardStatus = "failed";
      forwardError = String(error).slice(0, 500);
    }
  } else if (!setting?.enabled) {
    forwardStatus = "disabled";
  }
  await env.TEMP_MAIL_DB.prepare(`INSERT INTO messages(id,inbox_id,dedupe_key,sender_address,sender_name,subject,text_body,raw_size,attachment_count,expires_at,forward_status,forward_error,r2_key)
    VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)`)
    .bind(id, inbox.id, messageId, from.address, from.name, subject, textBody, message.rawSize, expiry, forwardStatus, forwardError, r2Key).run();
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (url.pathname === "/styles.css") return response(STYLES, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" } });
      if (url.pathname === "/app.js") return response(APP, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
      return response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    } catch (error) {
      console.error(JSON.stringify({ event: "fetch_error", message: String(error), stack: error?.stack }));
      return json({ error: "服务器内部错误" }, 500);
    }
  },
  async email(message, env) {
    try {
      await receiveEmail(message, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "email_error", to: message.to, from: message.from, message: String(error), stack: error?.stack }));
      throw error;
    }
  },
};
