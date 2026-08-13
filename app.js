const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const roleLabels = { super_admin: "超级管理员", admin: "管理员", user: "普通用户" };
const statusLabels = { active: "正常", disabled: "已禁用" };

const state = {
  user: null, domain: "example.com", route: "/", inboxes: [], inbox: null, messages: [], selectedMessage: null,
  folder: "inbox", lastRefresh: null, timer: null, selectedUsers: new Set(), users: null,
  generatorLength: 8, generatorCustom: false, customLocalPart: "", historySort: "desc",
};

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function isAdmin() { return ["super_admin", "admin"].includes(state.user?.role); }
function isSuperAdmin() { return state.user?.role === "super_admin"; }
function mailboxAddress(inbox = state.inbox) { return inbox ? `${inbox.local_part}@${state.domain}` : `暂无邮箱@${state.domain}`; }
function formatDate(value, short = false) {
  if (!value) return "—";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return short ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : date.toLocaleString("zh-CN", { hour12: false });
}
function toast(text) {
  const element = $("#toast");
  element.textContent = text;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2200);
}
function copyText(text, label = "内容") {
  return navigator.clipboard.writeText(text).then(() => toast(`“${label}”已复制`));
}
function displayEmailBody(value) {
  let text = String(value || "");
  const plainPart = text.match(/Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?\r?\n([\s\S]*?)(?=\r?\n--[-\w=]+|$)/i);
  if (plainPart) text = plainPart[1];
  text = text.replace(/=\r?\n/g, "").replace(/(?:=[0-9A-F]{2})+/gi, (encoded) => {
    const bytes = encoded.slice(1).split("=").map((hex) => Number.parseInt(hex, 16));
    return new TextDecoder().decode(new Uint8Array(bytes));
  });
  if (/<[a-z][\s\S]*>/i.test(text)) text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, "");
  return text.replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/\n{3,}/g, "\n\n").trim();
}
function displaySubject(value) {
  const input = String(value || "(无主题)").replace(/(=\?[^?]+\?[bq]\?[^?]+\?=)\s+(?==\?)/gi, "$1");
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
  });
}
function recognizeVerificationCode(message) {
  const body = displayEmailBody(message?.text_body || "").slice(0, 20000);
  if (!body) return null;

  // URLs and their query parameters are never treated as verification-code sources.
  const text = body.replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi, (url) => " ".repeat(url.length));
  const keywordPattern = /验证码|校验码|动态码|一次性(?:密码|代码)|登录码|代码(?:是|为|如下)|otp|verification\s*code|security\s*code|one[-\s]?time\s*(?:password|code)|passcode|launch\s*code|code\s*(?:is|below|shown\s+below)|enter(?:ing)?\s+(?:the\s+)?code(?:\s+below)?/gi;
  const keywords = [];
  let keywordMatch;
  while ((keywordMatch = keywordPattern.exec(text))) keywords.push({ start: keywordMatch.index, end: keywordPattern.lastIndex });
  if (!keywords.length) return null;

  const negativeLabel = /(?:订单号?|流水号?|参考号?|编号|手机号|电话号码|日期|时间|快递单号|物流单号|order(?:\s*(?:number|no\.?))?|phone|date|time|tracking(?:\s*(?:number|no\.?)?)?|transaction(?:\s*id)?|reference(?:\s*id)?|ref|id)\s*[:：#=-]?\s*$/i;
  const candidatePattern = /[A-Z0-9]{4,8}/gi;
  let best = null;
  let candidateMatch;
  while ((candidateMatch = candidatePattern.exec(text))) {
    const value = candidateMatch[0].toUpperCase();
    const start = candidateMatch.index;
    const end = start + value.length;
    if (!/\d/.test(value) || /[A-Z0-9]/i.test(text[start - 1] || "") || /[A-Z0-9]/i.test(text[end] || "")) continue;
    if (/^(?:19|20)\d{6}$/.test(value)) continue;

    const around = text.slice(Math.max(0, start - 12), Math.min(text.length, end + 12));
    const dateTimeParts = around.match(/\d{1,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2})?|\d{1,2}:\d{2}(?::\d{2})?/g) || [];
    if (dateTimeParts.some((part) => part.replace(/\D/g, "").includes(value))) continue;

    const before = text.slice(Math.max(0, start - 30), start);
    if (negativeLabel.test(before)) continue;

    let score = 0;
    for (const keyword of keywords) {
      if (start >= keyword.end) {
        const distance = start - keyword.end;
        if (distance <= 48) {
          const connectorBonus = /^(?:\s|[:：,，#=-])*(?:是|为|is|equals)?(?:\s|[:：,，#=-])*$/i.test(text.slice(keyword.end, start)) ? 4 : 0;
          score = Math.max(score, 112 - distance + connectorBonus);
        }
      } else if (end <= keyword.start) {
        const distance = keyword.start - end;
        if (distance <= 20) score = Math.max(score, 82 - distance);
      }
    }
    if (score >= 72 && (!best || score > best.score)) best = { value, source: "正文识别", score };
  }
  return best;
}
function avatarText(username) { return String(username || "U").slice(0, 1).toUpperCase(); }
function secureChoice(items) { return items[crypto.getRandomValues(new Uint32Array(1))[0] % items.length]; }
function randomLocalPart(length = state.generatorLength) {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const characters = `${letters}0123456789`;
  const bytes = crypto.getRandomValues(new Uint8Array(Math.max(4, Math.min(24, Number(length) || 8))));
  let value = letters[bytes[0] % letters.length];
  for (let index = 1; index < bytes.length; index += 1) value += characters[bytes[index] % characters.length];
  return value;
}
function randomPersonLocalPart() {
  const surnames = ["chen", "lin", "wang", "li", "zhang", "liu", "yang", "zhao", "xu", "sun", "zhou", "wu"];
  const names = ["ming", "hao", "yu", "xin", "ran", "ning", "chen", "an", "jia", "rui", "yi", "wen"];
  const suffix = String(crypto.getRandomValues(new Uint16Array(1))[0] % 1000).padStart(3, "0");
  return `${secureChoice(surnames)}${secureChoice(names)}${suffix}`;
}

function showLogin() {
  state.user = null;
  $("#appShell").hidden = true;
  $("#authScreen").hidden = false;
  clearInterval(state.timer);
}
function updateHeader() {
  $("#identityBadge").textContent = roleLabels[state.user.role] || "普通用户";
  $$(".admin-only").forEach((item) => { item.hidden = !isAdmin(); });
  $$("[data-route]").forEach((item) => item.classList.toggle("active", item.dataset.route === state.route));
}
function setTheme(dark) {
  document.body.classList.toggle("dark", dark);
  localStorage.setItem("cloudmail_theme", dark ? "dark" : "light");
}

async function bootstrap() {
  setTheme(localStorage.getItem("cloudmail_theme") === "dark");
  try {
    const result = await api("/api/me");
    state.user = result.user;
    state.domain = result.domain;
    $("#authScreen").hidden = true;
    $("#appShell").hidden = false;
    await navigate(location.pathname, false);
    startAutoRefresh();
  } catch (error) {
    if (error.status !== 401) toast(error.message);
    showLogin();
  }
}

async function navigate(path, push = true) {
  const allowed = ["/", "/users", "/mailboxes"];
  state.route = allowed.includes(path) ? path : "/";
  if (!isAdmin() && state.route !== "/") state.route = "/";
  if (push && location.pathname !== state.route) history.pushState({}, "", state.route);
  updateHeader();
  closeLayer();
  if (state.route === "/users") await loadUsers();
  else if (state.route === "/mailboxes") await loadAllMailboxes();
  else await loadMailWorkspace();
}

async function loadInboxes(preferredId) {
  const result = await api("/api/inboxes");
  state.domain = result.domain;
  state.inboxes = result.inboxes || [];
  const remembered = preferredId || state.inbox?.id;
  state.inbox = state.inboxes.find((item) => item.id === remembered) || state.inboxes[0] || null;
}
async function loadMessages() {
  if (!state.inbox) { state.messages = []; state.selectedMessage = null; return; }
  const result = await api(`/api/inboxes/${encodeURIComponent(state.inbox.id)}/messages`);
  state.messages = result.messages || [];
  state.selectedMessage = state.messages.find((item) => item.id === state.selectedMessage?.id) || state.messages[0] || null;
  state.lastRefresh = new Date();
}
async function loadMailWorkspace(preferredId) {
  await loadInboxes(preferredId);
  await loadMessages();
  renderMailWorkspace();
}

function renderMailWorkspace() {
  $("#appView").innerHTML = `
    <section class="mail-page">
      <div class="workspace">
        ${mailboxSidebarTemplate()}
        <section class="right-workspace">
          ${mailGeneratorTemplate()}
          <div class="mail-workspace">
            ${emailListTemplate()}
            ${emailDetailTemplate()}
          </div>
        </section>
      </div>
    </section>`;
}
function mailGeneratorTemplate() {
  return `<section class="panel generator-panel">
    <div class="generator-intro"><h2>生成随机邮箱</h2><p>快速创建新的临时邮箱地址</p></div>
    <div class="generator-field"><label>邮箱后缀</label><select class="select" disabled><option>${escapeHtml(state.domain)}</option></select></div>
    <div class="generator-field generator-username"><label>${state.generatorCustom ? "自定义用户名" : "用户名长度"}</label>${state.generatorCustom
      ? `<input class="text-input" id="generatorCustomName" maxlength="32" value="${escapeHtml(state.customLocalPart)}" placeholder="输入 3–32 位用户名">`
      : `<div class="range-row"><input type="range" id="generatorLength" min="4" max="24" value="${state.generatorLength}"><output id="generatorLengthValue">${state.generatorLength} 位</output></div>`}</div>
    <div class="generator-actions"><div><button class="button" data-action="generate-random">${icon("dice")}${state.generatorCustom ? "创建邮箱" : "随机生成"}</button><button class="button primary" data-action="generate-person">${icon("users")}随机人名</button></div><button class="button wide" data-action="toggle-generator-mode">${state.generatorCustom ? "返回随机模式" : "切换自定义"}</button></div>
  </section>`;
}
function mailboxSidebarTemplate() {
  const ownUsed = state.inboxes.filter((item) => item.owner_username === state.user.username).length;
  const history = [...state.inboxes].sort((left, right) => {
    const leftTime = new Date(String(left.created_at || "").includes("T") ? left.created_at : `${String(left.created_at || "").replace(" ", "T")}Z`).getTime() || 0;
    const rightTime = new Date(String(right.created_at || "").includes("T") ? right.created_at : `${String(right.created_at || "").replace(" ", "T")}Z`).getTime() || 0;
    return state.historySort === "desc" ? rightTime - leftTime : leftTime - rightTime;
  }).map((item) => `
    <div class="history-item ${item.id === state.inbox?.id ? "active" : ""}" data-mailbox-id="${escapeHtml(item.id)}">
      <span class="history-dot"></span>
      <span class="history-text"><strong>${escapeHtml(mailboxAddress(item))}</strong><small>${formatDate(item.created_at, true)}${isAdmin() ? ` · ${escapeHtml(item.owner_username || "未分配")}` : ""}</small></span>
      <button class="history-delete" data-action="delete-mailbox" data-id="${escapeHtml(item.id)}" title="删除邮箱">${icon("trash")}</button>
    </div>`).join("");
  return `<aside class="panel mailbox-sidebar" id="mailboxSidebar">
    <h2 class="section-title">${icon("box")}当前邮箱</h2>
    <div class="current-address"><strong>${escapeHtml(mailboxAddress())}</strong><button class="icon-button" data-action="copy-mailbox" title="复制邮箱">${icon("copy")}</button></div>
    <div class="mailbox-primary-actions">
      <button class="button primary" data-action="copy-mailbox">${icon("copy")}复制邮箱</button>
      <button class="button outline" data-action="create-mailbox">${icon("plus")}生成新邮箱</button>
    </div>
    <div class="history-head"><h3>${state.route === "/mailboxes" ? "所有邮箱" : "历史邮箱"}</h3><div class="history-tools"><button class="sort-control" data-action="toggle-history-sort">创建时间 ${state.historySort === "desc" ? "↓" : "↑"}</button><label class="search-box">${icon("search")}<input id="historySearch" placeholder="搜索邮箱"></label></div></div>
    <div class="mailbox-history-list" id="mailboxHistory">${history || `<div class="empty-state"><div>${icon("mail")}<strong>暂无邮箱</strong><span>${isAdmin() ? "生成第一个邮箱" : `额度 ${ownUsed}/${state.user.quota}`}</span></div></div>`}</div>
  </aside>`;
}
function emailListTemplate() {
  const rows = state.folder === "outbox" ? [] : state.messages;
  return `<section class="panel email-list-panel">
    <header class="list-toolbar">
      <button class="icon-button mobile-mailboxes-toggle" data-action="mobile-mailboxes" aria-label="打开邮箱列表">${icon("menu")}</button>
      <nav class="mail-tabs"><button class="mail-tab ${state.folder === "inbox" ? "active" : ""}" data-folder="inbox">收件箱</button><button class="mail-tab ${state.folder === "outbox" ? "active" : ""}" data-folder="outbox">发件箱</button></nav>
      <button class="button small manual-refresh" data-action="manual-refresh" title="立即刷新收件箱">${icon("refresh")}刷新</button>
    </header>
    <div class="email-list" id="emailList">${rows.length ? rows.map(emailItemTemplate).join("") : `<div class="empty-state"><div>${icon("mail")}<strong>${state.folder === "outbox" ? "暂无发件记录" : "收件箱为空"}</strong><span>${state.folder === "outbox" ? "当前系统仅用于接收与转发邮件" : "新邮件到达后会显示在这里"}</span></div></div>`}</div>
    <footer class="list-footer"><span>共 ${rows.length} 封邮件</span><span>最后更新：${state.lastRefresh ? state.lastRefresh.toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span></footer>
  </section>`;
}
function emailItemTemplate(message) {
  const recognition = recognizeVerificationCode(message);
  const code = recognition?.value || "";
  const sender = message.sender_name || message.sender_address || "未知发件人";
  return `<article class="email-item ${message.id === state.selectedMessage?.id ? "active" : ""}" data-message-id="${escapeHtml(message.id)}">
    <div class="email-header"><span class="sender">${escapeHtml(sender)}</span><time>${formatDate(message.received_at, true)}</time></div>
    <div class="email-subject">${escapeHtml(displaySubject(message.subject))}</div>
    <div class="email-actions ${code ? "" : "no-code"}">${code ? `<span class="verification-code">验证码：<b>${escapeHtml(code)}</b></span><span class="recognition-tag">${recognition.source}</span><button class="button small outline" data-action="copy-code" data-code="${escapeHtml(code)}">${icon("copy")}复制验证码</button>` : `<span class="no-verification-code">未识别到验证码</span>`}<button class="button small danger" data-action="delete-message" data-id="${escapeHtml(message.id)}">${icon("trash")}删除</button></div>
  </article>`;
}
function emailDetailTemplate() {
  const message = state.selectedMessage;
  if (!message) return `<section class="panel email-detail-panel" id="emailDetail"><header class="detail-header"><h2>邮件详情</h2></header><div class="empty-state"><div>${icon("mail")}<strong>选择一封邮件</strong><span>邮件内容将在这里显示</span></div></div></section>`;
  const recognition = recognizeVerificationCode(message);
  const code = recognition?.value || "";
  return `<section class="panel email-detail-panel" id="emailDetail">
    <header class="detail-header"><button class="icon-button detail-close" data-action="close-detail">${icon("close")}</button><h2>邮件详情</h2><button class="button small danger" data-action="delete-message" data-id="${escapeHtml(message.id)}">${icon("trash")}删除邮件</button></header>
    <div class="detail-scroll">
      <div class="email-meta"><span>发件人</span><strong>${escapeHtml(message.sender_name ? `${message.sender_name} <${message.sender_address}>` : message.sender_address)}</strong><span>收件人</span><strong>${escapeHtml(mailboxAddress())}</strong><span>接收时间</span><strong>${formatDate(message.received_at)}</strong><span>邮件主题</span><strong>${escapeHtml(displaySubject(message.subject))}</strong></div>
      ${code ? `<div class="code-card"><div><span>验证码</span><strong>${escapeHtml(code)}</strong><small class="recognition-tag">${recognition.source}</small></div><button class="button primary" data-action="copy-code" data-code="${escapeHtml(code)}">${icon("copy")}复制验证码</button></div>` : `<div class="code-card code-empty"><div><span>验证码</span><strong>未识别到验证码</strong><small>正文中没有高可信的 4–8 位验证码</small></div></div>`}
      <div class="email-content"><h3>邮件内容</h3><pre class="email-body">${escapeHtml(displayEmailBody(message.text_body) || "该邮件没有可显示的文本正文")}</pre></div>
    </div>
  </section>`;
}

function openDialog(title, body, footer = "") {
  const dialog = $("#dialog");
  dialog.innerHTML = `<header class="dialog-head"><h2>${escapeHtml(title)}</h2><button class="close-button" data-action="close-dialog">${icon("close")}</button></header><div class="dialog-body">${body}</div>${footer ? `<footer class="dialog-footer">${footer}</footer>` : ""}`;
  if (!dialog.open) dialog.showModal();
}
function closeDialog() { const dialog = $("#dialog"); if (dialog.open) dialog.close(); }
function openDrawer(title, content, footer = "") {
  const drawer = $("#drawer");
  drawer.innerHTML = `<header class="drawer-head"><h2>${escapeHtml(title)}</h2><button class="close-button" data-action="close-layer">${icon("close")}</button></header><div class="drawer-body">${content}</div>${footer ? `<footer class="drawer-footer">${footer}</footer>` : ""}`;
  drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false"); $("#overlay").classList.add("open");
}
function closeLayer() {
  $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); $("#overlay").classList.remove("open");
  $("#emailDetail")?.classList.remove("mobile-open"); $("#mailboxSidebar")?.classList.remove("mobile-open");
}
function confirmAction(title, text, confirmLabel, action, payload = "") {
  openDialog(title, `<p class="danger-note">${escapeHtml(text)}</p>`, `<button class="button" data-action="close-dialog">取消</button><button class="button danger" data-action="${action}" ${payload}>${escapeHtml(confirmLabel)}</button>`);
}
function createMailboxDialog() {
  const random = `${["mail", "nova", "swift", "box", "relay"][crypto.getRandomValues(new Uint8Array(1))[0] % 5]}${crypto.randomUUID().slice(0, 5)}`;
  openDialog("生成新邮箱", `<div class="form-grid"><div class="form-field full"><label>邮箱地址</label><input class="text-input" id="newMailbox" value="${random}" maxlength="32"><small class="form-help">支持字母、数字及 . _ + -</small></div><div class="form-field full"><label>域名</label><select class="select" disabled><option>${escapeHtml(state.domain)}</option></select></div></div>`, `<button class="button" data-action="close-dialog">取消</button><button class="button primary" data-action="confirm-create-mailbox">创建邮箱</button>`);
}

