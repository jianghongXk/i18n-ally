import { window } from 'vscode'
import { overrideConfirm } from '../overrideConfirm'
import { keypathValidate, Log, promptEdit } from '~/utils'
import { resolveProjectLocale } from '~/utils/projectLocale'
import i18n from '~/i18n'
import { CurrentFile, Config, Global, PendingWrite, Telemetry, TelemetryKey } from '~/core'

export async function NewKey(keypath?: string) {
  Telemetry.track(TelemetryKey.NewKey)

  try {
    keypath = await window.showInputBox({
      value: typeof keypath === 'string' ? keypath : '',
      prompt: i18n.t('prompt.new_key_path'),
      ignoreFocusOut: true,
    })

    if (!keypath)
      return

    if (!keypathValidate(keypath)) {
      window.showWarningMessage(i18n.t('prompt.invalid_keypath'))
      await NewKey(keypath)
      return
    }

    // 源语言要对齐到项目里真实存在的语言文件（配置写 zh-cn，项目里可能是 chs.json）
    const sourceLocale = resolveProjectLocale(
      Config.sourceLanguage,
      CurrentFile.loader.locales,
      [Config.displayLanguage],
    ).locale

    keypath = CurrentFile.loader.rewriteKeys(keypath, 'write', { locale: sourceLocale })

    const shouldOverride = await overrideConfirm(keypath, false, true)

    if (shouldOverride === 'retry') {
      await NewKey(keypath)
      return
    }

    if (shouldOverride !== 'override')
      return

    const value = await promptEdit(keypath, sourceLocale, '')

    if (value === undefined)
      return

    if (Config.keepFulfilled) {
      await CurrentFile.loader.write(
        Global.allLocales.map(locale => ({
          value: sourceLocale === locale ? value : '',
          keypath,
          filepath: undefined,
          locale,
        } as PendingWrite)),
        false,
      )
    }
    else {
      await CurrentFile.loader.write({
        value,
        keypath,
        filepath: undefined,
        locale: sourceLocale,
      })
    }
  }
  catch (err: any) {
    Log.error(err.toString())
  }
}
