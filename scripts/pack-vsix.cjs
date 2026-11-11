// 自包含 vsix 打包器（不依赖 vsce，不需要外部模板文件）。
// 用法：node scripts/pack-vsix.cjs [out.vsix] [pkg1,pkg2,...]
//   默认输出 <root>/.vscePackage/<name>-<version>.vsix（name 取自 package.json）
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createRequire } = require('module')

const root = path.resolve(__dirname, '..')
const req = createRequire(path.join(root, 'package.json'))
const yazl = req('yazl')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const { buildManifest } = require('./lib/vsix-manifest.cjs')

// 这些包被 esbuild 声明为 external，运行时按需 require，必须原样进包
// nodejieba 不在此列：它只是 pinyin 的 optionalDependencies，仅 pinyin 的「分词」模式才 require，
// i18n-ally 走 limax 逐字转拼音（Extract.ts:41），不触发分词；缺了会自动降级，实测中文 slug 正常。
// prettier 已从这里移除：唯一的 require 出现在 @vue/component-compiler-utils 的
// compileTemplate 里（`if (prettify)` 分支，且包在 try/catch 中，缺了只推一条 tips）。
// 本扩展只用 SFC 的 parse、从不 compileTemplate，所以那 9.2MB 一次都加载不到。
const DEFAULT_EXTRA_PKGS = 'consolidate,bluebird,esm,ts-node,typescript,arg,buffer-from,source-map,source-map-support,make-error,yn,diff'

// 输出文件名跟 package.json 的 name 走：改名（fork 独立扩展）后不能还叫 i18n-ally-*.vsix，
// 否则 consumer 侧的自动安装插件按文件名猜 id 会猜错，pushToConsumers 的同族清理也会清不掉旧包。
const outFile = path.resolve(process.argv[2] || path.join(root, '.vscePackage', `${pkg.name}-${pkg.version}.vsix`))
const extraPkgs = (process.argv[3] || DEFAULT_EXTRA_PKGS).split(',').map((s) => s.trim()).filter(Boolean)