async function createMailboxFromGenerator(kind) {
  const localPart = kind === "person" ? randomPersonLocalPart() : state.generatorCustom ? state.customLocalPart.trim().toLowerCase() : randomLocalPart();
  if (!localPart) return toast("请输入自定义用户名");
  const result = await api("/api/inboxes", { method: "POST", body: JSON.stringify({ localPart, permanent: true }) });
  state.customLocalPart = "";
  await loadMailWorkspace(result.inbox.id);
  toast(`邮箱 ${localPart}@${state.domain} 创建成功`);
}

function usersQuery() {
  const params = new URLSearchParams(location.search);
  return { keyword: params.get("keyword") || "", role: params.get("role") || "all", status: params.get("status") || "all", page: Math.max(1, Number(params.get("page")) || 1), pageSize: [10,20,50,100].includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 10 };
}
async function loadUsers() {
  const query = usersQuery();
  const params = new URLSearchParams({ keyword: query.keyword, role: query.role, status: query.status, page: query.page, pageSize: query.pageSize });
  state.users = await api(`/api/users?${params}`);
  state.selectedUsers.clear();
  renderUsersPage(query);
}
function renderUsersPage(query) {
  const data = state.users;
  const pages = Math.max(1, Math.ceil(data.total / query.pageSize));
  const pageButtons = Array.from({ length: Math.min(5, pages) }, (_, index) => {
    let page = index + 1;
    if (pages > 5 && query.page > 3) page = Math.min(pages - 4 + index, query.page - 2 + index);
    return `<button class="page-button ${page === query.page ? "active" : ""}" data-user-page="${page}">${page}</button>`;
  }).join("");
  $("#appView").innerHTML = `<section class="user-page">
    <header class="page-header"><div><h1>用户管理</h1><p>管理系统用户、权限与账号状态</p></div><button class="button primary" data-action="add-user">${icon("users")}添加用户</button></header>
    <div class="user-stats">${statTemplate("users","用户总数",data.stats.total)}${statTemplate("plus","今日新增",data.stats.today)}${statTemplate("shield","正常用户",data.stats.active)}${statTemplate("out","已禁用",data.stats.disabled)}</div>
    <section class="user-table-card">
      <div class="filter-bar"><label class="search-box">${icon("search")}<input id="userKeyword" value="${escapeHtml(query.keyword)}" placeholder="搜索用户名或邮箱"></label><select class="select" id="roleFilter"><option value="all">全部角色</option>${Object.entries(roleLabels).map(([value,label]) => `<option value="${value}" ${query.role === value ? "selected" : ""}>${label}</option>`).join("")}</select><select class="select" id="statusFilter"><option value="all">全部状态</option><option value="active" ${query.status === "active" ? "selected" : ""}>正常</option><option value="disabled" ${query.status === "disabled" ? "selected" : ""}>已禁用</option></select><button class="button small" data-action="reset-user-filter">重置</button><span class="filter-spacer"></span><select class="select" id="batchAction"><option value="">批量操作</option><option value="enable">批量启用</option><option value="disable">批量禁用</option><option value="delete">批量删除</option><option value="role">批量修改角色</option></select></div>
      <div class="table-scroll"><table class="user-table"><thead><tr><th><input class="check" type="checkbox" id="selectAllUsers"></th><th>用户</th><th>邮箱</th><th>角色</th><th>邮箱数量</th><th>状态</th><th>注册时间</th><th>最后登录</th><th>操作</th></tr></thead><tbody>${data.users.map(userRowTemplate).join("") || `<tr><td colspan="9"><div class="empty-state"><div><strong>没有匹配的用户</strong><span>请调整搜索或筛选条件</span></div></div></td></tr>`}</tbody></table></div>
      <footer class="pagination"><span>共 ${data.total} 位用户</span><div class="pagination-controls"><button class="page-button" data-user-page="${query.page - 1}" ${query.page <= 1 ? "disabled" : ""}>上一页</button>${pageButtons}<button class="page-button" data-user-page="${query.page + 1}" ${query.page >= pages ? "disabled" : ""}>下一页</button><select class="page-size" id="pageSize">${[10,20,50,100].map(size => `<option value="${size}" ${query.pageSize === size ? "selected" : ""}>每页 ${size} 条</option>`).join("")}</select></div></footer>
    </section></section>`;
}
function statTemplate(iconName, label, value) { return `<div class="stat-card"><span class="stat-icon">${icon(iconName)}</span><div><span>${label}</span><strong>${Number(value || 0)}</strong></div></div>`; }
function userRowTemplate(user) {
  const selected = state.selectedUsers.has(user.username);
  return `<tr class="${selected ? "selected" : ""}" data-user-row="${escapeHtml(user.username)}"><td><input class="check user-check" type="checkbox" data-username="${escapeHtml(user.username)}" ${selected ? "checked" : ""}></td><td><div class="user-cell"><span class="avatar">${escapeHtml(avatarText(user.username))}</span><strong>${escapeHtml(user.username)}</strong></div></td><td>${escapeHtml(user.email || "—")}</td><td><span class="badge ${user.role}">${roleLabels[user.role] || user.role}</span></td><td>${Number(user.mailbox_count || 0)}</td><td><span class="badge ${user.status}">${statusLabels[user.status] || user.status}</span></td><td>${formatDate(user.created_at)}</td><td>${formatDate(user.last_login_at)}</td><td><div class="inline-actions"><button class="link-button" data-action="edit-user" data-user="${escapeHtml(user.username)}">编辑</button>${user.status === "disabled" ? `<button class="link-button" data-action="toggle-user" data-user="${escapeHtml(user.username)}" data-status="active">启用</button>` : ""}<button class="more-button" data-action="user-detail" data-user="${escapeHtml(user.username)}">${icon("more")}</button></div></td></tr>`;
}
function userFormDialog(user = null) {
  const editing = Boolean(user);
  const roleOptions = Object.entries(roleLabels).filter(([value]) => value !== "super_admin" || user?.role === "super_admin").map(([value,label]) => `<option value="${value}" ${user?.role === value ? "selected" : ""}>${label}</option>`).join("");
  openDialog(editing ? "编辑用户" : "添加用户", `<form class="form-grid" id="userForm">
    <div class="form-field"><label>用户名</label><input class="text-input" id="formUsername" value="${escapeHtml(user?.username || "")}" ${editing ? "disabled" : ""} required></div>
    <div class="form-field"><label>登录邮箱</label><input class="text-input" id="formEmail" type="email" value="${escapeHtml(user?.email || "")}" required></div>
    <div class="form-field"><label>${editing ? "新密码（留空不修改）" : "初始密码"}</label><input class="text-input" id="formPassword" type="password" ${editing ? "" : "required"}></div>
    <div class="form-field"><label>用户角色</label><select class="select" id="formRole" ${user?.role === "super_admin" ? "disabled" : ""}>${roleOptions}</select></div>
    <div class="form-field"><label>账号状态</label><select class="select" id="formStatus" ${user?.username === state.user.username ? "disabled" : ""}><option value="active" ${user?.status !== "disabled" ? "selected" : ""}>正常</option><option value="disabled" ${user?.status === "disabled" ? "selected" : ""}>已禁用</option></select></div>
    <div class="form-field"><label>邮箱额度</label><input class="text-input" id="formQuota" type="number" min="1" max="999" value="${Number(user?.quota || 5)}"></div>
  </form>`, `<button class="button" data-action="close-dialog">取消</button><button class="button primary" data-action="save-user" ${editing ? `data-user="${escapeHtml(user.username)}"` : ""}>保存</button>`);
}
function userDetailDrawer(user) {
  const protectedUser = user.username === state.user.username || user.role === "super_admin";
  openDrawer("用户详情", `<div class="detail-pair"><span>用户</span><strong>${escapeHtml(user.username)}</strong></div><div class="detail-pair"><span>登录邮箱</span><strong>${escapeHtml(user.email || "—")}</strong></div><div class="detail-pair"><span>角色</span><strong><span class="badge ${user.role}">${roleLabels[user.role]}</span></strong></div><div class="detail-pair"><span>状态</span><strong><span class="badge ${user.status}">${statusLabels[user.status]}</span></strong></div><div class="detail-pair"><span>邮箱数量</span><strong>${Number(user.mailbox_count || 0)}</strong></div><div class="detail-pair"><span>注册时间</span><strong>${formatDate(user.created_at)}</strong></div><div class="detail-pair"><span>最后登录</span><strong>${formatDate(user.last_login_at)}</strong></div>`, `<button class="button" data-action="reset-password" data-user="${escapeHtml(user.username)}">重置密码</button>${protectedUser ? "" : `<button class="button ${user.status === "active" ? "danger" : "outline"}" data-action="toggle-user" data-user="${escapeHtml(user.username)}" data-status="${user.status === "active" ? "disabled" : "active"}">${user.status === "active" ? "禁用账号" : "启用账号"}</button><button class="button danger" data-action="delete-user" data-user="${escapeHtml(user.username)}">删除用户</button>`}`);
}

