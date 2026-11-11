import axios from 'axios'
import { Uri, workspace } from 'vscode'
import { Config } from './Config'
import { CurrentFile } from './CurrentFile'
import { KeyDetector } from './KeyDetector'
import { Log } from '~/utils'

interface SyncLocalesResponse {
  success?: boolean
  stdout?: string
  stderr?: string
  code?: number | null
}

/** dev server 的实际端口由插件写进 .vscePackage/.dev-state.json 的 devServer 区块（端口可能不是 9006） */
/**
 * 找到能用的 /locales-sync 地址。
 *
 * 端口可能不是 9006（被占时 vite 会自动换），.dev-state.json 里的端口也可能过期
 * （多个 dev 实例、或服务已经停了）。所以按顺序探测，谁先应答用谁。
 */
async function resolveEndpoint(): Promise<string | null> {
  const configured = Config.syncBackend.syncEndpoint

  // 端口可能不是 9006（被占时 vite 会自动换），.dev-state.json 里的端口也可能过期
  // （多个 dev 实例、或服务已经停了）。所以按顺序探测，谁先应答用谁。
  let reportedPort: number | undefined
  const folder = workspace.workspaceFolders?.[0]?.uri
  if (folder) {
    try {
      const raw = JSON.parse(Buffer.from(await workspace.fs.readFile(Uri.joinPath(folder, '.vscePackage', '.dev-state.json'))).toString('utf8'))
      const port = raw?.devServer?.port
      if (typeof port === 'number')
        reportedPort = port
    }
    catch {
      // 没有端口文件就只探测配置值
    }
  }

  // 没配地址时，用 dev server 上报的端口拼一个默认值——这样公开的清单里不必带着
  // 内部开发地址（localhost:9006），而团队项目靠 .dev-state.json 仍能零配置工作。
  // 端口也读不到就没法同步，返回 null 由调用方跳过。
  const base = configured || (reportedPort ? `http://localhost:${reportedPort}/locales-sync` : '')
  if (!base)
    return null

  const withPort = (port: number) => base.replace(/:\d+(\/|$)/, `:${port}$1`)

  const candidates: string[] = [base]
  if (reportedPort)
    candidates.unshift(withPort(reportedPort))
  // 常见端口兜底（vite 端口被占会自动 +1）
  for (const port of [9006, 9007, 9008])
    candidates.push(withPort(port))

  for (const url of candidates) {
    try {
      // 该接口对 GET 返回 405，能应答就说明中间件在
      // 只认 200/405：502、代理错误页、超时都不算「这个端口上是 dev server」
      await axios.get(url, { timeout: 1500, validateStatus: st => st === 200 || st === 405 })
      if (url !== configured)
        Log.info(`[sync] 使用 ${url}`)
      return url
    }
    catch {
      // 换下一个
    }
  }
  return null
}

/**
 * 同步脚本由 dev server 的 python 进程写盘，插件进程感知不到：
 *   - LocaleLoader 内存里的词条树要主动重读，不能只等文件监听
 *   - KeyDetector 按 `filepath@version` 缓存源码里的 key 位置，脚本改写源码但
 *     文档版本号未必变化，缓存不清就会继续用旧位置（表现为注解不刷新）
 * 这里在同步成功后显式刷新一遍，文件监听仍作为兜底保留。
 */
async function refreshAfterLocaleSync() {
  try {
    KeyDetector.purgeAllCache()
    await CurrentFile.loader.reloadFromDisk()
    CurrentFile.invalidate()
    Log.info('[sync] 已主动重载词条与 key 缓存')
  }
  catch (e) {
    Log.warn(`[sync] 主动刷新失败（文件监听仍会兜底）: ${(e as Error).message}`)
  }
}

/**
 * 刷新本地词条，完全复用「i18n 管理页 → 新增前端」的做法：
 *
 *   页面按钮 = syncLocales() = POST /locales-sync
 *   （vite 中间件 src/plugins/localesSync.ts 跑 pythonUtils/syncAndUpdateLocales.py，
 *     里面已经设了 PYTHONIOENCODING=utf-8，扩展这边不需要再做任何事）
 */
export async function runLocaleSync(): Promise<boolean> {
  const endpoint = await resolveEndpoint()
  if (!endpoint) {
    Log.warn('[sync] 找不到可用的 dev server（9006-9008 都无应答），跳过本地词条刷新')
    return false
  }

  try {
    Log.info(`[sync] POST ${endpoint}`)
    const res = await axios.post(endpoint, {}, { timeout: 180_000 })
    const data = (res.data ?? {}) as SyncLocalesResponse

    data.stdout?.split(/\r?\n/).filter(Boolean).forEach(line => Log.info(line))
    data.stderr?.split(/\r?\n/).filter(Boolean).forEach(line => Log.warn(line))

    if (data.success === false) {
      Log.warn(`[sync] 同步脚本返回失败（code=${data.code ?? '-'}）`)
      return false
    }

    await refreshAfterLocaleSync()
    Log.info('[sync] 本地词条刷新完成')
    return true
  }
  catch (e) {
    Log.warn(`[sync] 调用 ${endpoint} 失败：${(e as Error).message}`)
    Log.warn('[sync] 词条文件未刷新，请确认 pnpm dev 正在运行')
    return false
  }
}