/** 打包结论，last-build.json 落盘用（md5 在摘要阶段算好） */
const report = { md5: '' }

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".yml" ContentType="text/yaml"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".html" ContentType="text/html"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".svg" ContentType="image/svg+xml"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".ts" ContentType="video/mp2t"/><Default Extension=".map" ContentType="application/json"/><Default Extension=".cjs" ContentType="application/octet-stream"/><Default Extension=".cmd" ContentType="application/octet-stream"/><Default Extension=".xml" ContentType="application/xml"/><Default Extension=".iml" ContentType="application/octet-stream"/><Default Extension=".mjs" ContentType="application/javascript"/><Default Extension=".markdown" ContentType="text/markdown"/><Default Extension=".lock" ContentType="application/octet-stream"/><Default Extension=".nix" ContentType="application/octet-stream"/><Default Extension=".cts" ContentType="application/octet-stream"/><Default Extension=".bnf" ContentType="application/octet-stream"/><Default Extension=".lcl" ContentType="application/octet-stream"/><Default Extension=".flow" ContentType="application/octet-stream"/><Default Extension=".bin" ContentType="application/octet-stream"/><Default Extension=".rb" ContentType="application/octet-stream"/><Default Extension=".gemspec" ContentType="application/octet-stream"/><Default Extension=".opts" ContentType="application/octet-stream"/><Default Extension=".1" ContentType="application/octet-stream"/><Default Extension=".tsbuildinfo" ContentType="application/octet-stream"/><Default Extension=".mts" ContentType="model/vnd.mts"/><Default Extension=".gyp" ContentType="application/octet-stream"/><Default Extension=".hpp" ContentType="application/octet-stream"/><Default Extension=".utf8" ContentType="application/octet-stream"/><Default Extension=".cpp" ContentType="text/x-c"/><Default Extension=".h" ContentType="text/x-c"/><Default Extension=".bsd" ContentType="application/octet-stream"/><Default Extension=".coffee" ContentType="text/coffeescript"/><Default Extension=".gypi" ContentType="application/octet-stream"/><Default Extension=".c" ContentType="text/x-c"/><Default Extension=".md~" ContentType="application/octet-stream"/><Default Extension=".patch" ContentType="application/octet-stream"/><Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>`

// 身份字段全部来自 package.json —— 见 scripts/lib/vsix-manifest.cjs。
// 这里以前整段写死 Id/Publisher/DisplayName/Engine、只替换 Version，
// 一旦改 name/publisher（fork 成独立扩展），就会打出「manifest 与 package.json
// 身份不一致」的包，安装后目录名和扩展 id 对不上。
const manifest = buildManifest(pkg)

// 改 name/publisher 时最容易漏掉的一处：src/meta.ts 的 EXT_ID 是硬编码的，
// 它是 extensions.getExtension() 唯一能找到自己的途径，不同步就一直是 undefined。
const metaTs = path.join(root, 'src/meta.ts')
if (fs.existsSync(metaTs)) {
  const m = fs.readFileSync(metaTs, 'utf8').match(/EXT_ID\s*=\s*['"]([^'"]+)['"]/)
  const expectId = `${pkg.publisher}.${pkg.name}`
  if (m && m[1] !== expectId)
    console.warn(`[警告] src/meta.ts 的 EXT_ID 是 "${m[1]}"，与清单身份 "${expectId}" 不一致 —— 改过 name/publisher 要一起改`)
}

// 换成新 ID 后，旧 ID 那份如果还装着，两个扩展的命令 id（i18n-ally.*）、view id、
// 配置项前缀完全一样，同时激活会互相抢注册（报 "command ... already exists"，
// 或后激活的那个静默失效）。命令 id 是 EXT_NAMESPACE 决定的、不能跟着改，
// 所以只能在装新包之前把旧版卸掉 —— 打包时就提醒一句。
const OLD_ID = 'lokalise.i18n-ally'
if (`${pkg.publisher}.${pkg.name}` !== OLD_ID) {
  for (const dir of ['.trae-cn', '.vscode', '.trae'].map(d => path.join(os.homedir(), d, 'extensions'))) {
    try {
      const stale = fs.readdirSync(dir).filter(d => d.startsWith(`${OLD_ID}-`))
      if (stale.length)
        console.warn(`[警告] ${dir} 里还装着旧 ID 的 ${stale.join('、')} —— 装新包前先卸载它，否则两套命令 id 会打架`)
    }
    catch {}
  }
}

const mainBundle = path.join(root, 'dist/extension.js')
if (!fs.existsSync(mainBundle)) {
  console.error(`缺少主 bundle：${path.relative(root, mainBundle)}\n先跑 pnpm build（改过 webview 还要 pnpm build:webview）`)
  process.exit(1)
}

// 陈旧检测：本脚本只打包、不编译，正常入口 `pnpm vsix` 已经先跑过 build，
// 这里兜的是「直接 node scripts/pack-vsix.cjs」绕过 build 的情况 —— 否则会把上次的旧代码打进包。
function newestMtime(dir, { ext, skipDir } = {}) {
  let max = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (skipDir && skipDir(abs)) continue
      max = Math.max(max, newestMtime(abs, { ext, skipDir }))
    }
    else if (!ext || ext.test(e.name)) {
      max = Math.max(max, fs.statSync(abs).mtimeMs)
    }
  }
  return max
}

const srcDir = path.join(root, 'src')
const webviewSrcDir = path.join(srcDir, 'webview', 'src')
// src/webview/src 归 parcel（侧边栏前端），不进主 bundle，要单独比
const isWebviewSrc = abs => abs === webviewSrcDir
const staleSrc = fs.existsSync(srcDir)
  ? newestMtime(srcDir, { ext: /\.(ts|vue|js)$/, skipDir: isWebviewSrc })
  : 0
if (staleSrc > fs.statSync(mainBundle).mtimeMs) {
  console.warn('[警告] src 比 dist/extension.js 新，包里装的是旧代码 —— 请用 pnpm vsix（会先 build）')
}

const editorHtml = path.join(root, 'dist/editor/index.html')
if (!fs.existsSync(editorHtml)) {
  // 直接失败，不能只警告：dist/ 在 .gitignore 里，全新 clone 必然没有这个文件，
  // 而少它的包装上去就是「侧边栏编辑器打不开」，属于坏包。以前只 warn + exit 0，
  // 会静默打出一个缺功能的包（实测：672 文件、16.1MB、包里没有 dist/editor/）。
  console.error('[错误] 缺少 dist/editor/index.html，侧边栏编辑器面板会打不开。\n先跑 pnpm build:webview（首次需 MSVC + Python，见 scripts/build-deasync.cjs）')
  process.exit(1)
}
else if (fs.existsSync(webviewSrcDir) && newestMtime(webviewSrcDir, { ext: /\.(ts|vue|js|css|html)$/ }) > fs.statSync(editorHtml).mtimeMs) {
  console.warn('[警告] src/webview/src 比 dist/editor/index.html 新，侧边栏编辑器还是旧版（pnpm build:webview）')
}

const files = []

/**
 * 按包限定「哪些文件才进包」。不在表里的包一律全量。
 *
 * typescript 整包 59MB，但真正会被加载的只有 `require('typescript')` 指向的
 * `lib/typescript.js`：ts-node 在 `--transpile-only` 模式下只调 transpileModule，
 * 不启动语言服务。tsserver / tsserverlibrary / typescriptServices / typingsInstaller /
 * tsc 合计约 50MB，永远进不了内存。
 * 实测：只留 package.json + lib/typescript.js 时，
 *   node ts-node/dist/bin.js --dir . --transpile-only --compiler-options ... assets/loader.js x.ts
 * 照常输出正确的 JSON。
 */
const PKG_FILE_ALLOW = {
  typescript: [/^package\.json$/, /^lib\/typescript\.js$/, /^LICENSE\.txt$/, /^CopyrightNotice\.txt$/],
}
const PKG_PATH_RE = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/

function walk(absDir, relDir) {
  for (const entry of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, entry)
    const rel = relDir ? relDir + '/' + entry : entry
    const st = fs.statSync(abs)
    if (st.isDirectory()) { walk(abs, rel); continue }
    if (/\.(d\.ts|map)$/.test(entry)) continue
    if (rel.startsWith('dist/test')) continue
    // tsc 只跑 --noEmit，dist/src 是历史残留，绝不进包（否则包里出现两份代码）
    if (rel === 'dist/src' || rel.startsWith('dist/src/')) continue
    // webview 只有 index.html 会进包：parcel-plugin-inliner 已把 js/css 全部内联进去
    // （见 package.json 的 build:webview），旁边那些 src.*.js/css 是 parcel 的中间产物，
    // 扩展端 panel.ts 只 readFileSync(index.html) 赋给 webview.html，带进去纯属浪费体积
    if (rel.startsWith('dist/editor/') && rel !== 'dist/editor/index.html') continue
    // 包级白名单（见上）
    const m = rel.match(PKG_PATH_RE)
    if (m && PKG_FILE_ALLOW[m[1]] && !PKG_FILE_ALLOW[m[1]].some(re => re.test(m[2]))) continue

    files.push({ abs, rel })
  }
}

for (const d of ['dist', 'res', 'assets', 'locales']) {
  const p = path.join(root, d)
  if (fs.existsSync(p)) walk(p, d)
}
for (const f of fs.readdirSync(root)) {
  if (!fs.statSync(path.join(root, f)).isFile()) continue
  // 上游历史日志已归档到 docs/，不该进包（本脚本不读 .vscodeignore，白名单在这里）
  if (f === 'CHANGELOG.upstream.md') continue
  // vsixmanifest 的 <License> 指向 extension/LICENSE.txt，而仓库里这份文件叫 LICENSE（无后缀），
  // 进包时改个名对齐，否则 manifest 引用的许可文件在包里根本不存在
  if (f === 'LICENSE') {
    files.push({ abs: path.join(root, f), rel: f, metaRel: 'LICENSE.txt' })
    continue
  }
  if (!/\.(json|md|png|txt)$/.test(f)) continue
  files.push({ abs: path.join(root, f), rel: f })
}
for (const p of extraPkgs) {
  const dir = path.join(root, 'node_modules', p)
  if (fs.existsSync(dir)) walk(dir, 'node_modules/' + p)
  else console.error('MISSING PKG', p)
}

// 固定包内条目的时间戳：yazl 默认取打包当刻的时间，同样的源码每次打出的 vsix
// 字节都不同，摘要里报的 md5 就失去意义（不能用来回答「这次和上次是不是同一份」）。
// 只影响 zip 条目的时间字段，不影响任何文件内容。
const ZIP_MTIME = new Date('2020-01-01T00:00:00Z')

const zip = new yazl.ZipFile()
fs.mkdirSync(path.dirname(outFile), { recursive: true })
const out = fs.createWriteStream(outFile)
zip.outputStream.pipe(out)
zip.addBuffer(Buffer.from(CONTENT_TYPES, 'utf8'), '[Content_Types].xml', { mtime: ZIP_MTIME })
zip.addBuffer(Buffer.from(manifest, 'utf8'), 'extension.vsixmanifest', { mtime: ZIP_MTIME })
for (const f of files) zip.addFile(f.abs, 'extension/' + (f.metaRel || f.rel), { mtime: ZIP_MTIME })
zip.end()

out.on('close', () => {
  const size = fs.statSync(outFile).size
  const removed = []

  // 同族只保留最新版本：生成 i18n-cn-1.0.2.vsix 后，删掉目录里旧的 i18n-cn-*.vsix
  const dir = path.dirname(outFile)
  const family = path.basename(outFile, '.vsix').replace(/-\d+(?:\.\d+)+(?:-.*)?$/, '')
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f)
      if (full === path.resolve(outFile)) continue
      if (!f.toLowerCase().endsWith('.vsix')) continue
      if (!f.startsWith(`${family}-`)) continue
      fs.unlinkSync(full)
      removed.push(f)
    }
  }
  catch (e) {
    console.error('cleanup failed:', e.message)
  }

  const pushed = pushToConsumers(outFile, family)

  // 所有结论集中到最后一块输出。
  // 打包过程本来只有几行，但在「发版」「CI」「对话里的长命令」这些场景中，
  // 关键行（推送到哪、装没装）很容易被上下的编译/清包日志冲掉，
  // 只留最后这块 —— 无论上面刷了多少行，末尾一眼就是结论。
  printSummary({ size, removed, pushed })

  // 落一份机器可读的结果，之后要核对「上次推的是哪一版、md5 是多少」不用再翻终端历史
  try {
    fs.writeFileSync(path.join(dir, 'last-build.json'), `${JSON.stringify({
      version: pkg.version,
      file: path.basename(outFile),
      md5: report.md5,
      files: files.length + 2,
      bytes: size,
      removed,
      pushed: pushed.map(p => ({ dir: p.dir, ok: p.ok })),
      at: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8')
  }
  catch {}
})