async function loadAllMailboxes() {
  await loadInboxes();
  renderAllMailboxes();
}
function renderAllMailboxes(query = "") {
  const rows = state.inboxes.filter((item) => mailboxAddress(item).toLowerCase().includes(query.toLowerCase()) || String(item.owner_username || "").toLowerCase().includes(query.toLowerCase()));
  $("#appView").innerHTML = `<section class="all-mailboxes-page"><header class="page-header"><div><h1>所有邮箱</h1><p>查看系统邮箱、归属用户与邮件数量</p></div><button class="button primary" data-action="create-mailbox">${icon("plus")}生成新邮箱</button></header><section class="mailbox-table-card"><div class="filter-bar"><label class="search-box">${icon("search")}<input id="allMailboxSearch" value="${escapeHtml(query)}" placeholder="搜索邮箱或所属用户"></label><span class="filter-spacer"></span><strong>共 ${rows.length} 个邮箱</strong></div><div class="mailbox-grid header"><span>邮箱地址</span><span>所属用户</span><span>邮件数量</span><span>状态</span><span>创建时间</span><span>操作</span></div><div class="mailbox-table-scroll">${rows.map(item => `<div class="mailbox-grid row"><strong>${escapeHtml(mailboxAddress(item))}</strong><span>${escapeHtml(item.owner_username || "未分配")}</span><span>${Number(item.mail_count || 0)}</span><span><span class="badge active">正常</span></span><span>${formatDate(item.created_at)}</span><span class="inline-actions"><button class="link-button" data-action="open-mailbox" data-id="${escapeHtml(item.id)}">打开</button><button class="link-button" data-action="delete-mailbox" data-id="${escapeHtml(item.id)}">删除</button></span></div>`).join("") || `<div class="empty-state"><div><strong>没有匹配的邮箱</strong></div></div>`}</div></section></section>`;
}

