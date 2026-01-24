import { is, platform } from '@electron-toolkit/utils'
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  // nativeTheme,
  screen,
  Tray
} from 'electron'
import path from 'path'
// import trayIconLight from '../../../resources/icons/trayTemplate@2x-light.png?asset'
import trayIcon from '../../../resources/icons/trayTemplate@2x.png?asset'
import windowsIcon from '../../../resources/icons/windows-icon.png?asset'

import api from '../api'
import databaseAPI from '../api/shared/database'
import clipboardManager from './clipboardManager'

import { WINDOW_INITIAL_HEIGHT, WINDOW_DEFAULT_HEIGHT, WINDOW_WIDTH } from '../common/constants'
import detachedWindowManager from '../core/detachedWindowManager'
import { applyWindowMaterial, getDefaultWindowMaterial } from '../utils/windowUtils'
import pluginManager from './pluginManager'

// 窗口材质类型
type WindowMaterial = 'mica' | 'acrylic' | 'none'

/**
 * 窗口管理器
 * 负责主窗口的创建、显示/隐藏、快捷键注册等
 */
class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private tray: Tray | null = null
  private trayMenu: Menu | null = null // 托盘菜单
  private currentShortcut = 'Option+Z' // 当前注册的快捷键
  private isQuitting = false // 是否正在退出应用
  private previousActiveWindow: {
    appName: string
    bundleId: string
    processId: number
    timestamp: number
  } | null = null // 打开应用前激活的窗口
  // private _shouldRestoreFocus = true // TODO: 是否在隐藏窗口时恢复焦点（待实现）
  private windowPositionsByDisplay: Record<number, { x: number; y: number }> = {}
  private autoBackToSearchTimer: NodeJS.Timeout | null = null // 自动返回搜索定时器
  private autoBackToSearchConfig: string = 'never' // 自动返回搜索配置
  private lastFocusTarget: 'mainWindow' | 'plugin' | null = null // 窗口隐藏前的焦点状态
  private isPluginMode: boolean = false // 是否处于插件模式
  private saveWindowWidthTimer: NodeJS.Timeout | null = null // 保存窗口宽度的防抖定时器

  /**
   * 切换到搜索模式（只允许调整宽度）
   */
  public setSearchMode(): void {
    this.isPluginMode = false
    console.log('已切换到搜索模式：只允许调整宽度')
  }

  /**
   * 切换到插件模式（允许调整宽度和高度）
   */
  public setPluginMode(): void {
    this.isPluginMode = true
    console.log('已切换到插件模式：允许调整宽度和高度')
  }

  /**
   * 通知渲染进程返回搜索页面
   * 同时切换窗口调整大小模式为搜索模式（只允许调整宽度）
   */
  public notifyBackToSearch(): void {
    this.setSearchMode()
    this.mainWindow?.webContents.send('back-to-search')
  }

  /**
   * 获取鼠标所在显示器的工作区尺寸和位置
   */
  private getDisplayAtCursor(): {
    width: number
    height: number
    x: number
    y: number
    id: number
  } {
    const cursorPoint = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursorPoint)
    return {
      ...display.workArea,
      id: display.id
    }
  }

  /**
   * 获取当前显示器 ID（基于窗口位置）
   */
  public getCurrentDisplayId(): number | null {
    if (!this.mainWindow) return null
    const [x, y] = this.mainWindow.getPosition()
    const display = screen.getDisplayNearestPoint({ x, y })
    return display.id
  }

  /**
   * 创建主窗口
   */
  public async createWindow(): Promise<BrowserWindow> {
    // 智能检测：在鼠标所在的显示器上打开窗口
    const { width, height, x: displayX, y: displayY } = this.getDisplayAtCursor()

    // 从数据库读取保存的窗口宽度
    const savedWidth = await this.getWindowWidthFromSettings()
    const windowWidth = savedWidth || WINDOW_WIDTH
    console.log('创建窗口 - 读取到的保存宽度:', savedWidth, '使用的宽度:', windowWidth)

    // 根据平台设置不同的窗口配置
    const windowConfig: Electron.BrowserWindowConstructorOptions = {
      type: 'panel',
      title: 'ZTools',
      width: windowWidth,
      height: WINDOW_INITIAL_HEIGHT,
      alwaysOnTop: true,
      // 基于最大窗口高度计算居中位置，确保窗口扩展时不会超出屏幕
      x: displayX + Math.floor((width - windowWidth) / 2),
      y: displayY + Math.floor((height - WINDOW_DEFAULT_HEIGHT) / 2),
      frame: false, // 无边框
      resizable: true, // 允许用户手动调整窗口大小
      maximizable: false, // 禁用最大化
      skipTaskbar: true,
      show: false,
      hasShadow: true, // 启用窗口阴影（可调整为 false 来移除阴影）
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        backgroundThrottling: false, // 窗口最小化时是否继续动画和定时器
        contextIsolation: true, // 禁用上下文隔离, 渲染进程和preload共用window对象
        nodeIntegration: false, // 渲染进程禁止直接使用 Node
        spellcheck: false, // 禁用拼写检查
        webSecurity: false
      }
    }

    // macOS 系统配置
    if (platform.isMacOS) {
      windowConfig.transparent = true
      windowConfig.vibrancy = 'fullscreen-ui'
    }
    // Windows 系统配置（不设置 transparent，让 setBackgroundMaterial 生效）
    else if (platform.isWindows) {
      windowConfig.backgroundColor = '#00000000'
    }

    this.mainWindow = new BrowserWindow(windowConfig)

    // 设置初始模式为搜索模式
    this.setSearchMode()

    // 监听窗口尺寸调整事件，动态控制可调整的维度
    this.mainWindow.on('will-resize', (event, newBounds) => {
      if (!this.mainWindow) return

      const currentBounds = this.mainWindow.getBounds()

      // 统一的宽度限制
      const minWidth = 700
      const maxWidth = 1200

      if (!this.isPluginMode) {
        // 搜索模式：只允许调整宽度，高度保持不变
        let adjustedWidth = newBounds.width

        // 限制宽度范围
        if (newBounds.width < minWidth) adjustedWidth = minWidth
        if (newBounds.width > maxWidth) adjustedWidth = maxWidth

        // 如果高度变化或宽度需要调整，阻止并修正
        if (newBounds.height !== currentBounds.height || adjustedWidth !== newBounds.width) {
          event.preventDefault()
          this.mainWindow.setBounds({
            x: newBounds.x,
            y: currentBounds.y,
            width: adjustedWidth,
            height: currentBounds.height
          })
        }

        // 如果宽度发生变化，保存到数据库（防抖）
        if (adjustedWidth !== currentBounds.width) {
          this.debounceSaveWindowWidth(adjustedWidth)
        }
      } else {
        // 插件模式：允许调整宽度和高度
        const minHeight = 200

        let adjustedWidth = newBounds.width
        let adjustedHeight = newBounds.height

        // 限制宽度范围
        if (newBounds.width < minWidth) adjustedWidth = minWidth
        if (newBounds.width > maxWidth) adjustedWidth = maxWidth

        // 限制高度范围
        if (newBounds.height < minHeight) adjustedHeight = minHeight

        // 检查是否需要调整尺寸或位置
        if (
          adjustedWidth !== newBounds.width ||
          adjustedHeight !== newBounds.height ||
          newBounds.y !== currentBounds.y
        ) {
          event.preventDefault()
          // 保持窗口顶部位置不变（y 坐标），只向下扩展
          this.mainWindow.setBounds({
            x: newBounds.x,
            y: currentBounds.y, // 使用当前 y 坐标，保持顶部位置不变
            width: adjustedWidth,
            height: adjustedHeight
          })
        }

        // 如果宽度发生变化，保存到数据库（防抖）
        if (adjustedWidth !== currentBounds.width) {
          this.debounceSaveWindowWidth(adjustedWidth)
        }
      }
    })

    // Windows 11 根据用户配置设置背景材质
    if (platform.isWindows) {
      this.applyWindowMaterialFromSettings()
    }

    // 禁用缩放功能
    this.mainWindow.webContents.setZoomFactor(1.0) // 重置缩放为 100%
    this.mainWindow.webContents.setVisualZoomLevelLimits(1, 1) // 禁用未来缩放

    // 拦截缩放快捷键 (Ctrl+Plus, Ctrl+Minus, Ctrl+0, Ctrl+Wheel)
    this.mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.control || input.meta) {
        // 拦截 Ctrl/Cmd + Plus/Minus/0
        if (
          input.key === '=' ||
          input.key === '+' ||
          input.key === '-' ||
          input.key === '_' ||
          input.key === '0'
        ) {
          event.preventDefault()
        }
      }
    })

    // 加载页面
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      console.log('生产模式下加载文件:', path.join(__dirname, '../renderer/index.html'))
      this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
    }

    // 等待页面加载完成后再处理错误
    this.mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('页面加载失败:', errorCode, errorDescription)
    })

    this.mainWindow.webContents.on('did-finish-load', () => {
      console.log('页面加载成功!')
    })

    this.mainWindow.on('blur', () => {
      this.hideWindow(false)
    })

    this.mainWindow.on('show', () => {
      // 恢复上次的焦点状态
      // 如果明确记录了上次聚焦在主窗口，则强制聚焦主窗口
      if (this.lastFocusTarget === 'mainWindow') {
        this.mainWindow?.webContents.focus()
        // 通知渲染进程聚焦搜索框
        this.mainWindow?.webContents.send('focus-search')
      } else if (pluginManager.getCurrentPluginPath() !== null) {
        // 如果有插件在显示（且上次不是主窗口），聚焦插件
        pluginManager.focusPluginView()
      } else {
        // 否则聚焦主窗口
        this.mainWindow?.webContents.focus()
        // 通知渲染进程聚焦搜索框
        this.mainWindow?.webContents.send('focus-search')
      }
    })

    // 监听窗口大小变化
    this.mainWindow.on('resize', () => {
      if (this.mainWindow) {
        const [width, height] = this.mainWindow.getSize()
        // 如果当前有插件正在显示，同步更新插件视图大小
        if (pluginManager.getCurrentPluginPath()) {
          pluginManager.updatePluginViewBounds(width, height)
        }
      }
    })

    // 阻止窗口被销毁（Command+W 时隐藏而不是关闭）
    this.mainWindow.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault()

        // 若当前处于插件页面，先退出插件回到主搜索框
        if (pluginManager.getCurrentPluginPath() !== null) {
          pluginManager.handlePluginEsc()
          return
        }

        // 如果刚刚（100ms 内）触发过插件 ESC，则不再执行 mainWindow.hide，
        // 避免快速连续操作导致窗口被错误隐藏
        if (pluginManager.shouldSuppressMainHide()) {
          console.log('检测到短时间内插件 ESC，跳过 mainWindow.hide')
          return
        }

        this.mainWindow?.hide()
      }
    })
    // clipboardManager.setWindowFloating(this.mainWindow.getNativeWindowHandle())

    return this.mainWindow
  }

  /**
   * 创建系统托盘
   */
  public createTray(): void {
    // 创建托盘图标
    let icon: Electron.NativeImage

    if (platform.isMacOS) {
      // macOS 使用 Template 模式的图标（会自动适配明暗主题）
      // 使用 dark 版本作为模板图标
      icon = nativeImage.createFromPath(trayIcon)
      // 设置为模板图标（适配明暗模式）
      icon.setTemplateImage(true)
    } else {
      // Windows/Linux - 根据系统主题选择图标
      // 暗色模式用 light（白色图标），亮色模式用 dark（黑色图标）
      // const iconPath = nativeTheme.shouldUseDarkColors ? trayIconLight : trayIcon
      icon = nativeImage.createFromPath(windowsIcon)
      icon.setTemplateImage(false)
    }

    this.tray = new Tray(icon)

    // 设置托盘提示文字
    this.tray.setToolTip('ZTools')

    // 创建右键菜单
    this.createTrayMenu()

    // 左键点击：切换窗口显示
    this.tray.on('click', () => {
      this.toggleWindow()
    })

    // 右键点击：显示菜单
    this.tray.on('right-click', () => {
      if (this.tray && this.trayMenu) {
        this.tray.popUpContextMenu(this.trayMenu)
      }
    })
  }

  /**
   * 创建托盘菜单
   */
  private createTrayMenu(): void {
    if (!this.tray) return

    this.trayMenu = Menu.buildFromTemplate([
      {
        label: '显示/隐藏',
        click: () => {
          this.toggleWindow()
        }
      },
      {
        type: 'separator'
      },
      {
        label: '设置',
        click: () => {
          this.showSettings()
        }
      },
      {
        type: 'separator'
      },
      {
        label: '重启',
        click: () => {
          this.isQuitting = true
          app.relaunch()
          app.quit()
        }
      },
      {
        label: '退出',
        click: () => {
          this.isQuitting = true
          app.quit()
        }
      }
    ])
  }

  /**
   * 获取主窗口实例
   */
  public getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  /**
   * 注册全局快捷键
   */
  public registerShortcut(shortcut?: string): boolean {
    // 先注销旧的快捷键
    globalShortcut.unregisterAll()

    const keyToRegister = shortcut || this.currentShortcut

    const ret = globalShortcut.register(keyToRegister, () => {
      this.toggleWindow()
    })

    if (!ret) {
      console.error(`快捷键注册失败: ${keyToRegister} 已被占用`)
      return false
    } else {
      this.currentShortcut = keyToRegister
      console.log(`快捷键 ${keyToRegister} 注册成功`)
      return true
    }
  }

  public refreshPreviousActiveWindow(): void {
    this.previousActiveWindow = clipboardManager.getCurrentWindow()
  }

  /**
   * 记录当前的焦点状态（在隐藏之前调用）
   */
  private recordFocusState(): void {
    if (pluginManager.getCurrentPluginPath() !== null) {
      // 检查插件视图是否有焦点
      const pluginView = pluginManager.getCurrentPluginView()
      if (pluginView && pluginView.webContents && pluginView.webContents.isFocused()) {
        this.lastFocusTarget = 'plugin'
      } else {
        this.lastFocusTarget = 'mainWindow'
      }
    } else {
      this.lastFocusTarget = 'mainWindow'
    }

    console.log('记录焦点状态:', this.lastFocusTarget)
  }

  /**
   * 切换窗口显示/隐藏
   */
  private toggleWindow(): void {
    if (!this.mainWindow) return

    const isFocused = this.mainWindow.isFocused()
    const isVisible = this.mainWindow.isVisible()
    console.log(`切换窗口状态 - 聚焦: ${isFocused}, 可见: ${isVisible}`)

    // 判断窗口是否聚焦显示
    // 修复：同时检查聚焦和可见状态，避免alert弹窗后判断错误
    if (isFocused && isVisible) {
      // 窗口已显示且聚焦 → 隐藏
      console.log('隐藏窗口')

      // 记录当前的焦点状态（在隐藏之前）
      this.recordFocusState()

      this.mainWindow.blur()
      this.mainWindow.hide()
      this.restorePreviousWindow()
    } else {
      // 窗口已隐藏或失焦 → 显示并强制激活
      console.log('显示窗口')
      // 记录打开窗口前的激活窗口
      const currentWindow = clipboardManager.getCurrentWindow()
      if (currentWindow) {
        this.previousActiveWindow = currentWindow

        // 发送窗口信息到渲染进程
        this.mainWindow.webContents.send('window-info-changed', currentWindow)
      }

      // 移动到鼠标所在显示器（恢复该显示器记忆的位置或居中）
      this.moveWindowToCursor()

      // 强制激活窗口（修复alert弹窗后无法唤起的问题）
      this.forceActivateWindow()
    }
  }

  /**
   * 强制激活窗口（解决alert等弹窗后无法唤起的问题）
   */
  private forceActivateWindow(): void {
    if (!this.mainWindow) return

    // 1. 显示窗口
    this.mainWindow.show()

    // 2. macOS特殊处理：激活应用
    if (platform.isMacOS) {
      return
    }

    // 3. 设置窗口层级为最前
    this.mainWindow.setAlwaysOnTop(true)

    // 4. 聚焦窗口
    this.mainWindow.focus()

    // 5. 短暂延迟后恢复正常层级（避免一直置顶）
    setTimeout(() => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.setAlwaysOnTop(false)
      }
    }, 100)
  }

  /**
   * 保存窗口位置到指定显示器（仅内存）
   */
  public saveWindowPosition(displayId: number, x: number, y: number): void {
    this.windowPositionsByDisplay[displayId] = { x, y }
  }

  /**
   * 将窗口移动到鼠标所在显示器
   * 优先恢复该显示器记忆的位置，否则居中显示
   */
  private moveWindowToCursor(): void {
    if (!this.mainWindow) return

    const { width, height, x: displayX, y: displayY, id: displayId } = this.getDisplayAtCursor()

    const savedPosition = this.windowPositionsByDisplay[displayId]

    let x: number, y: number

    if (savedPosition) {
      // 恢复该显示器记忆的位置
      x = savedPosition.x
      y = savedPosition.y
    } else {
      // 计算默认居中位置（基于最大窗口高度和实际窗口宽度）
      const [windowWidth] = this.mainWindow.getSize()
      x = displayX + Math.floor((width - windowWidth) / 2)
      y = displayY + Math.floor((height - WINDOW_DEFAULT_HEIGHT) / 2)
    }

    this.mainWindow.setPosition(x, y, false)
  }

  /**
   * 显示窗口
   */
  public showWindow(): void {
    if (!this.mainWindow) return

    // 取消自动返回搜索定时器
    this.cancelAutoBackToSearchTimer()

    // 记录打开窗口前的激活窗口
    const currentWindow = clipboardManager.getCurrentWindow()
    if (currentWindow) {
      this.previousActiveWindow = currentWindow
      console.log('记录打开前的激活窗口:', currentWindow.appName)

      // 发送窗口信息到渲染进程
      this.mainWindow.webContents.send('window-info-changed', currentWindow)
    }

    // 移动到鼠标所在显示器（恢复该显示器记忆的位置或居中）
    this.moveWindowToCursor()

    // 使用强制激活逻辑
    this.forceActivateWindow()
  }

  /**
   * 隐藏窗口
   */
  public hideWindow(_restoreFocus: boolean = true): void {
    console.log('隐藏窗口', _restoreFocus)

    // 记录当前的焦点状态（在隐藏之前）
    this.recordFocusState()

    this.mainWindow?.hide()
    if (_restoreFocus) {
      this.restorePreviousWindow()
    }

    // 启动自动返回搜索定时器
    this.startAutoBackToSearchTimer()
  }

  /**
   * 启动自动返回搜索定时器
   */
  private startAutoBackToSearchTimer(): void {
    // 清除之前的定时器
    if (this.autoBackToSearchTimer) {
      clearTimeout(this.autoBackToSearchTimer)
      this.autoBackToSearchTimer = null
    }

    // 如果配置为"从不"，不启动定时器
    if (this.autoBackToSearchConfig === 'never') {
      return
    }

    // 获取延时时间（毫秒）
    const delay = this.getAutoBackToSearchDelay()
    if (delay === 0) {
      // 立即返回搜索
      this.backToSearch()
      return
    }

    // 启动定时器
    this.autoBackToSearchTimer = setTimeout(() => {
      this.backToSearch()
      this.autoBackToSearchTimer = null
    }, delay)

    console.log(`自动返回搜索定时器已启动，延时: ${delay}ms`)
  }

  /**
   * 取消自动返回搜索定时器
   */
  private cancelAutoBackToSearchTimer(): void {
    if (this.autoBackToSearchTimer) {
      clearTimeout(this.autoBackToSearchTimer)
      this.autoBackToSearchTimer = null
      console.log('自动返回搜索定时器已取消')
    }
  }

  /**
   * 返回搜索界面
   */
  private backToSearch(): void {
    if (!this.mainWindow) return

    pluginManager.hidePluginView()
    // 通知渲染进程返回搜索并切换模式
    this.notifyBackToSearch()
    console.log('已触发自动返回搜索')
  }

  /**
   * 获取自动返回搜索的延时时间（毫秒）
   */
  private getAutoBackToSearchDelay(): number {
    switch (this.autoBackToSearchConfig) {
      case 'immediately':
        return 0
      case '30s':
        return 30 * 1000
      case '1m':
        return 60 * 1000
      case '3m':
        return 3 * 60 * 1000
      case '5m':
        return 5 * 60 * 1000
      case '10m':
        return 10 * 60 * 1000
      case 'never':
      default:
        return -1 // 不启动定时器
    }
  }

  /**
   * 更新自动返回搜索配置
   */
  public async updateAutoBackToSearch(config: string): Promise<void> {
    this.autoBackToSearchConfig = config
    console.log('更新自动返回搜索配置:', config)
  }

  /**
   * 获取打开窗口前激活的窗口
   */
  public getPreviousActiveWindow(): {
    appName: string
    bundleId: string
    processId: number
    timestamp: number
  } | null {
    return this.previousActiveWindow
  }

  /**
   * 恢复之前激活的窗口
   */
  public async restorePreviousWindow(): Promise<boolean> {
    if (!this.previousActiveWindow) {
      console.log('没有记录的前一个激活窗口')
      return false
    }

    // 忽略同类启动器工具，避免激活冲突
    const ignoredApps = ['uTools', 'Alfred', 'Raycast', 'Wox', 'Listary']
    if (ignoredApps.includes(this.previousActiveWindow.appName)) {
      console.log(`跳过恢复同类工具: ${this.previousActiveWindow.appName}`)
      return false
    }

    try {
      const success = clipboardManager.activateApp(this.previousActiveWindow)
      if (success) {
        console.log(`已恢复激活窗口: ${this.previousActiveWindow.appName}`)
        return true
      } else {
        // 静默失败，不报错（可能进程已关闭或窗口已销毁）
        console.log(`无法恢复窗口: ${this.previousActiveWindow.appName}`)
        return false
      }
    } catch (error) {
      console.log('恢复激活窗口时出现异常:', error)
      return false
    }
  }

  /**
   * 获取当前快捷键
   */
  public getCurrentShortcut(): string {
    return this.currentShortcut
  }

  /**
   * 注销所有快捷键
   */
  public unregisterAllShortcuts(): void {
    globalShortcut.unregisterAll()
  }

  /**
   * 设置退出标志（允许窗口真正关闭）
   */
  public setQuitting(value: boolean): void {
    this.isQuitting = value
  }

  /**
   * 获取退出标志
   */
  public getQuitting(): boolean {
    return this.isQuitting
  }

  /**
   * 设置托盘图标可见性
   */
  public setTrayIconVisible(visible: boolean): void {
    if (visible) {
      if (!this.tray) {
        this.createTray()
      }
    } else {
      if (this.tray) {
        this.tray.destroy()
        this.tray = null
        this.trayMenu = null
      }
    }
  }

  /**
   * 广播窗口材质到所有渲染进程（包括分离窗口和插件）
   */
  private broadcastWindowMaterial(material: WindowMaterial): void {
    // 发送给主窗口
    this.mainWindow?.webContents.send('update-window-material', material)

    // 发送给所有分离窗口
    detachedWindowManager.updateAllWindowsMaterial(material)
  }

  /**
   * 应用窗口材质
   */
  private applyMaterial(material: WindowMaterial): void {
    if (!this.mainWindow) return
    applyWindowMaterial(this.mainWindow, material)
  }

  /**
   * 从设置中应用窗口材质（启动时调用）
   */
  private async applyWindowMaterialFromSettings(): Promise<void> {
    try {
      const settings = await databaseAPI.dbGet('settings-general')
      const savedMaterial = settings?.windowMaterial as WindowMaterial | undefined
      const material = savedMaterial || getDefaultWindowMaterial()

      console.log('从配置读取窗口材质:', material)

      // 如果数据库中没有保存材质配置，保存默认值
      if (!savedMaterial) {
        console.log('数据库中没有窗口材质配置，保存默认值:', material)
        const updatedSettings = {
          ...(settings || {}),
          windowMaterial: material
        }
        await databaseAPI.dbPut('settings-general', updatedSettings)
      }

      this.applyMaterial(material)
    } catch (error) {
      console.error('读取窗口材质配置失败，使用默认值:', error)
      const defaultMaterial = getDefaultWindowMaterial()
      this.applyMaterial(defaultMaterial)
    }
  }

  /**
   * 设置窗口材质（用户在设置中更改时调用）
   */
  public setWindowMaterial(material: WindowMaterial): { success: boolean } {
    if (!this.mainWindow || !platform.isWindows) {
      return { success: false }
    }

    this.applyMaterial(material)
    this.broadcastWindowMaterial(material)

    return { success: true }
  }

  /**
   * 获取当前窗口材质
   */
  public async getWindowMaterial(): Promise<WindowMaterial> {
    try {
      const settings = await databaseAPI.dbGet('settings-general')
      return (settings?.windowMaterial as WindowMaterial) || getDefaultWindowMaterial()
    } catch (error) {
      console.error('获取窗口材质失败:', error)
      return getDefaultWindowMaterial()
    }
  }

  /**
   * 从数据库获取保存的窗口宽度
   */
  private async getWindowWidthFromSettings(): Promise<number | null> {
    try {
      const settings = await databaseAPI.dbGet('settings-general')
      const windowWidth = settings?.windowWidth as number | null
      console.log('从数据库读取窗口宽度 - settings:', settings, 'windowWidth:', windowWidth)
      return windowWidth
    } catch (error) {
      console.error('读取窗口宽度配置失败:', error)
      return null
    }
  }

  /**
   * 保存窗口宽度到数据库（带防抖）
   */
  private debounceSaveWindowWidth(width: number): void {
    // 清除之前的定时器
    if (this.saveWindowWidthTimer) {
      clearTimeout(this.saveWindowWidthTimer)
    }

    // 设置新的定时器，500ms 后保存
    this.saveWindowWidthTimer = setTimeout(async () => {
      await this.saveWindowWidth(width)
      this.saveWindowWidthTimer = null
    }, 500)
  }

  /**
   * 保存窗口宽度到数据库
   */
  private async saveWindowWidth(width: number): Promise<void> {
    try {
      const settings = await databaseAPI.dbGet('settings-general')
      const updatedSettings = {
        ...(settings || {}),
        windowWidth: width
      }
      await databaseAPI.dbPut('settings-general', updatedSettings)
      console.log('窗口宽度已保存到数据库:', width)
    } catch (error) {
      console.error('保存窗口宽度失败:', error)
    }
  }

  /**
   * 显示设置页面
   */
  public async showSettings(): Promise<void> {
    if (!this.mainWindow) return

    // 如果当前有插件在显示，先隐藏插件
    if (pluginManager.getCurrentPluginPath() !== null) {
      console.log('检测到插件正在显示，先隐藏插件')
      pluginManager.hidePluginView()
      // 通知渲染进程返回搜索页面
      this.notifyBackToSearch()
    }

    // 记录打开窗口前的激活窗口
    const currentWindow = clipboardManager.getCurrentWindow()
    if (currentWindow) {
      this.previousActiveWindow = currentWindow
      console.log('记录打开前的激活窗口:', currentWindow.appName)

      // 发送窗口信息到渲染进程
      this.mainWindow.webContents.send('window-info-changed', currentWindow)
    }

    // 从数据库查找设置插件
    try {
      const plugins: any = await api.dbGet('plugins')
      if (!plugins || !Array.isArray(plugins)) {
        console.error('未找到插件列表')
        return
      }

      const settingPlugin = plugins.find((p: any) => p.name === 'setting')
      if (!settingPlugin) {
        console.error('未找到设置插件')
        return
      }

      console.log('找到设置插件:', settingPlugin.path)

      // 使用统一的 launch 方法启动设置插件
      const result = await api.launchPlugin({
        path: settingPlugin.path,
        type: 'plugin',
        featureCode: 'main',
        name: '设置'
      })

      if (!result.success) {
        console.error('启动设置插件失败:', result.error)
        return
      }

      // 智能定位：将窗口移动到鼠标所在的显示器（同步，从内存读取）
      this.moveWindowToCursor()
      // 使用强制激活逻辑显示窗口
      this.forceActivateWindow()
    } catch (error) {
      console.error('打开设置插件失败:', error)
    }
  }
}

// 导出单例
export default new WindowManager()
