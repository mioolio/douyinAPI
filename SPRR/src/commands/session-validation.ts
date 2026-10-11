export type SessionValidation =
  | { status: 'valid' }
  | { status: 'invalid'; reason: string }
  | { status: 'unavailable'; reason: string };

interface ValidationResponse { statusCode: number; errorDesc: string }

/** 限流、网络错误和未知业务状态不能证明 cookie 已失效。 */
export function classifySessionResponse(response: ValidationResponse): SessionValidation {
  const { statusCode, errorDesc } = response;
  if (statusCode === 0) return { status: 'valid' };
  if (statusCode === 401 || /un(?:expected|exepcted) session length|invalid session|session (?:expired|invalid)|not[_ ]logged?[_ ]in|not[_ ]login|unauthenticated/i.test(errorDesc)) {
    return { status: 'invalid', reason: `status=${statusCode} ${errorDesc}` };
  }
  return { status: 'unavailable', reason: `status=${statusCode} ${errorDesc}` };
}

export async function probeSession(
  request: () => Promise<ValidationResponse>,
  options: { attempts?: number; pause?: () => Promise<void> } = {},
): Promise<SessionValidation> {
  const attempts = options.attempts ?? 3;
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
  let result: SessionValidation = { status: 'unavailable', reason: '验证未完成' };
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await request();
      result = classifySessionResponse(response);
      if (result.status !== 'unavailable') return result;
      // 限流和其他业务错误不盲目重试；只重试既有的临时服务错误。
      if (response.statusCode !== 500 && response.errorDesc !== 'StatusCodeRemoteOrNetError') return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/^HTTP 401\b/.test(reason)) return { status: 'invalid', reason };
      result = { status: 'unavailable', reason };
      if (/^HTTP (?:403|409|429)\b/.test(reason)) return result;
    }
    if (attempt + 1 < attempts) await pause();
  }
  return result;
}
