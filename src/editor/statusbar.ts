import { window, Disposable, StatusBarAlignment } from 'vscode'
import { Commands } from '../commands/commands'
import { ExtensionModule } from '~/modules'
import { Config, Global, CurrentFile } from '~/core'
import { resolveProjectLocale } from '~/utils/projectLocale'
import i18n from '~/i18n'

const statusbar: ExtensionModule = () => {
  const disposables: Disposable[] = []
  const priority = -1000
  const bar1 = window.createStatusBarItem(StatusBarAlignment.Right, priority + 1)
  const bar2 = window.createStatusBarItem(StatusBarAlignment.Right, priority)
  function update() {
    if (!Global.enabled) {
      bar1.hide()
      bar2.hide()
      return
    }
    try {
      // 显示的是「本项目实际在用的语言文件」，而不是设置里那个可能对不上的标识：
      // 设置写 zh-cn、项目里叫 chs.json 时，状态栏显示 CHS，并给出原设置的说明。
      const locales = CurrentFile.loader.locales || []
      const source = resolveProjectLocale(Config.sourceLanguage, locales, [Config.displayLanguage])
      const displayRaw = Config.displayLanguage
      const display = displayRaw
        ? resolveProjectLocale(displayRaw, locales, [source.locale])
        : { locale: '', changed: false }

      bar1.text = `$(globe) ${(source.locale || Config.sourceLanguage).toUpperCase()}`
      bar1.command = Commands.config_source_language
      bar1.tooltip = source.changed
        ? `源语言：设置里是 ${source.configured}，当前项目实际使用 ${source.locale}（项目里没有 ${source.configured} 对应的文件）\n${i18n.t('command.config_source_language')}`
        : i18n.t('command.config_source_language')
      bar1.show()

      bar2.text = `$(eye) ${(display.locale || displayRaw).toUpperCase()}`
      bar2.command = Commands.config_display_language
      bar2.tooltip = display.changed
        ? `默认显示语言：设置里是 ${displayRaw}，当前项目实际使用 ${display.locale}\n${i18n.t('command.config_display_language')}`
        : i18n.t('command.config_display_language')
      bar2.show()
    }
    catch (e) {
      bar1.hide()
      bar2.hide()
    }
  }

  disposables.push(CurrentFile.loader.onDidChange(() => update()))

  update()

  return disposables
}

export default statusbar
