/**
 * 带 scope 的日志工具
 *
 * 输出格式：[时间] [LEVEL] [scope] 消息
 * 时间：ISO 本地时间
 * 颜色：INFO 灰色 / WARN 黄色 / ERROR 红色 / DEBUG 暗灰色
 */

const LEVEL_COLORS = {
  info: '\x1b[90m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[90m',
} as const;

const RESET = '\x1b[0m';

type Level = keyof typeof LEVEL_COLORS;

/** 日志级别优先级（用于过滤） */
const LEVEL_PRIORITY: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let verbose = false;

/** REPL 的 --verbose 对所有现有 logger 生效；显式环境级别仍优先。 */
export function setLogVerbose(enabled: boolean): void {
  verbose = enabled;
}

/** 浏览器诊断可能包含完整请求 URL，不能把认证参数写入终端。 */
export function redactLogText(value: string): string {
  return value.replace(
    /(authorization\s*["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s"'\},;]+/gi,
    '$1[redacted]',
  ).replace(
    /((?:identity_security_token|msToken|a_bogus|sessionid(?:_ss)?|passport_csrf_token|access_key|bd-ticket-guard[\w-]*|x-tt-session-dtrait|authorization|token)\s*["']?\s*[:=]\s*["']?)[^&\s"'\},;]+/gi,
    '$1[redacted]',
  );
}

/**
 * 解析某 scope 的最低输出级别
 *
 * 环境变量控制（不影响主程序默认行为）：
 *   - SPRR_LOG_SCOPE=xxx：仅该 scope 按 SPRR_LOG_LEVEL 过滤，其他 scope 最低输出 WARN
 *   - SPRR_LOG_LEVEL=debug|info|warn|error：全局最低级别
 *   - 都不设置：INFO；REPL --verbose 时 DEBUG
 */
function getMinLevel(scope: string): number {
  const envScope = process.env.SPRR_LOG_SCOPE;
  const envLevel = process.env.SPRR_LOG_LEVEL;
  if (envScope && scope !== envScope) {
    return LEVEL_PRIORITY.warn;
  }
  if (envLevel) {
    const lv = envLevel.toLowerCase() as Level;
    return LEVEL_PRIORITY[lv] ?? (verbose ? LEVEL_PRIORITY.debug : LEVEL_PRIORITY.info);
  }
  return verbose ? LEVEL_PRIORITY.debug : LEVEL_PRIORITY.info;
}

function formatTime(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => n.toString().padStart(l, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  /** 将任意值序列化为字符串（Error / 堆栈 / 循环引用安全） */
  const serialize = (a: unknown): string => {
    if (a instanceof Error) {
      // Error 的 message/stack 不在 enumerable 属性里，JSON.stringify 会得到 {}
      return JSON.stringify({
        name: a.name,
        message: a.message,
        stack: a.stack?.split('\n').slice(0, 4).join(' | '),
        ...(a as unknown as Record<string, unknown>),
      });
    }
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  const log = (level: Level, msg: string, args: unknown[]) => {
    if (LEVEL_PRIORITY[level] < getMinLevel(scope)) return;
    const color = LEVEL_COLORS[level];
    const time = formatTime();
    const suffix = args.length > 0 ? ' ' + args.map(serialize).join(' ') : '';
    process.stderr.write(`${color}[${time}] [${level.toUpperCase()}] [${scope}]${RESET} ${redactLogText(msg + suffix)}\n`);
  };

  return {
    info: (m, ...a) => log('info', m, a),
    warn: (m, ...a) => log('warn', m, a),
    error: (m, ...a) => log('error', m, a),
    debug: (m, ...a) => log('debug', m, a),
  };
}
