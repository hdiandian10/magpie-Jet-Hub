/**
 * 控制台「领取 + 成长任务」的接线守卫。
 *
 * 背景（2026-11-13）：magpie 侧原先调 `credits.claimAll` 时**只传 `provider`**，
 * 于是 `runTasks` 缺省为 false，成长中心任务永远不跑 —— 而 vendor 里那份成长
 * 引擎一行不缺。症状是「DSH 里有『一键领取积分 + 成长任务』，magpie 里只有
 * 『全部领取』」，看起来像功能阉割，实际只是适配层漏了一个参数。
 *
 * 这条测试锁四件事，任何一件回退都会让「按钮点了不跑任务」重新静默发生：
 *   A) 源码守卫：`credits.claimAll` 的调用点必须按 `GROWTH_TASK_PROVIDERS` 传 `runTasks`；
 *   B) 名单一致性：`GROWTH_TASK_PROVIDERS` 必须与 vendor 的 `afterClaim` 实现表、
 *      以及 DSH 客户端的同名集合**三方一致**（漏一处就是点了必然失败的按钮）；
 *   C) 回包折叠：`summarizeGrowth` 把 `growth` 数组折成一句话，口径与 DSH 客户端一致；
 *   D) 缺席容忍：没有 `growth`（非成长渠道 / 未传 runTasks）时返回 null，不报错。
 *
 * 跑法：`node tests/t-console-growth.mjs`（不联网、不碰真实 ~/.dsh）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONSOLE = path.join(ROOT, 'console', 'console.js')
const CREDITS = path.join(ROOT, 'vendor', 'lib', 'provider-credits.js')
const CLIENT = path.join(ROOT, 'vendor', 'lib', 'client', 'jet-hub.js')

let bad = 0
let total = 0
const ok = (cond, msg) => {
  total++
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) bad++
}

// 行尾归一化成 \n，否则 indexOf 的定位串一个都对不上（仓库在 Windows 上是 CRLF）
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const src = read(CONSOLE)
const creditsSrc = read(CREDITS)
const clientSrc = read(CLIENT)

/* ── A. 源码守卫：调用点真的传了 runTasks ───────────────────────────── */

