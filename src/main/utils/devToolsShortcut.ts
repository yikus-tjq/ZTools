import { globalShortcut } from 'electron'
import { platform } from '@electron-toolkit/utils'

/**
 * 开发者工具快捷键管理器
 * 用于确保 DevTools 快捷键 (Option+Command+I / Ctrl+Shift+I) 只在相关窗口聚焦时生效，
 * 并且只针对当前聚焦的 webContents 打开。
 */
class DevToolsShortcutManager {
  private currentTarget: Electron.WebContents | null = null
  private readonly shortcut = platform.isMacOS ? 'Option+Command+I' : 'Ctrl+Shift+I'

  /**
   * 注册当前焦点的 DevTools 快捷键
   * @param target 需要打开开发者工具的 WebContents
   */
  public register(target: Electron.WebContents): void {
    // 如果已经注册且目标相同，无需重复注册
    if (this.currentTarget?.id === target.id && globalShortcut.isRegistered(this.shortcut)) {
      return
    }

    // 先注销可能存在的旧注册
    this.unregister()

    this.currentTarget = target

    // 注册全局快捷键
    const ret = globalShortcut.register(this.shortcut, () => {
      if (this.currentTarget && !this.currentTarget.isDestroyed()) {
        console.log(`触发开发者工具快捷键，目标: ${this.currentTarget.id}`)
        if (this.currentTarget.isDevToolsOpened()) {
          this.currentTarget.closeDevTools()
        } else {
          this.currentTarget.openDevTools({ mode: 'detach' })
        }
      }
    })

    if (ret) {
      console.log(`开发者工具快捷键注册成功，目标: ${target.id}`)
    } else {
      console.error(`开发者工具快捷键注册失败: ${this.shortcut}`)
    }
  }

  /**
   * 注销快捷键
   */
  public unregister(): void {
    if (globalShortcut.isRegistered(this.shortcut)) {
      globalShortcut.unregister(this.shortcut)
      console.log('开发者工具快捷键已注销')
    }
    this.currentTarget = null
  }
}

export default new DevToolsShortcutManager()
