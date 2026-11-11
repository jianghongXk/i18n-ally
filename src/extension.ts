import { ExtensionContext } from 'vscode'
import { flatten } from 'lodash'
import { version } from '../package.json'
import { Global, Config, KeyDetector, CurrentFile } from '~/core'
import { registerReloadOnUpdate } from '~/core/ReloadOnUpdate'
import { guardLegacyExtension } from '~/core/LegacyConflict'
import { ensureBackendAuthConfigured } from '~/core/BizSync'
import commandsModules, { Commands } from '~/commands'
import { maybePromptSetup } from '~/commands/setupWizard'
import viewsModules from '~/views'
import { Log } from '~/utils'
import i18n from '~/i18n'
import editorModules from '~/editor'

export async function activate(ctx: ExtensionContext) {
  Log.info(`🈶 Activated, v${version}`)

  Config.ctx = ctx

  i18n.init(ctx.extensionPath)
  KeyDetector.init(ctx)

  // 旧版 lokalise.i18n-ally 仍在时，命令 id 会撞车（后者注册即抛错、activate 中断）。
  // 必须赶在 Global.init / 任何 registerCommand 之前拦，命中就不继续激活。
  if (await guardLegacyExtension())
    return

  // activate the extension
  await Global.init(ctx)
  CurrentFile.watch(ctx)
  registerReloadOnUpdate(ctx)

  // 开了后端同步却没配账号时，启动就问一次（不阻塞后续激活）
  void ensureBackendAuthConfigured()

  // 连语言文件目录都没配时，第一次激活提示一次初始化引导
  void maybePromptSetup(ctx)

  const modules = [
    commandsModules,
    editorModules,
    viewsModules,
  ]

  const disposables = flatten(modules.map(m => m(ctx)))
  disposables.forEach(d => ctx.subscriptions.push(d))
}

export function deactivate() {
  Log.info('🈚 Deactivated')
}

export {
  Global,
  CurrentFile,
  KeyDetector,
  Config,
  Log,
  Commands,
}