console.log('--- A) credits.claimAll 的调用点必须传 runTasks ---')
{
  // 只截 `creditsClaim` 这一个函数体（同一个文件里 `credits.balances` 等调用点不该被这条约束）
  const start = src.indexOf('async function creditsClaim(')
  ok(start > 0, '找到 console/console.js 的 creditsClaim')
  const end = src.indexOf('\nasync function creditsSpecial(', start)
  ok(end > start, '找到 creditsClaim 的结尾')
  const body = start > 0 && end > start ? src.slice(start, end) : ''

  ok(/rpc\('credits\.claimAll'/.test(body), '调用 credits.claimAll')
  ok(/runTasks:\s*true/.test(body), '传了 runTasks: true（缺了它成长任务永远不跑）')
  ok(/budgetMs:\s*GROWTH_BUDGET_MS/.test(body), '传了 budgetMs（缺省会让单个卡住的账号拖到超时）')
  ok(
    /GROWTH_TASK_PROVIDERS\.has\(provider\)/.test(body),
    '按渠道判是否带成长任务（不能对所有 29 家都传 true）',
  )
  // ⚠️ 不能写成「无条件展开」—— 那会把 runTasks 发给没有成长中心的渠道。
  //    判据是「展开是条件式的」：`...(withTasks ? {...} : {})`
  ok(
    /\.\.\.\(withTasks\s*\?/.test(body),
    'runTasks / budgetMs 是条件展开（`...(withTasks ? {…} : {})`）',
  )
  // 并发闸：成长一轮数分钟，两轮并发会各自打一遍上游
  ok(/CLAIM_IN_FLIGHT/.test(body), '有 CLAIM_IN_FLIGHT 并发闸')
}

/* ── B. 名单一致性：三处必须同集合 ─────────────────────────────────── */

console.log('--- B) GROWTH_TASK_PROVIDERS 与 vendor 两处一致 ---')
{
  const m = /const GROWTH_TASK_PROVIDERS = new Set\(\[([^\]]*)\]\)/.exec(src)
  ok(m !== null, '找到 console 的 GROWTH_TASK_PROVIDERS 定义')
  const consoleSet = m
    ? new Set(
        m[1]
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean),
      )
    : new Set()

  // 1) vendor 的 afterClaim 实现表：`afterClaim: (credential, entry, run) => …`
  //    每处出现都往上找最近的 provider 常量（`CODEBUDDY` / `WORKBUDDY` …）。
  //    ⚠️ 不按「整行是否含 buddy」判 —— 那样 `CODEBUDDY` 与 `WORKBUDDY` 都会命中，
  //       正是这条测试要抓的混淆。
  const afterClaimConsts = [...creditsSrc.matchAll(/afterClaim:\s*\([^)]*\)\s*=>/g)].map((hit) => {
    const head = creditsSrc.slice(Math.max(0, hit.index - 4000), hit.index)
    // 往上找最近的 `case 'xxx':` 或 provider 常量引用，取最后一个
    const consts = [...head.matchAll(/\b(CODEBUDDY|WORKBUDDY|TRAE|ZCODE|QODER|LOOMY|ACCIO|MINIMAX|MAGICREW|RACCOON|CLINE)\b/g)]
    return consts.length > 0 ? consts[consts.length - 1][1] : ''
  })
  ok(
    afterClaimConsts.length > 0,
    `vendor 里有 afterClaim 实现（找到 ${afterClaimConsts.length} 处）`,
  )
  // 常量名 → 上游 provider id。只登记**当前真有 afterClaim 的**那一家；
  // 加新家时必须在这里补一行，测试会红着提醒（这正是它的作用）。
  const CONST_TO_ID = { CODEBUDDY: 'buddy', WORKBUDDY: 'workbuddy' }
  const vendorSet = new Set(afterClaimConsts.map((c) => CONST_TO_ID[c] ?? c.toLowerCase()))
  ok(
    vendorSet.size === consoleSet.size && [...vendorSet].every((id) => consoleSet.has(id)),
    `console 名单 = vendor afterClaim 名单（console: ${[...consoleSet].join(',') || '空'}；vendor: ${[...vendorSet].join(',') || '空'}）`,
  )

  // 2) DSH 客户端那张同名表（决定按钮渲不渲染）
  const cm = /var GROWTH_TASK_PROVIDERS = \/\* @__PURE__ \*\/ new Set\(\[([^\]]*)\]\)/.exec(clientSrc)
  ok(cm !== null, '找到 vendor/lib/client 的 GROWTH_TASK_PROVIDERS')
  const clientSet = cm
    ? new Set(
        cm[1]
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean),
      )
    : new Set()
  ok(
    clientSet.size === consoleSet.size && [...clientSet].every((id) => consoleSet.has(id)),
    `console 名单 = DSH 客户端名单（client: ${[...clientSet].join(',') || '空'}）`,
  )

  // 3) workbuddy 不该在里面：国际版后端没有成长中心（上游实测无任务列表、无 claim 端点）
  ok(!consoleSet.has('workbuddy'), 'workbuddy 不在名单里（国际版没有成长中心）')
}

/* ── C/D. summarizeGrowth 的行为（从真源码抽出来求值）─────────────── */

function sliceFn(prefix) {
  const start = src.indexOf(prefix)
  if (start < 0) throw new Error(`截不到源码片段：找不到 ${JSON.stringify(prefix)}`)
  const end = src.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`截不到源码片段的结尾：${JSON.stringify(prefix)}`)
  return src.slice(start, end + 3)
}

const summarizeSrc = sliceFn('function summarizeGrowth(')
const isNotRunSrc = sliceFn('function isNotRunTask(')