function setUserQuery(changes) {
  const current = usersQuery();
  const next = { ...current, ...changes };
  const params = new URLSearchParams();
  if (next.keyword) params.set("keyword", next.keyword);
  if (next.role !== "all") params.set("role", next.role);
  if (next.status !== "all") params.set("status", next.status);
  if (next.page !== 1) params.set("page", next.page);
  if (next.pageSize !== 10) params.set("pageSize", next.pageSize);
  history.replaceState({}, "", `/users${params.toString() ? `?${params}` : ""}`);
  return loadUsers();
}
function findUser(username) { return state.users?.users.find((item) => item.username === username); }
function startAutoRefresh() {
  clearInterval(state.timer);
  state.timer = setInterval(async () => {
    if (state.route !== "/" || document.hidden) return;
    try { await loadMessages(); renderMailWorkspace(); } catch { /* next refresh retries */ }
  }, 20000);
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("#loginUser").value.trim(), password: $("#loginPassword").value }) });
    state.user = result.user; state.domain = result.domain || state.domain;
    $("#loginError").textContent = ""; $("#authScreen").hidden = true; $("#appShell").hidden = false;
    await navigate("/", true); startAutoRefresh(); toast("登录成功");
  } catch (error) { $("#loginError").textContent = error.message; }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-route],[data-action],[data-mailbox-id],[data-message-id],[data-folder],[data-user-page]");
  if (!target) return;
  if (target.dataset.route) { event.preventDefault(); return navigate(target.dataset.route); }
  if (target.dataset.folder) { state.folder = target.dataset.folder; return renderMailWorkspace(); }
  if (target.dataset.userPage) return setUserQuery({ page: Number(target.dataset.userPage) });
  if (target.dataset.mailboxId && !event.target.closest("[data-action]")) {
    state.inbox = state.inboxes.find((item) => item.id === target.dataset.mailboxId); state.selectedMessage = null; await loadMessages(); return renderMailWorkspace();
  }
  if (target.dataset.messageId && !event.target.closest("[data-action]")) {
    state.selectedMessage = state.messages.find((item) => item.id === target.dataset.messageId); renderMailWorkspace();
    if (innerWidth < 1000) { $("#emailDetail")?.classList.add("mobile-open"); $("#overlay").classList.add("open"); }
    return;
  }
  const action = target.dataset.action;
  try {
    if (action === "theme") return setTheme(!document.body.classList.contains("dark"));
    if (action === "mobile-nav") return $(".app-nav").classList.toggle("open");
    if (action === "logout") { await api("/api/logout", { method: "POST" }); $("#loginForm").reset(); return showLogin(); }
    if (action === "close-layer") return closeLayer();
    if (action === "close-detail") return closeLayer();
    if (action === "mobile-mailboxes") { $("#mailboxSidebar")?.classList.add("mobile-open"); return $("#overlay").classList.add("open"); }
    if (action === "close-dialog") return closeDialog();
    if (action === "copy-mailbox") return copyText(mailboxAddress(), "邮箱地址");
    if (action === "copy-code") { event.stopPropagation(); return copyText(target.dataset.code, "验证码"); }
    if (action === "manual-refresh") {
      target.disabled = true;
      try { await loadMessages(); } finally { target.disabled = false; }
      renderMailWorkspace(); return toast("收件箱已刷新");
    }
    if (action === "toggle-history-sort") { state.historySort = state.historySort === "desc" ? "asc" : "desc"; return renderMailWorkspace(); }
    if (action === "toggle-generator-mode") { state.generatorCustom = !state.generatorCustom; renderMailWorkspace(); if (state.generatorCustom) $("#generatorCustomName")?.focus(); return; }
    if (action === "generate-random") return await createMailboxFromGenerator("random");
    if (action === "generate-person") return await createMailboxFromGenerator("person");
    if (action === "create-mailbox") return createMailboxDialog();
    if (action === "confirm-create-mailbox") {
      const result = await api("/api/inboxes", { method: "POST", body: JSON.stringify({ localPart: $("#newMailbox").value.trim(), permanent: true }) });
      closeDialog(); await loadMailWorkspace(result.inbox.id); history.pushState({}, "", "/"); state.route = "/"; updateHeader(); return toast("新邮箱创建成功");
    }
    if (action === "delete-message") { event.stopPropagation(); return confirmAction("删除邮件", "确定删除这封邮件吗？删除后可能无法恢复。", "删除邮件", "confirm-delete-message", `data-id="${escapeHtml(target.dataset.id)}"`); }
    if (action === "confirm-delete-message") { await api(`/api/messages/${encodeURIComponent(target.dataset.id)}`, { method: "DELETE" }); closeDialog(); state.selectedMessage = null; await loadMessages(); renderMailWorkspace(); return toast("邮件已删除"); }
    if (action === "delete-mailbox") { event.stopPropagation(); return confirmAction("删除邮箱", "确定删除这个邮箱及其全部邮件吗？删除后无法恢复。", "删除邮箱", "confirm-delete-mailbox", `data-id="${escapeHtml(target.dataset.id)}"`); }
    if (action === "confirm-delete-mailbox") { await api(`/api/inboxes/${encodeURIComponent(target.dataset.id)}`, { method: "DELETE" }); closeDialog(); if (state.route === "/mailboxes") await loadAllMailboxes(); else await loadMailWorkspace(); return toast("邮箱已删除"); }
    if (action === "open-mailbox") { state.inbox = state.inboxes.find((item) => item.id === target.dataset.id); state.selectedMessage = null; history.pushState({}, "", "/"); state.route = "/"; await loadMessages(); updateHeader(); return renderMailWorkspace(); }
    if (action === "add-user") return userFormDialog();
    if (action === "edit-user") return userFormDialog(findUser(target.dataset.user));
    if (action === "save-user") {
      const username = target.dataset.user;
      const payload = { username: $("#formUsername").value.trim(), email: $("#formEmail").value.trim(), password: $("#formPassword").value, role: $("#formRole").value, status: $("#formStatus").value, quota: Number($("#formQuota").value) };
      await api(username ? `/api/users/${encodeURIComponent(username)}` : "/api/users", { method: username ? "PATCH" : "POST", body: JSON.stringify(payload) });
      closeDialog(); await loadUsers(); return toast(username ? "用户资料已更新" : "用户已添加");
    }
    if (action === "user-detail") return userDetailDrawer(findUser(target.dataset.user));
    if (action === "toggle-user") { await api(`/api/users/${encodeURIComponent(target.dataset.user)}`, { method: "PATCH", body: JSON.stringify({ status: target.dataset.status }) }); closeLayer(); await loadUsers(); return toast(target.dataset.status === "active" ? "账号已启用" : "账号已禁用"); }
    if (action === "delete-user") return confirmAction("删除用户", `确定删除用户 ${target.dataset.user} 吗？该操作无法恢复。`, "删除用户", "confirm-delete-user", `data-user="${escapeHtml(target.dataset.user)}"`);
    if (action === "confirm-delete-user") { await api(`/api/users/${encodeURIComponent(target.dataset.user)}`, { method: "DELETE" }); closeDialog(); closeLayer(); await loadUsers(); return toast("用户已删除"); }
    if (action === "reset-password") { closeLayer(); return openDialog("重置密码", `<div class="form-field"><label>用户 ${escapeHtml(target.dataset.user)} 的新密码</label><input class="text-input" id="resetPassword" type="password" minlength="6" placeholder="至少 6 位"></div>`, `<button class="button" data-action="close-dialog">取消</button><button class="button primary" data-action="confirm-reset-password" data-user="${escapeHtml(target.dataset.user)}">确认重置</button>`); }
    if (action === "confirm-reset-password") { await api(`/api/users/${encodeURIComponent(target.dataset.user)}`, { method: "PATCH", body: JSON.stringify({ password: $("#resetPassword").value }) }); closeDialog(); return toast("密码已重置"); }
    if (action === "reset-user-filter") { history.replaceState({}, "", "/users"); return loadUsers(); }
    if (action === "confirm-batch") { const payload = JSON.parse(decodeURIComponent(target.dataset.payload)); await api("/api/users/batch", { method: "POST", body: JSON.stringify(payload) }); closeDialog(); await loadUsers(); return toast("批量操作已完成"); }
  } catch (error) {
    if (error.status === 401) showLogin();
    toast(error.message);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "generatorLength") { state.generatorLength = Number(event.target.value); $("#generatorLengthValue").textContent = `${state.generatorLength} 位`; }
  if (event.target.id === "generatorCustomName") state.customLocalPart = event.target.value;
  if (event.target.id === "historySearch") {
    const query = event.target.value.toLowerCase();
    $$(".history-item").forEach((item) => { item.hidden = !item.textContent.toLowerCase().includes(query); });
  }
  if (event.target.id === "allMailboxSearch") {
    const query = event.target.value.toLowerCase();
    $$(".mailbox-grid.row").forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
  }
  if (event.target.id === "userKeyword") {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => setUserQuery({ keyword: event.target.value.trim(), page: 1 }), 350);
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.id === "roleFilter") return setUserQuery({ role: event.target.value, page: 1 });
  if (event.target.id === "statusFilter") return setUserQuery({ status: event.target.value, page: 1 });
  if (event.target.id === "pageSize") return setUserQuery({ pageSize: Number(event.target.value), page: 1 });
  if (event.target.classList.contains("user-check")) {
    event.target.checked ? state.selectedUsers.add(event.target.dataset.username) : state.selectedUsers.delete(event.target.dataset.username);
    event.target.closest("tr").classList.toggle("selected", event.target.checked);
  }
  if (event.target.id === "selectAllUsers") {
    $$(".user-check").forEach((checkbox) => { checkbox.checked = event.target.checked; checkbox.closest("tr").classList.toggle("selected", event.target.checked); event.target.checked ? state.selectedUsers.add(checkbox.dataset.username) : state.selectedUsers.delete(checkbox.dataset.username); });
  }
  if (event.target.id === "batchAction" && event.target.value) {
    const usernames = [...state.selectedUsers];
    if (!usernames.length) { event.target.value = ""; return toast("请先选择用户"); }
    const action = event.target.value;
    event.target.value = "";
    if (action === "role") return openDialog("批量修改角色", `<div class="form-field"><label>目标角色</label><select class="select" id="batchRole"><option value="user">普通用户</option><option value="admin">管理员</option></select></div>`, `<button class="button" data-action="close-dialog">取消</button><button class="button primary" id="confirmBatchRole">确认修改</button>`), $("#confirmBatchRole").addEventListener("click", () => { const payload = encodeURIComponent(JSON.stringify({ action: "role", usernames, role: $("#batchRole").value })); confirmAction("确认批量修改", `确定修改所选 ${usernames.length} 位用户的角色吗？`, "确认修改", "confirm-batch", `data-payload="${payload}"`); });
    const label = { enable: "启用", disable: "禁用", delete: "删除" }[action];
    const payload = encodeURIComponent(JSON.stringify({ action, usernames }));
    return confirmAction(`批量${label}`, `确定${label}所选 ${usernames.length} 位用户吗？${action === "delete" ? "删除后无法恢复。" : ""}`, `确认${label}`, "confirm-batch", `data-payload="${payload}"`);
  }
});

window.addEventListener("popstate", () => navigate(location.pathname, false));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeLayer(); closeDialog(); } });
bootstrap();
