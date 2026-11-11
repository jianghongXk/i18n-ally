// 唯一构建方式（webpack 已移除）：esbuild 打包，约 1~2s 产出 dist/extension.js。
// package.json 的 main 就是 ./dist/extension，所以 F5 调试直接用这个文件。
// 用法：node scripts/build-esbuild.cjs [--watch]
const path = require('path')
const fs = require('fs')
const { createRequire } = require('module')

const root = path.resolve(__dirname, '..')
process.chdir(root)
const esbuild = createRequire(path.join(root, 'package.json'))('esbuild')

const watch = process.argv.includes('--watch')
const outfile = path.resolve('dist/extension.js')

function resolveTilde(rel) {
  const base = path.resolve('src', rel)
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return `${base}.ts`
}

const options = {
  entryPoints: [path.resolve('src/extension.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node14',
  outfile,
  // 这几个在运行时按需 require，打进 bundle 会破坏原生模块/动态加载
  external: [
    'vscode', 'nodejieba', 'esm', 'ts-node', 'consolidate',
    'less', 'sass', 'stylus', 'prettier', '@microsoft/typescript-etw',
  ],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{
    name: 'tilde-alias',
    setup(build) {
      build.onResolve({ filter: /^~\// }, args => ({
        path: resolveTilde(args.path.slice(2)),
        namespace: 'file',
      }))
    },
  }, {
    // @vue/compiler-sfc 把 consolidate 整份内联进了自己的 dist，里面为每种模板引擎
    // 都留了 `require('ejs')` 之类的分支（用到才执行）。yarn 扁平安装时这些可选项
    // 恰好都在顶层所以能解析；pnpm 不会装它们，构建会因「Could not resolve」失败。
    // 这里只针对 compiler-sfc 内部的裸模块：顶层真没有的就当 external，
    // 保留下来的 require 只在选用该引擎时才会执行，本项目只用 pug。
    name: 'optional-template-engines',
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!args.importer.includes('compiler-sfc'))
          return null
        const pkgName = args.path.startsWith('@')
          ? args.path.split('/').slice(0, 2).join('/')
          : args.path.split('/')[0]
        if (fs.existsSync(path.join('node_modules', pkgName)))
          return null
        return { path: args.path, external: true }
      })
    },
  }],
  logLevel: 'error',
  metafile: true,
}

function report(result) {
  const size = fs.statSync(outfile).size
  const seconds = result ? (result.durationMs / 1000).toFixed(1) : '?'
  console.log(`esbuild ${seconds}s ${(size / 1024 / 1024).toFixed(1)}MB -> dist/extension.js`)
}

;(async() => {
  if (!watch) {
    const t0 = Date.now()
    await esbuild.build(options)
    report({ durationMs: Date.now() - t0 })
    return
  }

  // esbuild 0.12 还没有 context()/watch() 两段式 API，用 build({ watch: true })
  let t0 = Date.now()
  await esbuild.build({
    ...options,
    watch: true,
    plugins: [...options.plugins, {
      name: 'watch-report',
      setup(build) {
        build.onStart(() => {
          t0 = Date.now()
        })
        build.onEnd((result) => {
          if (result.errors && result.errors.length) {
            console.error(`esbuild failed: ${result.errors.length} error(s)`)
          }
          else {
            report({ durationMs: Date.now() - t0 })
            console.log('watching src/ ... (Ctrl+C to stop)')
          }
        })
      },
    }],
  })
})().catch((e) => {
  console.error('esbuild failed:', e.message)
  process.exit(1)
})
