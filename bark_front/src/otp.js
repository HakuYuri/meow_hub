// 识别验证码短信并提取验证码（简体 / 繁体中文 / 英文），纯前端规则，无关键词时不提取以避免误报。
// 思路：找关键词 → 取 4-8 位含数字的独立字母数字串 → 排除尾号/金额/时长/年份等干扰 → 按与关键词的距离打分取最优。
// 关键词只在正文中查找：不少转发工具会把固定的「xx验证码」写进标题，若用标题关键词会把卡号、尾号等误判为验证码。

const KEYWORDS = [
  // 简体
  '验证码', '校验码', '检验码', '确认码', '激活码', '动态码', '动态密码', '短信码', '安全码',
  '登录码', '授权码', '认证码', '验证代码', '一次性密码', '口令', '代码', '验证编码',
  // 繁体
  '驗證碼', '校驗碼', '檢驗碼', '確認碼', '啟用碼', '啟動碼', '動態碼', '動態密碼', '簡訊碼',
  '短訊碼', '登入碼', '登錄碼', '授權碼', '認證碼', '驗證代碼', '一次性密碼', '安全碼', '代碼', '驗證編碼',
  // 英文
  'verification code', 'security code', 'login code', 'sign-in code', 'sign in code',
  'one-time password', 'one time password', 'one-time passcode', 'one time passcode',
  'one-time code', 'one time code', 'passcode', 'otp', '2fa code', 'authentication code',
  'auth code', 'confirmation code', 'code',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 长关键词优先匹配，英文关键词要求词边界
const KEYWORD_RE = new RegExp(
  [...KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .map(k => (/^[a-z0-9]/i.test(k) ? `(?:^|[^A-Za-z])${escapeRe(k)}(?![A-Za-z])` : escapeRe(k)))
    .join('|'),
  'gi'
);

// 候选前面紧跟这些词时不是验证码（尾号、金额、有效期等）
const NOISE_BEFORE = /(?:尾号|尾號|尾数|尾數|结尾号码|結尾號碼|号码|號碼|卡号|卡號|手机号|手機號|电话|電話|积分|積分|登录\s*ID|登入\s*ID|ID|订单号?|訂單號?|单号|單號|编号|編號|金额|金額|¥|￥|\$|HK\$|NT\$|USD|RMB|HKD|有效期|有效时间|有效時間|valid for|expires? in|within|order\s*#?|no\.?|#)\s*[:：]?\s*$/i;
// 候选后面紧跟时间、金额单位时不是验证码
const NOISE_AFTER = /^\s*(?:分钟|分鐘|小时|小時|秒|天|日|元|块|塊|年|月|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?)/i;

// 下划线也算词内字符，避免把「SIM1_ SubId」这类附加信息中的 SIM1 当作独立串
const isAlnum = (ch) => !!ch && /[A-Za-z0-9_]/.test(ch);
// 正文只有验证码本身（可带少量标点 / 前缀如 G-）
const CODE_ONLY_BODY = /^[^A-Za-z0-9\u4e00-\u9fff]*(?:[A-Za-z]{1,5}-\s*)?[A-Za-z0-9]{4,8}[^A-Za-z0-9\u4e00-\u9fff]*$/;
// 候选前面紧跟「是 / 为 / is / :」等引导词时更可能是验证码
const LEAD_IN = /(?:是|为|為|is|are|:|：|code)\s*[:：]?\s*$/i;

const findKeywords = (text) => {
  const keywords = [];
  for (const m of text.matchAll(KEYWORD_RE)) {
    // 去掉为词边界多匹配的前导字符
    const offset = m[0].length - m[0].replace(/^[^A-Za-z一-鿿]/, '').length;
    keywords.push([m.index + offset, m.index + m[0].length]);
  }
  return keywords;
};

// body 为正文；context（标题、副标题）仅在正文很短（基本只有验证码）时用于判断是否验证码消息
export function extractCode(body, ...context) {
  const text = (body || '').trim() || context.filter(Boolean).join('\n');
  if (!text) return null;

  let keywords = findKeywords(text);
  if (keywords.length === 0) {
    if (!CODE_ONLY_BODY.test(text) || !context.some(c => c && findKeywords(c).length > 0)) return null;
    keywords = [[0, 0]]; // 正文只有验证码本身，按正文开头计算距离
  }

  let best = null;
  let bestScore = Infinity;
  for (const m of text.matchAll(/[A-Za-z0-9]{4,8}/g)) {
    const start = m.index;
    const end = start + m[0].length;
    const token = m[0];
    if (isAlnum(text[start - 1]) || isAlnum(text[end])) continue; // 不是独立的串
    const lettersOnly = !/\d/.test(token);
    if (lettersOnly && !/^[A-Z]{4,8}$/.test(token)) continue; // 须含数字，或为全大写字母码
    if (/^(?:19|20)\d{2}$/.test(token) && /^[年\-/.]/.test(text.slice(end))) continue; // 年份
    if (/^\d[\d.,]*$/.test(token) && /^[.,]\d/.test(text.slice(end))) continue; // 小数 / 千分位金额
    if (NOISE_BEFORE.test(text.slice(Math.max(0, start - 10), start))) continue;
    if (NOISE_AFTER.test(text.slice(end, end + 8))) continue;

    const dist = Math.min(...keywords.map(([s, e]) => (start >= e ? start - e : end <= s ? s - end : 0)));
    const leadIn = LEAD_IN.test(text.slice(Math.max(0, start - 8), start)) ? -10 : 0;
    if (lettersOnly && dist > 3) continue; // 纯字母码只接受紧跟在关键词后的，避免误报
    const score = dist + leadIn + (/^\d+$/.test(token) ? 0 : 5) + (token.length <= 6 ? 0 : 2);
    if (score < bestScore) {
      best = token;
      bestScore = score;
    }
  }
  return bestScore <= 30 ? best : null;
}
