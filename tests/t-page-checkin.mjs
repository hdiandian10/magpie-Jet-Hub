// 「签到」tab 接线冒烟：id 对得上、tab/panel 成对、命令行生成正确。
// 跑法：node tests/t-page-checkin.mjs（不联网、不开浏览器）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const html = fs.readFileSync(path.join(ROOT, 'page', 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(ROOT, 'page', 'page.js'), 'utf8')

let bad = 0
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) bad++ }

console.log('--- 1) tab / panel 成对 ---')
ok(/data-tab="checkin"/.test(html), 'tab 栏有「签到」按钮（data-tab="checkin"）')
ok(/data-panel="checkin"/.test(html), '有 data-panel="checkin" 的 section')
const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1])
const panels = [...html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1])
for (const t of tabs) ok(panels.includes(t), `tab "${t}" 有对应 panel`)
ok(tabs.length === panels.length, `tab 数与 panel 数一致（${tabs.length} vs ${panels.length}）`)

console.log('--- 2) fillCheckin 找的节点都在 html 里 ---')
for (const id of ['ciUrlBox', 'ciCopy', 'ciCmd', 'ciUrlNote']) {
  ok(html.includes(`id="${id}"`), `html 里有 #${id}`)
}
ok(/id="ciCopy" data-copy="#ciUrlBox"/.test(html), 'ciCopy 走通用 data-copy 绑定（与控制台标签同一机制）')

console.log('--- 3) showTab 接线 ---')
ok(/if \(name === 'checkin'\) fillCheckin\(\)/.test(js), 'showTab("checkin") 触发 fillCheckin')
ok(/function fillCheckin\(\)/.test(js), 'fillCheckin 有定义')

console.log('--- 4) 地址与命令生成（抽逻辑求值）---')
const CON_PORT_DEFAULT = '18500'
const conUrlOf = (c) =>
  (c && typeof c.console === 'string' && /^https?:\/\//.test(c.console)) ? c.console : `http://127.0.0.1:${CON_PORT_DEFAULT}/`
const cmdOf = (u) =>
  `curl -s -X POST ${u.replace(/\/+$/, '')}/api/jet-hub \\` +
  `\n  -H 'Content-Type: application/json' \\` +
  `\n  -d '{"type":"client-request","rpcId":"check","method":"jet-hub","payload":{"method":"usage.autoCheckin","payload":{}}}'`
const withSnap = cmdOf(conUrlOf({ console: 'http://127.0.0.1:18501/' }))
const fallback = cmdOf(conUrlOf({}))
ok(withSnap.includes(':18501/api/jet-hub'), '快照端口会进命令（18501）')
ok(fallback.includes(':18500/api/jet-hub'), '无快照退回 18500')
ok(!/\/api\/jet-hub\/\//.test(withSnap), '末尾斜杠被吃掉（不出现双斜杠）')
ok(withSnap.includes('usage.autoCheckin'), '命令查的是 usage.autoCheckin')
ok(!withSnap.includes('runTasks'), '查询命令无副作用（不带 runTasks / claimAll）')

console.log('--- 5) fillCheckin 与 fillConsole 用同一地址来源 ---')
ok(/function fillCheckin\(\)[\s\S]*?conUrl\(\)/.test(js), 'fillCheckin 调 conUrl()（不另写端口）')
ok(/function fillCheckin\(\)[\s\S]*?catalog\(\)/.test(js), 'fillCheckin 读快照（catalog()）')

console.log(`\n${bad === 0 ? '✓ 全部通过' : `✗ ${bad} 项失败`}`)
if (bad > 0) process.exit(1)
