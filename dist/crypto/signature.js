/**
 * 抖音 API 签名算法（待逆向）
 *
 * 抖音 Web API 主要的签名机制（基于公开资料，待抓包确认）：
 *
 * 1. a_bogus / X-Bogus：
 *    - 主要针对 web API（如 /aweme/v1/...）
 *    - 算法基于请求参数 + UA + 时间戳生成
 *    - 通常通过 webmssdk.js / acrawler.js 计算
 *    - 已知有多个版本，逆向难度高
 *
 * 2. _signature：
 *    - 较老的签名机制，可能仍存在
 *    - 通过 _signature 函数生成
 *
 * 3. msToken：
 *    - 风控相关 token，由服务器下发
 *    - 通过 https://mssdk.bytedance.com/web/report 接口获取
 *    - 依赖浏览器环境指纹
 *
 * 4. ttwid：
 *    - 设备标识，由服务器下发
 *    - 首次访问 https://www.douyin.com/ 时通过 Set-Cookie 获取
 *
 * 逆向路线建议：
 * - Step 1：抓包确认当前实际需要的签名字段
 * - Step 2：在浏览器 devtools 中对 webmssdk.js 下断点
 * - Step 3：分析签名函数的输入输出
 * - Step 4：用 Node.js 复现（可能需要补浏览器环境，如 navigator、document）
 *
 * 状态：骨架，等待抓包和逆向。
 */
/**
 * 计算签名（待实现）
 *
 * 抓包和逆向完成后实现。
 */
export function sign(_input) {
    throw new Error('NOT_IMPLEMENTED: 签名算法等待逆向完成后实现');
}
