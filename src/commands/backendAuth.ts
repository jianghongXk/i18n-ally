import { commands, window } from 'vscode'
import { Commands } from './commands'
import { promptAndSaveCreds, syncKeysToBackend } from '~/core/BizSync'
import { ExtensionModule } from '~/modules'

/** 手动设置 / 覆盖后端同步用的账号密码（加密后写入本地状态文件） */
async function SetBackendAuth() {
  const creds = await promptAndSaveCreds()
  if (!creds)
    window.showInformationMessage('已取消，凭据未修改')
}

/** 把当前文件用到的 key 手动同步到后端（不依赖提取）；没配后端时降级为直接翻译 */
async function SyncKeysToBackend() {
  const doc = window.activeTextEditor?.document
  if (!doc) {
    window.showWarningMessage('没有打开的文件')
    return
  }

  try {
    const result = await syncKeysToBackend([doc], { throwOnAuthError: true })
    if (!result)
      window.showInformationMessage('当前文件没有可同步的 $t 词条')
  }
  catch (e) {
    window.showErrorMessage(`后端同步失败：${(e as Error).message}`)
  }
}

const m: ExtensionModule = () => {
  return [
    commands.registerCommand(Commands.set_backend_auth, SetBackendAuth),
    commands.registerCommand(Commands.sync_keys_to_backend, SyncKeysToBackend),
  ]
}

export default m
