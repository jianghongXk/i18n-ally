import { commands, extensions, window } from 'vscode'
import i18n from '~/i18n'
import { Log } from '~/utils'

/**
 * 旧版（lokalise.i18n-ally）与当前扩展的 `EXT_NAMESPACE` 完全相同，
 * 也就是命令 id、view id、配置键一一重合 —— 这是「fork 但保留配置兼容」的代价。
 *
 * 两者的 `commands.registerCommand` 会撞车：VS Code 的注册表对重复 id 直接抛
 * `command 'xxx' already exists`，而 extension.ts 里的模块注册没有 try/catch，
 * 一次抛错就中断整条 activate。表现是「装了但时好时坏、树视图空白、命令没反应」，
 * 而且取决于谁先激活，极难排查。
 *
 * 所以在注册任何东西之前先拦一道：发现旧版就提示卸载，并且**不再继续激活**。
 * 宁可整个扩展不工作（至少界面上有一条明确的提示），也不要半注册后随机出错。
 *
 * 旧版卸载不影响任何配置：两者的配置前缀都是 `i18n-ally.*`。
 */
const LEGACY_ID = 'lokalise.i18n-ally'

export async function guardLegacyExtension(): Promise<boolean> {
  let legacy
  try {
    legacy = extensions.getExtension(LEGACY_ID)
  }
  catch {
    // 取不到就当没有，不要因为守卫本身把扩展搞挂
    return false
  }

  if (!legacy)
    return false

  const version = legacy.packageJSON?.version ?? '?'
  Log.warn(`⚠️ 检测到旧版 ${LEGACY_ID}@${version} 与本扩展并存：两者命令 id 完全相同，只能保留一个`)

  const uninstall = i18n.t('legacy_conflict.uninstall')
  const later = i18n.t('legacy_conflict.later')
  const choice = await window.showWarningMessage(
    i18n.t('legacy_conflict.message', [version]),
    uninstall,
    later,
  )

  if (choice === uninstall) {
    try {
      // 内置命令，不必去猜编辑器 CLI 的路径；卸载后必须重载窗口才会解除命令占用
      await commands.executeCommand('workbench.extensions.uninstallExtension', LEGACY_ID)
      Log.info(`已提交卸载 ${LEGACY_ID}，重载窗口`)
      await commands.executeCommand('workbench.action.reloadWindow')
    }
    catch (e) {
      const msg = (e as Error).message
      Log.error(`卸载旧版失败: ${msg}`)
      // 兜底：至少把用户送到扩展页，能自己点卸载
      try {
        await commands.executeCommand('workbench.extensions.search', `@id:${LEGACY_ID}`)
      }
      catch { /* 命令不存在就算了，上面的日志已经说清 */ }
      void window.showErrorMessage(i18n.t('legacy_conflict.failed', [msg]))
    }
  }
  else {
    Log.warn('用户选择稍后处理，本次不激活（避免命令重复注册导致半激活）')
  }

  return true
}
