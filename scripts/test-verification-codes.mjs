import { readFile } from "node:fs/promises";
import vm from "node:vm";

let source = await readFile(new URL("../app.js", import.meta.url), "utf8");
source = source.replace(/bootstrap\(\);\s*$/, "globalThis.__recognize = recognizeVerificationCode;");
const element = { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {} };
const context = {
  console, TextDecoder, Uint8Array, atob, setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: globalThis.crypto,
  document: { querySelector() { return element; }, querySelectorAll() { return []; }, addEventListener() {}, body: element },
  window: { addEventListener() {} }, localStorage: { getItem() {}, setItem() {} },
  location: { pathname: "/" }, history: { pushState() {}, replaceState() {} },
  navigator: { clipboard: { writeText() { return Promise.resolve(); } } }, fetch() {},
};
vm.createContext(context);
vm.runInContext(source, context);

const cases = [
  ["OpenAI 空白布局", { subject: "你的 ChatGPT 临时验证码", text_body: "输入此临时的验证码以继续：\n\n\n\n326457\n\n如果并非你本人尝试创建 ChatGPT 帐户" }, "326457"],
  ["OpenAI 超长布局间隔", { subject: "你的 ChatGPT 临时验证码", text_body: `输入此临时的验证码以继续：\n${" ".repeat(420)}\n326457\n请勿分享` }, "326457"],
  ["OpenAI Outlook 条件注释", { subject: "你的 ChatGPT 临时验证码", text_body: `<html><body><p>输入此临时的验证码以继续：</p><!--[if mso]>\n<span style=3D"font-family: Lucida Console, Arial, sans-serif;">\n<![endif]-->\n934971\n<!--[if mso]>\n</span>\n<![endif]--><p>如果并非你本人尝试创建 ChatGPT 帐户，请忽略此邮件。</p></body></html>` }, "934971"],
  ["验证主题唯一候选兜底", { subject: "你的 ChatGPT 临时验证码", text_body: `<div>输入以下代码继续</div><table><tr><td>934971</td></tr></table><footer>请勿分享此代码</footer>` }, "934971"],
  ["GitHub launch code", { subject: "Your GitHub launch code", text_body: "Here's your GitHub launch code!\nContinue signing up by entering the code below:\n\n40213071" }, "40213071"],
  ["SpaceXAI grouped confirmation code", { subject: "SpaceXAI confirmation code: QH5-XVP", text_body: "Thank you for creating a SpaceXAI account. Please use the code below to validate your email address.\n\nQH5-XVP\n\nIf you did not create a new account, please ignore this email." }, "QH5-XVP"],
  ["Generic 4 character code", { subject: "Your confirmation code", text_body: "Enter the verification code below:\n\nA7K2" }, "A7K2"],
  ["中文行内验证码", { subject: "安全验证", text_body: "您好，您的登录验证码是 482731，请在10分钟内完成验证。" }, "482731"],
  ["空格分隔验证码", { subject: "验证码", text_body: "验证码：\n3 2 6 4 5 7" }, "326457"],
  ["短横线分隔验证码", { subject: "登录验证", text_body: "请输入下面的安全码\n326-457" }, "326457"],
  ["排除日期订单", { subject: "订单通知", text_body: "订单号：482731\n日期：2026-08-13\n共计 100 元" }, null],
  ["排除会员编号", { subject: "欢迎注册", text_body: "您的会员编号：326457" }, null],
  ["排除链接参数", { subject: "验证码", text_body: "请点击 https://example.com/verify?code=326457 完成验证" }, null],
];

let failed = 0;
for (const [name, message, expected] of cases) {
  const actual = context.__recognize(message)?.value ?? null;
  const passed = actual === expected;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${actual ?? "null"}`);
  if (!passed) failed += 1;
}
if (failed) process.exitCode = 1;
