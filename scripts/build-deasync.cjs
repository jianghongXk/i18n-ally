// 手动编译 deasync 原生模块（parcel-bundler 依赖它，`pnpm build:webview` 需要）。
//
// 为什么不用 deasync 自带的 install 脚本：
//   deasync 0.1.22 的 build.js 用 spawn('node-gyp.cmd', ['rebuild']) 调编译器。Node 18.20 /
//   20.12 起为修 CVE-2024-27980 禁止在 Windows 上不经 shell 直接 spawn .cmd/.bat，于是它
//   必然抛 EINVAL —— 与有没有装 node-gyp 无关，是那个版本的死穴。
//   这里绕开 .cmd，直接用 node 跑 node-gyp.js，编完把 .node 放到 index.js 优先查找的 bin 目录。
//
// 依赖：VS Build Tools（MSVC + Windows SDK）+ Python。缺了会在这里 git 报错，不影响
// `pnpm build` / `pnpm vsix`（那条链路只用 esbuild，跟原生模块无关）。
//
// 用法：pnpm build:deasync        已可用则直接跳过
//       pnpm build:deasync --force  强制重编
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const deasyncDir = path.join(root, 'node_modules', 'deasync')
const force = process.argv.includes('--force')

if (!fs.existsSync(deasyncDir)) {
  console.error('找不到 node_modules/deasync，先跑 pnpm install')
  process.exit(1)
}

function usable() {
  try {
    const d = require(deasyncDir)
    let hit = false
    const t = setTimeout(() => { hit = true }, 50)
    d.loopWhile(() => !hit)
    clearTimeout(t)
    return typeof d === 'function' && typeof d.loopWhile === 'function'
  }
  catch (e) {
    return false
  }
}

if (!force && usable()) {
  console.log('deasync 已可用，跳过编译（要重编加 --force）')
  process.exit(0)
}

// index.js 优先在 bin/<platform>-<arch>-node-<major.minor>/ 找，其次 bindings() 的 build/Release
const nodeV = 'node-' + /[0-9]+\.[0-9]+/.exec(process.versions.node)[0]
const binDir = path.join(deasyncDir, 'bin', `${process.platform}-${process.arch}-${nodeV}`)

const nodeGyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
if (!fs.existsSync(nodeGyp)) {
  console.error('缺少 node-gyp（devDependencies 里已声明 ^10，先跑 pnpm install）')
  process.exit(1)
}

console.log(`编译 deasync（node-gyp ${require(path.join(root, 'node_modules', 'node-gyp', 'package.json')).version}, ${process.platform}-${process.arch}-${nodeV}）...`)

const res = spawnSync(process.execPath, [nodeGyp, 'rebuild'], {
  cwd: deasyncDir,
  stdio: 'inherit',
})

if (res.status !== 0) {
  console.error('\ndeasync 编译失败。需要 VS Build Tools（C++ 桌面开发）+ Windows SDK + Python。')
  console.error('注意：这只影响 pnpm build:webview，pnpm build / pnpm vsix 不受影响。')
  process.exit(res.status || 1)
}

const built = path.join(deasyncDir, 'build', 'Release', 'deasync.node')
if (!fs.existsSync(built)) {
  console.error('编译成功但没找到 build/Release/deasync.node')
  process.exit(1)
}

fs.mkdirSync(binDir, { recursive: true })
fs.copyFileSync(built, path.join(binDir, 'deasync.node'))
console.log('已放置 ->', path.relative(root, path.join(binDir, 'deasync.node')))

if (usable())
  console.log('deasync 编译完成，可用')
else {
  console.error('dist 已生成但 require 失败，请检查 Node 版本与 deasync 源码是否匹配')
  process.exit(1)
}
