/**
 * 变更日志只留最新一版，旧条目自动归档。
 *
 * 原因：CHANGELOG.md 会随扩展一起分发给用户（变更声明弹窗打开的就是它），
 * 无限增长既占体积也没人看历史。规则（洪 2026-11-11 定）：
 *   - `CHANGELOG.md` 只保留**最新一个版本**的条目
 *   - 更早的条目搬到 `docs/CHANGELOG.history.md`（docs/ 不进包）
 *
 * 挂在 `pnpm vsix` 链上，在 build 之前跑：包里拿到的永远是精简版。
 * 版本号一天最多升一次（bump-daily.cjs），所以「最新一版」≈「最新一天」。
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const logPath = path.join(root, 'CHANGELOG.md')
const historyPath = path.join(root, 'docs/CHANGELOG.history.md')

const HISTORY_HEAD = `# Changelog 历史

> 仅作存档，**不随扩展分发**，也不出现在变更声明里。当前版本的变更见 [CHANGELOG.md](../CHANGELOG.md)。

`

const raw = fs.readFileSync(logPath, 'utf8')
const firstSection = raw.search(/^## /m)
if (firstSection < 0) {
  console.log('[changelog] 没有版本条目，跳过')
  process.exit(0)
}

const header = raw.slice(0, firstSection)
const body = raw.slice(firstSection)

// 按 "## " 切出各版本段（保留分隔符）
const sections = body.split(/^(?=## )/m).filter(s => s.trim())
if (sections.length <= 1) {
  console.log('[changelog] 只有 1 个版本条目，无需归档')
  process.exit(0)
}

const keep = sections[0].trimEnd() + '\n'
const move = sections.slice(1).map(s => s.trimEnd()).join('\n\n')

// CHANGELOG.md 只留最新一版
fs.writeFileSync(logPath, header + keep, 'utf8')

// 旧条目插到归档文件的说明之后（保持倒序：新的在上）
let history = ''
try {
  history = fs.readFileSync(historyPath, 'utf8')
}
catch {
  history = ''
}

if (!history.trim()) {
  history = HISTORY_HEAD + move + '\n'
}
else {
  const cut = history.search(/^## /m)
  if (cut < 0) {
    history = history.trimEnd() + '\n\n' + move + '\n'
  }
  else {
    history = history.slice(0, cut) + move + '\n\n' + history.slice(cut)
  }
}

fs.mkdirSync(path.dirname(historyPath), { recursive: true })
fs.writeFileSync(historyPath, history, 'utf8')

console.log(`[changelog] 归档 ${sections.length - 1} 个旧版本到 docs/CHANGELOG.history.md，CHANGELOG.md 只留最新一版`)
