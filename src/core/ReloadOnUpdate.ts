import { ExtensionContext, Uri, commands, window, workspace } from 'vscode'
import { version as buildVersion } from '../../package.json'
import { Log } from '~/utils'

const REQUEST_FILE = '.reload-request'
const STATE_FILE = '.dev-state.json'

interface ReloadRequest {
  version?: string
  /** host = 已热替换代码，重启扩展宿主即可；silent = 只换了前端资源，无需重启；window = 清单有变化，需整窗重载 */
  mode?: 'host' | 'silent' | 'window'
  at?: number
}

/**
 * 安装新版本后的生效策略。
 *
 * 开发时由 Vite 插件（vsixAutoInstall）在装完新 vsix 后写 .vscePackage/.reload-request：
 *   - mode=host   ：插件已把新 bundle 拷进当前活动的扩展目录，重启扩展宿主即可加载新代码，
 *                   不重载窗口，因此不会丢撤销历史
 *   - mode=window ：package.json（命令/菜单/配置）有变化，宿主重启无效，需整窗重载，弹通知让用户决定
 *
 * 走文件信号是因为外部进程（dev server / CLI）无法直接调用 VS Code 的命令。
 */
export function registerReloadOnUpdate(ctx: ExtensionContext) {
  const currentVersion = (ctx.extension.packageJSON as { version?: string }).version

  // 告诉插件当前实际加载的版本与目录（热替换的锚点），写进共享状态文件的 active 区块
  void (async () => {
    const folder = workspace.workspaceFolders?.[0]?.uri
    if (!folder)
      return
    try {
      const dirUri = Uri.joinPath(folder, '.vscePackage')
      const uri = Uri.joinPath(dirUri, STATE_FILE)
      await workspace.fs.createDirectory(dirUri)

      // 与插件共用同一个文件，必须读-改-写，只动自己的区块
      let state: Record<string, unknown> = {}
      try {
        state = JSON.parse(Buffer.from(await workspace.fs.readFile(uri)).toString('utf8'))
      }
      catch {
        state = {}
      }
      state.active = {
        // version: 磁盘上 package.json 的版本（热替换后不会变）
        version: currentVersion,
        // buildVersion: 编译进 bundle 的版本，才是真正在跑的代码版本
        buildVersion,
        path: ctx.extensionPath,
        at: Date.now(),
      }
      await workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(state, null, 2), 'utf8'))
    }
    catch {
      // 只读工作区等情况忽略
    }
  })()

  const handle = async (uri: Uri) => {
    try {
      const raw = await workspace.fs.readFile(uri)
      const req: ReloadRequest = JSON.parse(Buffer.from(raw).toString('utf8'))
      const version = req.version
      const mode = req.mode || 'window'

      await workspace.fs.delete(uri).then(undefined, () => undefined)

      // 比较的是「正在跑的代码版本」(buildVersion)，manifest 的 version 在热替换模型下已经不再变化
      if (!version || version === buildVersion)
        return

      if (mode === 'silent') {
        Log.info(`🔄 webview 等前端资源已更新到 ${version}，无需重启`)
        return
      }

      if (mode === 'host') {
        Log.info(`🔄 检测到新代码 ${version}（当前 ${currentVersion}），正在重启扩展宿主`)
        void commands.executeCommand('workbench.action.restartExtensionHost').then(undefined, (e: Error) => {
          Log.warn(`[reload] 重启扩展宿主失败: ${e.message}`)
        })

        // 重启成功时本进程会被杀掉，这里的定时器不会执行。
        // 若 8 秒后还活着，说明被 veto（其它扩展开着自定义编辑器会弹确认框）
        // 或者命令没生效——此时必须告诉用户，否则他会以为已经更新了。
        setTimeout(() => {
          Log.warn('[reload] 扩展宿主未重启，更新尚未生效')
          void window.showWarningMessage(
            'i18n: 新版本已就绪，但扩展宿主没有自动重启（可能被其它扩展的确认框拦下）',
            '立即重启',
            '忽略',
          ).then((pick) => {
            if (pick === '立即重启')
              void commands.executeCommand('workbench.action.restartExtensionHost').then(undefined, () => {})
          })
        }, 8000)
        return
      }

      Log.info(`🔄 检测到新版本 ${version}（当前 ${currentVersion}），清单有变化，需要整窗重载`)
      const choice = await window.showInformationMessage(
        `i18n CN 已更新到 ${version}（涉及命令/菜单/配置变更，需重载窗口）`,
        '立即重载窗口',
        '稍后',
      )
      if (choice === '立即重载窗口')
        void commands.executeCommand('workbench.action.reloadWindow')
    }
    catch {
      // 文件被删除/半写入都忽略
    }
  }

  const watcher = workspace.createFileSystemWatcher(`**/.vscePackage/${REQUEST_FILE}`)
  watcher.onDidCreate(handle)
  watcher.onDidChange(handle)
  ctx.subscriptions.push(watcher)

  for (const folder of workspace.workspaceFolders ?? []) {
    const uri = Uri.joinPath(folder.uri, '.vscePackage', REQUEST_FILE)
    void workspace.fs.stat(uri).then(() => handle(uri), () => undefined)
  }
}
