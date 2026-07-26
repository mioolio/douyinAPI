/**
 * 共享类型定义
 *
 * 注意：抖音 API 响应结构复杂且可能随版本变化，
 * 这里只定义我们关心的字段，其余字段用 unknown 兜底。
 */

/** 启动模式（保留兼容，纯 API 调用通常不需要） */
export type LaunchMode = 'headful' | 'headless';

/** 登录结果 */
export interface LoginResult {
  success: boolean;
  durationMs: number;
  reason?: string;
  /** 登录后用户标识（uid / sec_uid 等） */
  userId?: string;
  /** 登录后用户昵称 */
  nickname?: string;
}

/** 会话项（联系人） */
export interface ConversationItem {
  /** 联系人 ID（uid / conversation_id） */
  id: string;
  /** 联系人名称 */
  name: string;
  /** 最后一条消息预览 */
  lastMsg: string;
  /** 最后一条消息时间戳（毫秒） */
  lastMsgTs?: number;
  /** 最后一条消息时间字符串 */
  time: string;
}

/** 聊天记录条目 */
export interface ChatMessage {
  /** 发送方：'我' / '精灵' / 对方昵称 */
  from: string;
  /** 发送方 ID（uid） */
  fromId?: string;
  /** 消息内容 */
  content: string;
  /** 消息类型 */
  type:
    | 'text'
    | 'emoji'
    | 'emoji_image'
    | 'system'
    | 'comment_share'
    | 'image'
    | 'video'
    | 'fallback';
  /** 时间字符串（无时间标签时为 null） */
  time: string | null;
  /** 消息 ID（用于去重和定位） */
  msgId?: string;
}

/** 打开会话结果 */
export interface OpenChatResult {
  success: boolean;
  matchedName?: string;
  matchedId?: string;
  durationMs: number;
  reason?: string;
}

/** 发送消息结果 */
export interface SendResult {
  success: boolean;
  target: string;
  text: string;
  durationMs: number;
  /** 发送成功后服务器返回的消息 ID */
  msgId?: string;
  reason?: string;
}

/** 获取聊天记录结果 */
export interface HistoryResult {
  success: boolean;
  target: string;
  messages: ChatMessage[];
  durationMs: number;
  /** 是否还有更早的历史可加载 */
  hasMore?: boolean;
  reason?: string;
}

/** API 响应通用结构 */
export interface ApiResponse<T = unknown> {
  /** 状态码 */
  status_code: number;
  /** 状态消息 */
  status_msg?: string;
  /** 业务数据 */
  data?: T;
  /** 附加数据 */
  extra?: Record<string, unknown>;
}

/** 全局运行时选项 */
export interface RuntimeOptions {
  /** 是否输出 JSON 格式 */
  json?: boolean;
  /** 是否启用详细日志 */
  verbose?: boolean;
}