// `formatCreditAmount` 是模块级函数 —— 用同名局部实现顶替（逐字复制 vendor 口径：
// 整数不带小数位、有小数才两位），让抽出来的源码原样跑。
const harness = new Function(
  `
  function formatCreditAmount(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  ${isNotRunSrc}
  ${summarizeSrc}
  return summarizeGrowth
  `,
)()
const summarizeGrowth = harness

console.log('--- C) 折叠口径 ---')
{
  // 真实回包形状：`RpcBuddyGrowthAccountResult`（vendor/lib/types.d.ts:862-885）
  const growth = [
    {
      accountId: 'b1',
      nickname: '阿黄',
      ok: true,
      completed: 2,
      clientOnly: 1,
      failed: 0,
      claimedCount: 3,
      claimedCredit: 150,
      timedOut: false,
      tasks: [
        { taskCode: 'daily_chat', ok: true, message: '完成' },
        { taskCode: 'share', ok: true, message: '完成' },
        { taskCode: 'wechat', ok: true, message: '需微信里打开', clientOnly: true },
      ],
    },
  ]
  const r = summarizeGrowth(growth)
  ok(r !== null, '有 growth 时返回摘要')
  ok(r.text.includes('成长完成 2 项'), `数完成项（实际：${r.text}）`)
  ok(r.text.includes('成长需客户端 1 项'), '数需客户端项')
  ok(r.text.includes('自动领取 3 项（+150 积分）'), '数扫尾自动领取')
  ok(r.text.includes('成长失败') === false, '没有失败项时不写「成长失败」')
  ok(r.failed === 0, 'failed 计数为 0')
  ok(r.details.some((d) => d.includes('阿黄：完成 2 项')), '明细带账号名与分项')
  ok(r.details.some((d) => d.includes('daily_chat')), '明细逐项列出 taskCode')

  // ⚠️ 回包里的 `completed` 与逐项明细**对不上**（2026-11-13 buddy 真跑一轮实测：
  //    `completed: 1`，同账号 `ok && !clientOnly` 有 3 条）。上游 DSH 客户端拿
  //    `completed` 写汇总、拿明细数写逐账号行，于是它自己两行字互相矛盾。
  //    本实现**统一按明细数**，这条用例把它钉住。
  const skew = summarizeGrowth([
    {
      accountId: 'b9',
      nickname: '阿黄',
      ok: true,
      completed: 1, // ← 上游给的错数
      clientOnly: 0,
      failed: 0,
      claimedCount: 0,
      claimedCredit: 0,
      timedOut: false,
      tasks: [
        { taskCode: 'a', ok: true, message: '完成' },
        { taskCode: 'b', ok: true, message: '完成' },
        { taskCode: 'c', ok: true, message: '完成' },
      ],
    },
  ])
  ok(
    skew.text.includes('成长完成 3 项'),
    `按明细数而不是回包的 completed（实际：${skew.text}）`,
  )
  ok(
    skew.details.some((d) => d.includes('完成 3 项')),
    '汇总与逐账号行同源（不会再出现「完成 1 项」配「完成 3 项」）',
  )
}

