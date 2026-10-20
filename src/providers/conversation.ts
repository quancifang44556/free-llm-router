/**
 * 会话 / 轮级请求 id 的上下文（**纯数据**，不碰网络、不碰存储）。
 *
 * ## ⚠️ 为什么需要它与 `ChatRequest` 分开
 *
 * 上游国际服（`www.workbuddy.ai`）从 2026-10-20 起强校验会话头族：
 *
 * ```
 * X-Conversation-ID          同一对话内恒定
 * X-Conversation-Request-ID  一轮用户发送内恒定（重试复用）
 * X-Root-Request-ID          = 上一行
 * X-Conversation-Message-ID  每请求新生成
 * X-Request-ID               = 上一行
 * ```
 *
 * 前两个必须由**调用方在重试循环外**算好再传进来 —— 放在头构造函数里现生成，
 * 等于每次重试都开一个「新会话 / 新一轮」，正是上游画像里最显眼的非人类特征。
 *
 * 而 `ChatRequest` 是**所有 provider 共用的**结构（cline / minimax / gemini…），
 * 往里塞两个只有 WorkBuddy 国际服关心的字段会污染公共契约。
 * 故拆成独立结构，由 `ChatRequest.conversation` 可选携带。
 */
export interface ConversationContext {
  /**
   * `X-Conversation-ID`：带连字符的 UUID，同一会话恒定。
   *
   * ⚠️ 派生种子**必须包含账号 uid**：同一段会话 id 出现在两个账号的请求里，
   * 就是上游把两个号串起来的关联键。
   */
  conversationId: string
  /** `X-Conversation-Request-ID`（= `X-Root-Request-ID`）：32 位 hex，一轮恒定。 */
  turnRequestId: string
}