/**
 * 打包后把 vsix 推到消费端项目，恢复原来「打完包自动进 ems-ui」的流程。
 *
 * 原理：hite-cloud-ems-ui 的 Vite 插件 `src/plugins/vsixAutoInstall.ts`
 * 监听 `<项目根>/.vscePackage/` 目录，按 size+mtime 判断出新包后
 *   - 清单（package.json 去掉 version/__metadata）与当前活动扩展一致 → 直接把 bundle/nls/editor.html
 *     热替换进 `~/.trae-cn/extensions/lokalise.i18n-ally-<ver>/`，写 `.reload-request`（mode=host/silent）
 *   - 清单有变化 → 走 CLI 正常安装 + 整窗重载
 * 所以「推送」只是把文件放进那个目录，安装/热替换由插件完成。
 *
 * 目标写在本地配置文件 `.vscePackage/push-targets.json`（该目录已在 .gitignore 里，不进版本库）。
 * 优先级：VSIX_PUSH_DIR 环境变量（临时覆盖） > 配置文件 > 内置默认。
 */
const PUSH_CONFIG = path.join(root, '.vscePackage', 'push-targets.json')
const DEFAULT_PUSH_TARGETS = [
  { dir: 'D:/Codes/style/hite-cloud-ems-ui/.vscePackage', label: 'ems-ui', note: 'vite 插件监听此目录，自动热替换/安装' },
  { dir: 'D:/Docs/WorkBuddy', label: 'Docs', note: '交付留存（跨项目规矩：产物一律放这里）' },
]

