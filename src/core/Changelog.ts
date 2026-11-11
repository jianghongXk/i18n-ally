import { ExtensionContext, Uri, commands } from 'vscode'

/** 随扩展一起分发的变更日志（`.vscodeignore` 未排除，pack 脚本会把 .md 打进包） */
export function changelogUri(ctx: ExtensionContext) {
  return Uri.joinPath(ctx.extensionUri, 'CHANGELOG.md')
}

/** 打开变更日志预览；编辑器没有 markdown 预览能力时退回按普通文本打开 */
export async function openChangelog(ctx: ExtensionContext) {
  const uri = changelogUri(ctx)
  try {
    await commands.executeCommand('markdown.showPreview', uri)
  }
  catch {
    await commands.executeCommand('vscode.open', uri)
  }
}