console.log('--- D) 缺席 / 异常形态必须容忍 ---')
{
  ok(summarizeGrowth(undefined) === null, 'undefined ⇒ null（没传 runTasks 的渠道走这条）')
  ok(summarizeGrowth([]) === null, '空数组 ⇒ null')
  ok(summarizeGrowth(null) === null, 'null ⇒ null')
  ok(summarizeGrowth('boom') === null, '非数组 ⇒ null（不抛）')

  // 账号级 error：只记原因，不把 0 项当成「完成 0 项」
  const r = summarizeGrowth([
    { accountId: 'b2', nickname: '小蓝', ok: false, completed: 0, clientOnly: 0, failed: 0, tasks: [], error: '凭据失效' },
  ])
  ok(r !== null && r.details.some((d) => d.includes('凭据失效')), '账号级 error 进明细')
  ok(r.text === '', `全失败时摘要为空串（由调用方决定怎么显示；实际 ${JSON.stringify(r.text)}）`)

  // timedOut 单独提示「再点一次即可继续」
  const t = summarizeGrowth([
    {
      accountId: 'b3',
      nickname: '阿黄',
      ok: false,
      completed: 1,
      clientOnly: 0,
      failed: 0,
      claimedCount: 0,
      claimedCredit: 0,
      timedOut: true,
      tasks: [{ taskCode: 'daily_chat', ok: true, message: '完成' }],
    },
  ])
  ok(t !== null && t.timedOut === true, 'timedOut 透出给调用方')
  ok(/再点一次/.test(t.text), `摘要提示可继续（实际：${t.text}）`)

  // 有失败项：failed 计数透出，调用方据此把文案标 warn
  const f = summarizeGrowth([
    {
      accountId: 'b4',
      nickname: '阿黄',
      ok: false,
      completed: 0,
      clientOnly: 0,
      failed: 2,
      claimedCount: 0,
      claimedCredit: 0,
      timedOut: false,
      tasks: [
        { taskCode: 'a', ok: false, message: '上游 500' },
        { taskCode: 'b', ok: false, message: '限流' },
      ],
    },
  ])
  ok(f !== null && f.failed === 2, '失败项计数透出')
  ok(f.text.includes('成长失败 2 项'), `摘要写明失败项数（实际：${f.text}）`)
  ok(f.details.some((d) => d.includes('失败 — 上游 500')), '明细带失败原因原文')

  // ⚠️ 「预算用尽 ⇒ 未执行」不是失败。实测 90s 预算下 `failed: 11` 里有 9 条
  //    是「本轮时间预算已用尽，未执行」—— 报成失败会让用户以为任务坏了。
  const nr = summarizeGrowth([
    {
      accountId: 'b5',
      nickname: '阿黄',
      ok: false,
      completed: 0,
      clientOnly: 0,
      failed: 3, // ← 上游把未执行的也数进来了
      claimedCount: 0,
      claimedCredit: 0,
      timedOut: true,
      tasks: [
        { taskCode: 'a', ok: false, message: '本轮时间预算已用尽，未执行（点一次按钮可继续）' },
        { taskCode: 'b', ok: false, message: '本轮时间预算已用尽，未执行（点一次按钮可继续）' },
        { taskCode: 'c', ok: false, message: '事件上报请求失败（HTTP 400）' },
      ],
    },
  ])
  ok(nr !== null && nr.failed === 1, `未执行不计入失败（实际 failed=${nr?.failed}）`)
  ok(nr.notRun === 2, `未执行单独计数（实际 notRun=${nr?.notRun}）`)
  ok(nr.text.includes('成长失败 1 项'), `摘要只报真失败 1 项（实际：${nr.text}）`)
  ok(nr.text.includes('未执行 2 项'), '摘要另报未执行 2 项')
  ok(
    nr.details.filter((d) => d.includes('预算')).length === 1,
    '未执行合并成一行（不逐条铺开，否则真失败会被淹掉）',
  )
  ok(nr.details.some((d) => d.includes('失败 — 事件上报请求失败')), '真失败仍在明细里')

  // 判据必须窄：不含这两个短语的 ok:false 一律算真失败
  const narrow = summarizeGrowth([
    {
      accountId: 'b6',
      nickname: '阿黄',
      ok: false,
      completed: 0,
      clientOnly: 0,
      failed: 0,
      claimedCount: 0,
      claimedCredit: 0,
      timedOut: false,
      tasks: [{ taskCode: 'x', ok: false, message: 'model [default-model] service info not found' }],
    },
  ])
  ok(narrow.failed === 1, '不带「时间预算 / 未执行」的 ok:false 算真失败')
  ok(narrow.notRun === 0, '不被误判成未执行')
}

console.log(`\n${bad === 0 ? '✓ 全部通过' : `✗ ${bad} 项失败`}（${total} 项）`)
if (bad > 0) process.exit(1)
