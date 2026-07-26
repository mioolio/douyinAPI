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
};
const RESET = '\x1b[0m';
/** 日志级别优先级（用于过滤） */
const LEVEL_PRIORITY = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
/**
 * 解析某 scope 的最低输出级别
 *
 * 环境变量控制（不影响主程序默认行为）：
 *   - SPRR_LOG_SCOPE=xxx：仅该 scope 按 SPRR_LOG_LEVEL 过滤，其他 scope 最低输出 WARN
 *   - SPRR_LOG_LEVEL=debug|info|warn|error：全局最低级别
 *   - 都不设置：全输出（兼容主程序）
 */
function getMinLevel(scope) {
    const envScope = process.env.SPRR_LOG_SCOPE;
    const envLevel = process.env.SPRR_LOG_LEVEL;
    if (envScope && scope !== envScope) {
        return LEVEL_PRIORITY.warn;
    }
    if (envLevel) {
        const lv = envLevel.toLowerCase();
        return LEVEL_PRIORITY[lv] ?? LEVEL_PRIORITY.debug;
    }
    return LEVEL_PRIORITY.debug;
}
function formatTime() {
    const d = new Date();
    const pad = (n, l = 2) => n.toString().padStart(l, '0');
    return (`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
        `.${pad(d.getMilliseconds(), 3)}`);
}
export function createLogger(scope) {
    const log = (level, msg, args) => {
        if (LEVEL_PRIORITY[level] < getMinLevel(scope))
            return;
        const color = LEVEL_COLORS[level];
        const time = formatTime();
        const suffix = args.length > 0 ? ' ' + args.map((a) => JSON.stringify(a)).join(' ') : '';
        process.stderr.write(`${color}[${time}] [${level.toUpperCase()}] [${scope}]${RESET} ${msg}${suffix}\n`);
    };
    return {
        info: (m, ...a) => log('info', m, a),
        warn: (m, ...a) => log('warn', m, a),
        error: (m, ...a) => log('error', m, a),
        debug: (m, ...a) => log('debug', m, a),
    };
}
