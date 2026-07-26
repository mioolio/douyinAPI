import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 项目根目录（package.json 所在目录） */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 运行时数据目录（cookie、token 等） */
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');

/** cookie/session 持久化文件 */
export const SESSION_FILE = path.join(DATA_DIR, 'session.json');

/** 账号存储目录（每个账号一个 storageState JSON 文件） */
export const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');

/** 当前账号指针文件（纯文本，内容是账号名） */
export const CURRENT_ACCOUNT_FILE = path.join(ACCOUNTS_DIR, 'current');

/** 抖音聊天页 URL（登录时打开，便于扫码后立即进入聊天页验证登录态） */
export const DOUYIN_CHAT_URL = 'https://www.douyin.com/chat?isPopup=1';

/** 抖音主站域名 */
export const DOUYIN_HOST = 'www.douyin.com';

/** HiLib 默认 storageState 路径（兜底用）
 *  仅作为 --state / --account 都未指定时的兜底 */
export const DEFAULT_STORAGE_STATE = path.join(PROJECT_ROOT, 'data', 'storageState.json');
