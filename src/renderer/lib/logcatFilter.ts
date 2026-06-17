// Android Studio Logcat 查询语言（Phase 2）：把一条查询字符串编译成对 LogEntry 的谓词。
//
// 语法（对齐 AS 精神，大小写不敏感）：
//   键值      tag:Foo  package:com.x  process:1234  pid:1234  message:hello  level:W  line:任意
//   匹配符    key:val 子串(默认) · key=val 精确(整字段相等) · key~val 正则
//   裸文本    foo            → 在「行」(message+tag+包名+pid) 里子串匹配
//   逻辑      空格 = 与；空格分隔的独立 `|` = 或（绑定左右两个 term）；前缀 `-` = 非
//   引号      "a b" / 'a b'  → 含空格的值/裸词
//   特殊      package:mine   → 只看自家(第三方安装)应用（mine 集合由调用方注入 = pm list packages -3）
//
// 优先级：`a | b c` = (a 或 b) 与 c；`a b | c` = a 与 (b 或 c)。即「以 | 相连的极大段」为一个或组，
// 或组之间隐式与。`|` 只有被空格分隔成独立 token 时才作或运算符（`a|b` 是含字面 | 的裸词，正则里的 | 不受影响）。

export interface LogEntryLike {
  level: string; // V D I W E F
  tag: string;
  message: string;
  processId: number;
  packageName?: string | null;
}

export interface LogcatFilterContext {
  /** package:mine 的命中集合（第三方安装应用包名，来自 pm list packages -3）。未提供时 mine 命中为空。 */
  minePackages?: Set<string> | null;
}

export interface CompiledLogcatQuery {
  /** 查询为空（无任何过滤项）→ 视作不过滤，test 恒 true。 */
  isEmpty: boolean;
  /** 正则编译失败等非致命错误（用于 UI 提示）；谓词仍可用（出错的 term 命中为空）。 */
  error: string | null;
  /** 查询是否用到 package:mine（调用方据此确保 minePackages 已加载）。 */
  usesMine: boolean;
  test: (log: LogEntryLike, ctx?: LogcatFilterContext) => boolean;
}

const LEVEL_PRIORITY: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };

// 等级名（含全称/别名）→ 单字母。未知返回 null（→ level term 退化为不过滤）。
function normalizeLevel(v: string): string | null {
  const s = v.trim().toUpperCase();
  if (s in LEVEL_PRIORITY) return s;
  switch (s) {
    case 'VERBOSE': return 'V';
    case 'DEBUG': return 'D';
    case 'INFO': return 'I';
    case 'WARN': case 'WARNING': return 'W';
    case 'ERROR': return 'E';
    case 'ASSERT': case 'FATAL': return 'F';
    default: return null;
  }
}

// 键别名 → 规范键。
const KEY_ALIASES: Record<string, string> = {
  tag: 'tag',
  package: 'package', pkg: 'package', app: 'package',
  process: 'process', proc: 'process',
  pid: 'pid',
  message: 'message', msg: 'message', text: 'message',
  level: 'level', lvl: 'level',
  line: 'line',
};

type MatchOp = ':' | '=' | '~';

interface Term {
  negated: boolean;
  key: string | null; // null = 裸词（按 line 匹配）
  op: MatchOp;
  value: string;
  regex: RegExp | null; // op==='~' 且编译成功时存在
  isMine: boolean;      // package:mine 特例
  error: string | null; // 本 term 的（正则）编译错误
}

// 按空白切 token，尊重引号（引号内空白不切），保留引号字符（值解析时再剥）。
function splitTokens(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of input) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      if (cur !== '') { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur !== '') tokens.push(cur);
  return tokens;
}

// 剥去成对的首尾引号。
function stripQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function parseTerm(raw: string): Term {
  let negated = false;
  let t = raw;
  if (t.length > 1 && t[0] === '-') { negated = true; t = t.slice(1); }

  const m = /^([A-Za-z]+)([:=~])([\s\S]*)$/.exec(t);
  let key: string | null = null;
  let op: MatchOp = ':';
  let value: string;
  if (m && KEY_ALIASES[m[1].toLowerCase()]) {
    key = KEY_ALIASES[m[1].toLowerCase()];
    op = m[2] as MatchOp;
    value = stripQuotes(m[3]);
  } else {
    value = stripQuotes(t); // 裸词（含形如 a|b 的字面串）。
  }

  const isMine = key === 'package' && op === ':' && value.trim().toLowerCase() === 'mine';

  let regex: RegExp | null = null;
  let error: string | null = null;
  if (op === '~') {
    try {
      regex = new RegExp(value, 'i');
    } catch (e) {
      error = `正则无效：${value}`;
    }
  }
  return { negated, key, op, value, regex, isMine, error };
}

// 字段抽取（除 level/mine 特例外）。
function fieldFor(key: string | null, log: LogEntryLike): string {
  switch (key) {
    case 'tag': return log.tag;
    case 'package': return log.packageName ?? '';
    case 'process': return `${log.packageName ?? ''} ${log.processId}`;
    case 'pid': return String(log.processId);
    case 'message': return log.message;
    case 'line':
    case null:
    default:
      return `${log.message} ${log.tag} ${log.packageName ?? ''} ${log.processId}`;
  }
}

function matchTerm(term: Term, log: LogEntryLike, ctx: LogcatFilterContext): boolean {
  let hit: boolean;

  if (term.isMine) {
    const mine = ctx.minePackages;
    hit = !!(log.packageName && mine && mine.has(log.packageName));
  } else if (term.key === 'level') {
    const want = normalizeLevel(term.value);
    if (want === null) {
      hit = true; // 未知等级 → 不过滤（宽松）。
    } else {
      const entry = LEVEL_PRIORITY[log.level] ?? LEVEL_PRIORITY.I;
      hit = entry >= LEVEL_PRIORITY[want]; // 「≥ 该级」，与 AS 等级筛选一致。
    }
  } else if (term.op === '~') {
    hit = term.regex ? term.regex.test(fieldFor(term.key, log)) : false; // 正则无效 → 命中空。
  } else {
    const field = fieldFor(term.key, log).toLowerCase();
    const v = term.value.toLowerCase();
    hit = term.op === '=' ? field === v : field.includes(v);
  }

  return term.negated ? !hit : hit;
}

export function compileLogcatQuery(query: string): CompiledLogcatQuery {
  const tokens = splitTokens(query ?? '');

  // 构建「或组」数组：以独立 `|` 相连的极大段为一组，组间隐式与。
  const groups: Term[][] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === '|') { i++; continue; } // 跳过悬空的 |（行首/连续）。
    const group: Term[] = [parseTerm(tokens[i])];
    i++;
    while (i < tokens.length && tokens[i] === '|') {
      i++; // 吃掉 |
      if (i < tokens.length && tokens[i] !== '|') {
        group.push(parseTerm(tokens[i]));
        i++;
      }
    }
    groups.push(group);
  }

  const allTerms = groups.flat();
  const error = allTerms.find((t) => t.error)?.error ?? null;
  const usesMine = allTerms.some((t) => t.isMine);
  const isEmpty = groups.length === 0;

  const test = (log: LogEntryLike, ctx: LogcatFilterContext = {}): boolean => {
    // 组间与：每个或组里至少一个 term 命中。
    for (const group of groups) {
      let groupHit = false;
      for (const term of group) {
        if (matchTerm(term, log, ctx)) { groupHit = true; break; }
      }
      if (!groupHit) return false;
    }
    return true;
  };

  return { isEmpty, error, usesMine, test };
}
