// 发版：版本号最低位 +1 → 重新编译 → 打包 → 推送。
// 调试打包用 `pnpm vsix`（不动版本号）。
//
// 为什么递增必须发生在 build 之前：
//   src/core/ReloadOnUpdate.ts 里 `import { version } from '../../package.json'`，
//   版本号是 esbuild 在编译期写进 bundle 的。如果先打包再升版本，就会出现
//   「bundle 里 v1.0.0、manifest 里 1.0.1」，而热替换链路正是靠 bundle 里的
//   buildVersion 判断「现在跑的到底是哪一版」——一旦错开就再也对不上。
//
// 失败不自动回滚：版本升了、bundle 也按新版本编好了，状态自洽，只是没发出包。
// 修好后跑一次 `pnpm vsix` 重新打包即可，不会重复升版本。
//
// 用法：
//   node scripts/release.cjs                  # patch: 1.0.0 -> 1.0.1
//   node scripts/release.cjs --bump minor     # 1.0.4 -> 1.1.0
//   node scripts/release.cjs --bump major     # 1.1.4 -> 2.0.0
//   node scripts/release.cjs --dry-run        # 只打印将要升到哪，不写不编不打包
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkgPath = path.join(root, 'package.json')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const bumpIdx = argv.indexOf('--bump')
const kind = bumpIdx >= 0 ? argv[bumpIdx + 1] : 'patch'

if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error(`--bump 只接受 patch / minor / major，收到的是 "${kind}"`)
  process.exit(1)
}

const raw = fs.readFileSync(pkgPath, 'utf8')
const current = JSON.parse(raw).version
const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(current)
if (!m) {
  console.error(`package.json 的 version "${current}" 不是 x.y.z 形式，无法自动递增`)
  process.exit(1)
}
const [, maj, min, pat, pre] = m
const next = kind === 'major'
  ? `${Number(maj) + 1}.0.0`
  : kind === 'minor'
    ? `${maj}.${Number(min) + 1}.0`
    // 当前是预发布（1.0.0-dev.3）时，patch 递增等于「脱离预发布」回到 1.0.0
    : (pre ? `${maj}.${min}.${pat}` : `${maj}.${min}.${Number(pat) + 1}`)

if (next === current) {
  console.log(`当前 ${current} 已是正式版，没有可升的 ${kind} 位`)
  process.exit(0)
}

console.log(`[发版] ${current} -> ${next}`)
if (dryRun) {
  console.log('[发版] --dry-run，未写入、未编译、未打包')
  process.exit(0)
}

// 只替换 version 那一行，其余格式原样保留（不用 JSON.stringify 重排整个文件）
const updated = raw.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`)
if (updated === raw) {
  console.error('写入新版本号失败：没在 package.json 里找到 version 字段')
  process.exit(1)
}
fs.writeFileSync(pkgPath, updated, 'utf8')

function run(script, label, extraEnv) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, ...extraEnv },
  })
  if (r.status !== 0) {
    console.error(`\n[发版] ${label}失败，版本号已升到 ${next}（未回滚）。`)
    console.error('[发版] 修好后跑 `pnpm vsix` 重新打包，不会重复升版本。')
    process.exit(r.status ?? 1)
  }
}

run('build-esbuild.cjs', '编译')
// 把旧版本号传给打包脚本，摘要里显示 `1.0.1 -> 1.0.2`，不用往上翻发版那行
run('pack-vsix.cjs', '打包', { VSIX_RELEASE_FROM: current })