/** 摘要里显示的名字：配置了 label 用 label，否则按内置目标反查，最后才退回目录名 */
function targetLabel(dir, label) {
  if (label)
    return label
  const norm = p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  // 老版配置文件（以及手写的）没有 label 字段，用内置目标同路径反查，
  // 否则摘要里会出现 ".vscePackage" / "WorkBuddy" 这种认不出是哪个项目的名字
  const hit = DEFAULT_PUSH_TARGETS.find(d => norm(d.dir) === norm(dir))
  return hit ? hit.label : (path.basename(dir) || dir)
}

/** 读目标列表；文件不存在就写一份默认的出来，方便直接改 */
function loadPushTargets() {
  const env = process.env.VSIX_PUSH_DIR
  if (env)
    return env.split(';').map(s => s.trim()).filter(Boolean).map(d => ({ dir: expandHome(d), label: targetLabel(d) }))

  if (!fs.existsSync(PUSH_CONFIG)) {
    try {
      fs.mkdirSync(path.dirname(PUSH_CONFIG), { recursive: true })
      fs.writeFileSync(PUSH_CONFIG, `${JSON.stringify({
        _note: '打包后自动把 vsix 复制到这些目录。dir 支持绝对路径，~ 开头的路径会展开到家目录。删掉某项即不推送。',
        targets: DEFAULT_PUSH_TARGETS,
      }, null, 2)}\n`, 'utf8')
      console.log(`[推送] 已生成配置文件：${path.relative(root, PUSH_CONFIG)}（可直接编辑）`)
    }
    catch (e) {
      console.warn(`[推送] 配置文件生成失败，用内置默认：${e.message}`)
    }
    return DEFAULT_PUSH_TARGETS.map(t => ({ ...t }))
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(PUSH_CONFIG, 'utf8'))
    // 允许两种写法：[ "...", ... ] 或 { targets: [ { dir, label }, ... ] }
    const list = Array.isArray(parsed) ? parsed : parsed?.targets
    const targets = (Array.isArray(list) ? list : [])
      .map(t => (typeof t === 'string' ? { dir: t } : t))
      .filter(t => t?.dir)
      .map(t => ({ dir: expandHome(t.dir), label: targetLabel(t.dir, t.label) }))
    if (!targets.length) {
      console.warn(`[推送] 配置文件里没有有效目标（${path.relative(root, PUSH_CONFIG)}），本次不推送`)
    }
    return targets
  }
  catch (e) {
    console.warn(`[推送] 配置文件解析失败，本次不推送（修好再打包）：${e.message}`)
    return []
  }
}

