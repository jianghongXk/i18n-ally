import { commands } from 'vscode'
import { Commands } from './commands'
import { openChangelog } from '~/core/Changelog'
import { ExtensionModule } from '~/modules'

const m: ExtensionModule = (ctx) => {
  return [
    commands.registerCommand(Commands.show_changelog, () => openChangelog(ctx)),
  ]
}

export default m
