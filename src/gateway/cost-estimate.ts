/**
 * 费用估算：把 token 用量 × 供应商倍率换算成「相对费用」。
 *
 * ## ⚠️⚠️ 这不是「钱」，是**无量纲的相对值**
 *
 * 本模块刻意**不**输出货币金额，原因有三，每条都是硬约束：
 *
 * 1. **各家的 `priceFactor` 不是同一个基准**。它来自上游各自的目录字段
 *    （Qoder 的 `creditsFactor`、buddy 的倍率、LobsterAI 的 `priceFactor`），
 *    参考实现与我们都只把它当**同一家内部**的相对权重用。
 *    跨供应商相加在数学上没有意义 —— 那正是本项目
 *    `src/panel/assets/app.js.txt` 里「不在这里相加总额」注释防的事。
 * 2. **没有权威单价**。真换算成钱必须知道每家的「积分→人民币」汇率，
 *    而那个汇率会变、且不是所有家都公开。
 * 3. **`priceFactor` 可能是 `undefined`**，语义是「该家没提供」
 *    （见 `src/providers/types.ts:120`）—— 它**不是** 0，也不是「免费」。
 *    把 undefined 当 0 会把「未知」算成「免费」，是最典型的静默算错。
 *
 * ⇒ 故本模块只回答一个问题：**「在这家内部，这段时间用了多少相对量」**，
 *    用于横向比较「哪个号用得凶」「这周比上周涨了多少」。
 *
 * @module src/gateway/cost-estimate.ts
 */

/** 一次推理的 token 用量（与 `src/pool/state.ts` 的 `TokenUsage` 同形）。 */
export interface CostUsage {
  input: number
  output: number
}

/**
 * 估算结果。
 *
 * `amount` 是**相对费用**（token × 倍率），不是钱。
 */
export interface CostEstimate {
  /** 相对费用。`undefined` 表示**无法估算**（缺倍率或缺用量）。 */
  amount: number | undefined
  /** 相对费用是否可比（false ⇒ 该家的倍率未知，不该拿去跟别家比）。 */
  comparable: boolean
  /** 人类可读的一句话说明，面板可直接渲染。 */
  note: string
}

/** 把任意值安全读成「有限的非负数」，否则 undefined。 */
function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined
  if (!Number.isFinite(value)) return undefined
  if (value < 0) return undefined
  return value
}

/**
 * 估算一次/一段用量的相对费用。
 *
 * @param usage        token 用量（`input` / `output`）
 * @param priceFactor  供应商倍率；`undefined` = 该家没提供（**不是** 0）
 *
 * ## 判据（每一条都有对应的单测）
 *
 * | 情形 | amount | comparable | 为什么 |
 * |---|---|---|---|
 * | 倍率或用量缺失/非法 | `undefined` | `false` | 缺数据必须**如实说不知道**，不能当 0 |
 * | 倍率 = 0 | `0` | `true` | 0 是**合法值**（该家标注为免费），与「未知」不同 |
 * | 用量 = 0 | `0` | `true` | 真的没用，0 是对的 |
 * | 正常 | `(in+out)*factor` | `true` | |
 *
 * ⚠️ 「倍率 = 0」与「倍率未知」必须分开：前者是**免费**，后者是**不知道**。
 * 混为一谈会让面板把「查不到倍率的家」显示成「免费」，用户会以为白嫖。
 */
export function estimateCost(usage: CostUsage, priceFactor: number | undefined): CostEstimate {
  const input = finiteNonNegative(usage?.input)
  const output = finiteNonNegative(usage?.output)
  const factor = finiteNonNegative(priceFactor)

  // ⚠️ 倍率未知 ⇒ 不估算（undefined 不是 0）
  if (factor === undefined) {
    return {
      amount: undefined,
      comparable: false,
      note: '该供应商未提供计费倍率，无法估算（这不等于免费）',
    }
  }
  // ⚠️ 用量本身非法 ⇒ 不估算（NaN 参与任何比较都是 false，会静默算错）
  if (input === undefined || output === undefined) {
    return {
      amount: undefined,
      comparable: false,
      note: '用量数据缺失或非法，无法估算',
    }
  }

  const amount = (input + output) * factor
  // 理论上不会溢出（都是有限数），但仍兜一层：Infinity 不能流到面板
  if (!Number.isFinite(amount)) {
    return { amount: undefined, comparable: false, note: '估算结果溢出，无法给出可信数字' }
  }
  return {
    amount,
    comparable: true,
    note: factor === 0 ? '该供应商标注为免费' : '',
  }
}

/** 汇总一组用量后的相对费用（按同一倍率）。 */
export interface CostSummary {
  input: number
  output: number
  amount: number | undefined
  comparable: boolean
  /** 参与汇总的条目数。 */
  entries: number
  /** 因缺倍率/缺用量而**未**计入的条目数。 */
  skipped: number
}

/**
 * 汇总多条用量。
 *
 * ⚠️ **只对同一家供应商有意义** —— 跨家相加没有数学意义（见模块头）。
 * 调用方必须自己保证「同一家」，本函数无法检查（`priceFactor` 是外部传入的）。
 *
 * ⚠️ 有 skipped 时 `comparable` 仍可为 true，但 `note` 风格的信息由调用方拼 —— 
 * 这里只如实给出 `skipped` 计数，**不隐瞒**有多少条目没算进去。
 */
export function summarizeCost(
  rows: ReadonlyArray<{ usage: CostUsage; priceFactor: number | undefined }>,
): CostSummary {
  let input = 0
  let output = 0
  let amount = 0
  let entries = 0
  let skipped = 0

  for (const row of rows) {
    const est = estimateCost(row.usage, row.priceFactor)
    const i = finiteNonNegative(row.usage?.input)
    const o = finiteNonNegative(row.usage?.output)
    if (est.amount === undefined || i === undefined || o === undefined) {
      skipped += 1
      continue
    }
    input += i
    output += o
    amount += est.amount
    entries += 1
  }

  if (entries === 0) {
    return { input: 0, output: 0, amount: undefined, comparable: false, entries: 0, skipped }
  }
  return {
    input,
    output,
    amount: Number.isFinite(amount) ? amount : undefined,
    comparable: true,
    entries,
    skipped,
  }
}
