/**
 * 版本号自增：一天最多一次。
 *
 * 规则（洪 2026-11-11 定）：
 *   - 当天第一次打包 → patch +1
 *   - 当天后续打包   → 保持当前版本（内容变了靠 md5 区分，包名相同、覆盖）
 *   - version 被外部改过（手动改 / `pnpm vsix:release`）→ 尊重它，只把日期登记为今天
 *
 * 状态放在 .vscePackage/last-bump.json（该目录已 gitignore，是机器本地状态，不该进仓库）：
 *   { "date": "2026-11-11", "version": "1.0.10" }
 *
 * 状态文件丢了会当作「今天没升过」再升一次 —— 可接受的退化：本地状态本来就该跟着
 * 打包目录一起重建，比起把日期写进 package.json（污染清单）好。
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const pkgPath = path.join(root, 'package.json')
const stateDir = path.join(root, '.vscePackage')
const statePath = path.join(stateDir, 'last-bump.json')

/** 本地时区的 YYYY-MM-DD。不能用 toISOString()——那是 UTC，晚上 8 点后会算到第二天 */
function today() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const raw = fs.readFileSync(pkgPath, 'utf8')
const current = JSON.parse(raw).version

let state = {}
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
}
catch {
  state = {}
}

function save(version) {
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify({ date: today(), version }, null, 2)}\n`, 'utf8')
}

// 版本被外部改过 → 那一刻已经「用掉」了今天的名额，只登记日期
if (state.version && state.version !== current) {
  save(current)
  console.log(`[bump] 版本已被外部改为 ${current}，今天不再自增`)
  process.exit(0)
}

if (state.date === today()) {
  console.log(`[bump] 今天已升过（${state.version}），保持 ${current}`)
  process.exit(0)
}

const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/)
if (!m) {
  console.error(`[bump] version "${current}" 不是 x.y.z 形式，跳过自增`)
  process.exit(0)
}

const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
// 只替换 version 那一行，其余格式原样保留
fs.writeFileSync(pkgPath, raw.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`), 'utf8')
save(next)
console.log(`[bump] 今天第一次打包：${current} → ${next}`)
