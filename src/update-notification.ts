import { ExtensionContext, window, Uri, env } from 'vscode'
import semver from 'semver'
import { version } from '../package.json'
import { openChangelog } from './core/Changelog'
import i18n from './i18n'

interface Notification {
  id: string
  condition: string
  message: string
  buttons: {
    text: string
    url: string
  }[]
}

/**
 * 安装 / 升级后的变更声明。
 *
 * 只在「记录的版本 ≠ 当前 bundle 里的版本」时弹一次：globalState 是扩展级的（跨工作区共享），
 * 所以升级后只有第一个激活的窗口会看到，之后不再打扰。
 * 首次安装同样给一次入口 —— 新用户正是最需要知道「这版有什么」的时候。
 *
 * `version` 是编译期从 package.json 写进 bundle 的（见 ReloadOnUpdate），
 * 所以热替换换了代码也会带来新的版本值，这正是预期的触发点。
 */
function showReleaseNotes(ctx: ExtensionContext, previousVersion: string) {
  if (previousVersion === version)
    return

  const firstInstall = previousVersion === '0.0.0'
  const message = firstInstall
    ? i18n.t('prompt.release_notes_installed', version)
    : i18n.t('prompt.release_notes_updated', previousVersion, version)

  void window.showInformationMessage(message, i18n.t('prompt.release_notes_view'))
    .then((picked) => {
      if (picked)
        void openChangelog(ctx)
    })
}

export function checkNotification(ctx: ExtensionContext) {
  const notifications: Notification[] = []

  const previousVersion = ctx.globalState.get<string>('version') || '0.0.0'
  const notificationIds = (ctx.globalState.get<string>('notifications-ids') || '').split(',')

  showReleaseNotes(ctx, previousVersion)

  for (const notification of notifications) {
    if (notificationIds.includes(notification.id))
      continue

    if (semver.satisfies(previousVersion, notification.condition)) {
      notificationIds.push(notification.id)
      const buttonNames = notification.buttons.map(b => b.text)
      window.showInformationMessage(notification.message, ...buttonNames)
        .then((result) => {
          const button = notification.buttons.find(i => i.text === result)
          if (button)
            env.openExternal(Uri.parse(button.url))
        })
    }
  }

  ctx.globalState.update('notifications-ids', notificationIds.join(','))
  ctx.globalState.update('version', version)
}

export function clearNotificationState(ctx: ExtensionContext) {
  ctx.globalState.update('notifications-ids', undefined)
  ctx.globalState.update('version', undefined)
}