function expandHome(p) {
  if (!/^~[\\/]/.test(p))
    return p
  return path.join(process.env.USERPROFILE || process.env.HOME || '', p.slice(2))
}

function pushToConsumers(vsixPath, family) {
  if (process.env.VSIX_NO_PUSH === '1')
    return []

  const targets = loadPushTargets()
  const results = []

  // 成功不在这里打日志：结论统一由 printSummary 收口。
  // 以前每推一个就打一行，混在清包/编译日志里很容易被漏看（问「推没推」就是这么来的）。
  for (const { dir, label } of targets) {
    if (!fs.existsSync(dir)) {
      results.push({ dir, label, ok: false, error: '目录不存在', cleaned: [] })
      continue
    }
    try {
      // 先清同族旧包：插件按「size/mtime 与记录不符」判定待安装项，
      // 残留的旧 vsix 会被当成新包再装一次（可能降级），必须清掉
      const legacyNamed = []
      const cleaned = []
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.vsix')) continue
        if (f === path.basename(vsixPath)) continue
        if (f.startsWith(`${family}-`)) {
          fs.unlinkSync(path.join(dir, f))
          cleaned.push(f)
        }
        // 改过 name 之后，旧包名不匹配新 family，上面那一刀砍不到它。
        // 而消费端插件是从文件名猜扩展 id 的：看到 i18n-ally-2.17.7.vsix 会当成
        // 「一个尚未安装的扩展」直接调 CLI 装回去 —— 等于把原版又装一遍。
        // 这里只提示不动手，那个文件可能是别人特意留的。
        else if (f.startsWith('i18n-ally-')) {
          legacyNamed.push(f)
        }
      }
      if (legacyNamed.length)
        console.warn(`[推送] ${dir} 里还留着旧包名的 ${legacyNamed.join('、')} —— 自动安装插件会把它当成另一个扩展再装一遍，建议删掉`)
      fs.copyFileSync(vsixPath, path.join(dir, path.basename(vsixPath)))
      results.push({ dir, label, ok: true, cleaned })
    }
    catch (e) {
      results.push({ dir, label, ok: false, error: e.message, cleaned: [] })
    }
  }
  return results
}

/**
 * 读消费端的安装状态（尽力而为）：ems-ui 的自动安装插件把当前活动版本写在
 * <推送目录>/.dev-state.json 的 active.version 里，把已消费过的包记在 vsix[name]。
 * 文件不存在/格式变了就当作不知道，不能让摘要因为别人的私有文件格式而报错。
 */
function readConsumerState(dir, vsixName) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, '.dev-state.json'), 'utf8'))
    return {
      version: s?.active?.version || '',
      seen: s?.vsix?.[vsixName] || null,
    }
  }
  catch {
    return null
  }
}

/**
 * 打包结论：所有关键事实集中到最后这一块。
 *
 * 为什么要有它：打包过程本来是零散打印的（编译一行、清包几行、每个推送目标一行），
 * 在「发版 / 长命令 / 日志被折叠只看末尾」的场景里，最该看的那几句常常被冲掉。
 * 现在无论上面刷了什么，末尾这块固定收口：版本、产物、md5、清理、推送、装没装。
 */
function printSummary({ size, removed, pushed }) {
  report.md5 = crypto.createHash('md5').update(fs.readFileSync(outFile)).digest('hex')

  const from = process.env.VSIX_RELEASE_FROM
  const bar = '─'.repeat(64)
  const mb = (size / 1024 / 1024).toFixed(1)
  const lines = [
    '',
    bar,
    ` ${pkg.displayName || pkg.name}  v${pkg.version}${from ? `   (${from} → ${pkg.version})` : ''}`,
    ` ${path.basename(outFile)}   ${files.length + 2} 文件 / ${mb} MB`,
    ` md5  ${report.md5}`,
  ]

  if (removed.length)
    lines.push(` 清理 本地旧包 ${removed.join('、')}`)

  // 推送：成功的只列名字，失败的带原因
  if (process.env.VSIX_NO_PUSH === '1')
    lines.push(' 推送 已跳过（VSIX_NO_PUSH=1）')
  else if (!pushed.length)
    lines.push(' 推送 无目标')
  else {
    const ok = pushed.filter(p => p.ok).map(p => p.label)
    const bad = pushed.filter(p => !p.ok).map(p => `${p.label}(${p.error})`)
    const cleaned = pushed.flatMap(p => p.cleaned || [])
    const parts = []
    if (ok.length) parts.push(`✓ ${ok.join('、')}`)
    if (bad.length) parts.push(`✗ ${bad.join('、')}`)
    if (cleaned.length) parts.push(`清旧包 ${cleaned.length} 个`)
    lines.push(` 推送 ${parts.join('   ')}`)
  }

  // 消费端状态：只有能读到 .dev-state.json 的目标才知道装没装。
  // 注意区分「装着同版本号」和「刚推的这份被消费了」—— 调试打包不动版本号，
  // 只说「已装 v1.0.2」会让人以为新代码已经生效，其实还是上一次的 bundle。
  const vsixName = path.basename(outFile)
  for (const p of pushed.filter(x => x.ok)) {
    const st = readConsumerState(p.dir, vsixName)
    if (!st?.version)
      continue
    let consumed = false
    try {
      const s = fs.statSync(path.join(p.dir, vsixName))
      consumed = !!st.seen && st.seen.mtimeMs === Math.round(s.mtimeMs) && st.seen.size === s.size
    }
    catch {}
    if (st.version !== pkg.version)
      lines.push(` 安装 ${p.label} 待装（现装 v${st.version}，需该项目 dev server 在跑）`)
    else if (consumed)
      lines.push(` 安装 ${p.label} 已装 v${st.version}`)
    else
      lines.push(` 安装 ${p.label} 现装 v${st.version}，本次包待消费（dev server 未运行）`)
  }

  lines.push(bar)
  console.log(lines.join('\n'))
}

