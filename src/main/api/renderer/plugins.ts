import AdmZip from 'adm-zip'
import { app, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { normalizeIconPath } from '../../common/iconUtils'
import { isInternalPlugin } from '../../core/internalPlugins'
import lmdbInstance from '../../core/lmdb/lmdbInstance'
import { sleep } from '../../utils/common.js'
import { downloadFile } from '../../utils/download.js'
import { pluginFeatureAPI } from '../plugin/feature'
import databaseAPI from '../shared/database'

// 插件目录
const PLUGIN_DIR = path.join(app.getPath('userData'), 'plugins')

/**
 * 插件管理API - 主程序专用
 */
export class PluginsAPI {
  private mainWindow: Electron.BrowserWindow | null = null
  private pluginManager: any = null

  public init(mainWindow: Electron.BrowserWindow, pluginManager: any): void {
    this.mainWindow = mainWindow
    this.pluginManager = pluginManager
    this.setupIPC()
  }

  private setupIPC(): void {
    ipcMain.handle('get-plugins', () => this.getPlugins())
    ipcMain.handle('get-all-plugins', () => this.getAllPlugins())
    ipcMain.handle('import-plugin', () => this.importPlugin())
    ipcMain.handle('import-dev-plugin', () => this.importDevPlugin())
    ipcMain.handle('delete-plugin', (_event, pluginPath: string) => this.deletePlugin(pluginPath))
    ipcMain.handle('reload-plugin', (_event, pluginPath: string) => this.reloadPlugin(pluginPath))
    ipcMain.handle('get-running-plugins', () => this.getRunningPlugins())
    ipcMain.handle('kill-plugin', (_event, pluginPath: string) => this.killPlugin(pluginPath))
    ipcMain.handle('kill-plugin-and-return', (_event, pluginPath: string) =>
      this.killPluginAndReturn(pluginPath)
    )
    ipcMain.handle('fetch-plugin-market', () => this.fetchPluginMarket())
    ipcMain.handle('install-plugin-from-market', (_event, plugin: any) =>
      this.installPluginFromMarket(plugin)
    )
    ipcMain.handle('get-plugin-readme', (_event, pluginPathOrName: string, pluginName?: string) =>
      this.getPluginReadme(pluginPathOrName, pluginName)
    )
    ipcMain.handle('get-plugin-db-data', (_event, pluginName: string) =>
      this.getPluginDbData(pluginName)
    )
    ipcMain.handle(
      'call-headless-plugin',
      async (_event, pluginPath: string, featureCode: string, action: any) => {
        try {
          const result = await this.pluginManager.callHeadlessPluginMethod(
            pluginPath,
            featureCode,
            action
          )
          return { success: true, result }
        } catch (error: unknown) {
          console.error('调用无界面插件失败:', error)
          return { success: false, error: error instanceof Error ? error.message : '未知错误' }
        }
      }
    )
  }

  // 获取插件列表（过滤掉内置插件，用于插件中心显示）
  public async getPlugins(): Promise<any[]> {
    const allPlugins = await this.getAllPlugins()
    // 过滤掉所有内置插件（system、setting 等）
    return allPlugins.filter((plugin: any) => !isInternalPlugin(plugin.name))
  }

  // 获取所有插件列表（包括 system 插件，用于生成搜索指令）
  public async getAllPlugins(): Promise<any[]> {
    try {
      const data = await databaseAPI.dbGet('plugins')
      const plugins = data || []

      // 合并动态 features
      for (const plugin of plugins) {
        const dynamicFeatures = pluginFeatureAPI.loadDynamicFeatures(plugin.name)
        plugin.features = [...(plugin.features || []), ...dynamicFeatures]

        // 处理插件 logo 路径
        if (plugin.logo) {
          plugin.logo = normalizeIconPath(plugin.logo, plugin.path)
        }

        // 处理每个 feature 的 icon 路径
        if (plugin.features && Array.isArray(plugin.features)) {
          for (const feature of plugin.features) {
            if (feature.icon) {
              feature.icon = normalizeIconPath(feature.icon, plugin.path)
            }
          }
        }
      }

      return plugins
    } catch (error) {
      console.error('获取插件列表失败:', error)
      return []
    }
  }

  // 导入ZIP插件
  private async importPlugin(): Promise<any> {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow!, {
        title: '选择插件文件',
        filters: [{ name: '插件文件', extensions: ['zip'] }],
        properties: ['openFile']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: '未选择文件' }
      }

      const zipPath = result.filePaths[0]
      return await this._installPluginFromZip(zipPath)
    } catch (error: unknown) {
      console.error('导入插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 从ZIP安装插件（核心逻辑）
  private async _installPluginFromZip(zipPath: string): Promise<any> {
    await fs.mkdir(PLUGIN_DIR, { recursive: true })
    const tempDir = path.join(app.getPath('temp'), 'ztools-plugin-temp')
    await fs.mkdir(tempDir, { recursive: true })
    const tempExtractPath = path.join(tempDir, `plugin-${Date.now()}`)

    try {
      // 解压到临时目录
      const zip = new AdmZip(zipPath)
      zip.extractAllTo(tempExtractPath, true)

      // 校验plugin.json
      const pluginJsonPath = path.join(tempExtractPath, 'plugin.json')
      try {
        await fs.access(pluginJsonPath)
      } catch {
        await fs.rm(tempExtractPath, { recursive: true, force: true })
        return { success: false, error: 'plugin.json 文件不存在' }
      }

      // 读取配置
      const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8')
      let pluginConfig: any
      try {
        pluginConfig = JSON.parse(pluginJsonContent)
      } catch {
        await fs.rm(tempExtractPath, { recursive: true, force: true })
        return { success: false, error: 'plugin.json 格式错误' }
      }

      if (!pluginConfig.name) {
        await fs.rm(tempExtractPath, { recursive: true, force: true })
        return { success: false, error: 'plugin.json 缺少 name 字段' }
      }

      const pluginName = pluginConfig.name
      const pluginPath = path.join(PLUGIN_DIR, pluginName)

      // 检查是否已存在
      try {
        await fs.access(pluginPath)
        await fs.rm(tempExtractPath, { recursive: true, force: true })
        return { success: false, error: '插件目录已存在' }
      } catch {
        // 不存在，继续
      }

      const existingPlugins = await this.getPlugins()
      if (existingPlugins.some((p: any) => p.name === pluginName)) {
        await fs.rm(tempExtractPath, { recursive: true, force: true })
        return { success: false, error: '插件已存在' }
      }

      // 校验必填字段
      const requiredFields = ['name', 'version', 'features']
      for (const field of requiredFields) {
        if (!pluginConfig[field]) {
          await fs.rm(tempExtractPath, { recursive: true, force: true })
          return { success: false, error: `缺少必填字段: ${field}` }
        }
      }

      if (!Array.isArray(pluginConfig.features) || pluginConfig.features.length === 0) {
        await fs.rm(tempExtractPath, { recursive: true, force: true })
        return { success: false, error: 'features 必须是非空数组' }
      }

      for (const feature of pluginConfig.features) {
        if (!feature.code || !Array.isArray(feature.cmds)) {
          await fs.rm(tempExtractPath, { recursive: true, force: true })
          return { success: false, error: 'feature 缺少必填字段 (code, cmds)' }
        }
      }

      // 移动到最终目录
      await fs.rename(tempExtractPath, pluginPath)

      // 保存到数据库
      const pluginInfo = {
        name: pluginConfig.name,
        title: pluginConfig.title,
        version: pluginConfig.version,
        description: pluginConfig.description || '',
        logo: pluginConfig.logo ? pathToFileURL(path.join(pluginPath, pluginConfig.logo)).href : '',
        main: pluginConfig.main,
        preload: pluginConfig.preload,
        features: pluginConfig.features,
        path: pluginPath,
        isDevelopment: false,
        installedAt: new Date().toISOString()
      }

      let plugins: any = await databaseAPI.dbGet('plugins')
      if (!plugins) plugins = []
      plugins.push(pluginInfo)
      await databaseAPI.dbPut('plugins', plugins)

      // 输出新增的指令
      console.log('\n=== 新增插件指令 ===')
      console.log(`插件名称: ${pluginConfig.name}`)
      console.log(`插件版本: ${pluginConfig.version}`)
      console.log('新增指令列表:')
      pluginConfig.features.forEach((feature: any, index: number) => {
        console.log(`  [${index + 1}] ${feature.code} - ${feature.explain || '无说明'}`)

        // 格式化 cmds（区分字符串和对象）
        const formattedCmds = feature.cmds
          .map((cmd: any) => {
            if (typeof cmd === 'string') {
              return cmd
            } else if (typeof cmd === 'object' && cmd !== null) {
              // 对象类型的匹配指令
              const type = cmd.type || 'unknown'
              const label = cmd.label || type
              return `[${type}] ${label}`
            }
            return String(cmd)
          })
          .join(', ')

        console.log(`      关键词: ${formattedCmds}`)
      })
      console.log('==================\n')

      this.mainWindow?.webContents.send('plugins-changed')
      return { success: true, plugin: pluginInfo }
    } catch (error: unknown) {
      await fs.rm(tempExtractPath, { recursive: true, force: true })
      console.error('安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (e) {
        console.error('清理临时目录失败:', e)
      }
    }
  }

  // 导入开发中插件
  private async importDevPlugin(): Promise<any> {
    try {
      const result = await dialog.showOpenDialog(this.mainWindow!, {
        title: '选择插件配置文件',
        properties: ['openFile'],
        filters: [{ name: '插件配置', extensions: ['json'] }],
        message: '请选择 plugin.json 文件'
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: '未选择文件' }
      }

      const pluginJsonPath = result.filePaths[0]

      // 检查文件名是否为 plugin.json
      if (path.basename(pluginJsonPath) !== 'plugin.json') {
        return { success: false, error: '请选择 plugin.json 文件' }
      }

      // 获取插件文件夹路径（plugin.json 所在的目录）
      const pluginPath = path.dirname(pluginJsonPath)

      const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8')
      let pluginConfig: any
      try {
        pluginConfig = JSON.parse(pluginJsonContent)
      } catch {
        return { success: false, error: 'plugin.json 格式错误' }
      }

      if (!pluginConfig.name) {
        return { success: false, error: 'plugin.json 缺少 name 字段' }
      }

      const existingPlugins = await this.getPlugins()
      if (existingPlugins.some((p: any) => p.name === pluginConfig.name)) {
        return { success: false, error: '插件已存在' }
      }

      const requiredFields = ['name', 'version', 'features']
      for (const field of requiredFields) {
        if (!pluginConfig[field]) {
          return { success: false, error: `缺少必填字段: ${field}` }
        }
      }

      if (!Array.isArray(pluginConfig.features) || pluginConfig.features.length === 0) {
        return { success: false, error: 'features 必须是非空数组' }
      }

      for (const feature of pluginConfig.features) {
        if (!feature.code || !Array.isArray(feature.cmds)) {
          return { success: false, error: 'feature 缺少必填字段 (code, cmds)' }
        }
      }

      const pluginInfo = {
        name: pluginConfig.name,
        version: pluginConfig.version,
        description: pluginConfig.description || '',
        logo: pluginConfig.logo ? pathToFileURL(path.join(pluginPath, pluginConfig.logo)).href : '',
        main: pluginConfig?.development?.main,
        preload: pluginConfig.preload,
        features: pluginConfig.features,
        path: pluginPath,
        isDevelopment: true,
        installedAt: new Date().toISOString()
      }

      let plugins: any = await databaseAPI.dbGet('plugins')
      if (!plugins) plugins = []
      plugins.push(pluginInfo)
      await databaseAPI.dbPut('plugins', plugins)

      // 输出新增的指令
      console.log('\n=== 新增开发中插件指令 ===')
      console.log(`插件名称: ${pluginConfig.name}`)
      console.log(`插件版本: ${pluginConfig.version}`)
      console.log(`开发模式: ${pluginConfig.development?.main || '无'}`)
      console.log('新增指令列表:')
      pluginConfig.features.forEach((feature: any, index: number) => {
        console.log(`  [${index + 1}] ${feature.code} - ${feature.explain || '无说明'}`)

        // 格式化 cmds（区分字符串和对象）
        const formattedCmds = feature.cmds
          .map((cmd: any) => {
            if (typeof cmd === 'string') {
              return cmd
            } else if (typeof cmd === 'object' && cmd !== null) {
              // 对象类型的匹配指令
              const type = cmd.type || 'unknown'
              const label = cmd.label || type
              return `[${type}] ${label}`
            }
            return String(cmd)
          })
          .join(', ')

        console.log(`      关键词: ${formattedCmds}`)
      })
      console.log('=========================\n')

      this.mainWindow?.webContents.send('plugins-changed')
      return { success: true }
    } catch (error: unknown) {
      console.error('添加开发中插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 删除插件
  private async deletePlugin(pluginPath: string): Promise<any> {
    try {
      const plugins: any = await databaseAPI.dbGet('plugins')
      if (!plugins || !Array.isArray(plugins)) {
        return { success: false, error: '插件列表不存在' }
      }

      const pluginIndex = plugins.findIndex((p: any) => p.path === pluginPath)
      if (pluginIndex === -1) {
        return { success: false, error: '插件不存在' }
      }

      const pluginInfo = plugins[pluginIndex]

      // ✅ 检查是否为内置插件
      if (isInternalPlugin(pluginInfo.name)) {
        return {
          success: false,
          error: '内置插件不能卸载'
        }
      }

      plugins.splice(pluginIndex, 1)
      await databaseAPI.dbPut('plugins', plugins)

      this.mainWindow?.webContents.send('plugins-changed')

      if (!pluginInfo.isDevelopment) {
        try {
          await fs.rm(pluginPath, { recursive: true, force: true })
          console.log('已删除插件目录:', pluginPath)
        } catch (error) {
          console.error('删除插件目录失败:', error)
        }
      } else {
        console.log('开发中插件，保留目录:', pluginPath)
      }

      return { success: true }
    } catch (error: unknown) {
      console.error('删除插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 重载插件
  private async reloadPlugin(pluginPath: string): Promise<any> {
    try {
      const plugins: any = await databaseAPI.dbGet('plugins')
      if (!plugins || !Array.isArray(plugins)) {
        return { success: false, error: '插件列表不存在' }
      }

      const pluginIndex = plugins.findIndex((p: any) => p.path === pluginPath)
      if (pluginIndex === -1) {
        return { success: false, error: '插件不存在' }
      }

      const oldPlugin = plugins[pluginIndex]
      const pluginJsonPath = path.join(pluginPath, 'plugin.json')

      try {
        await fs.access(pluginJsonPath)
      } catch (error) {
        console.log('文件不存在', error)
        return { success: false, error: 'plugin.json 文件不存在' }
      }

      const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8')
      const pluginConfig = JSON.parse(pluginJsonContent)

      plugins[pluginIndex] = {
        ...oldPlugin,
        name: pluginConfig.name || oldPlugin.name,
        version: pluginConfig.version || oldPlugin.version,
        description: pluginConfig.description || oldPlugin.description,
        logo: pluginConfig.logo
          ? pathToFileURL(path.join(pluginPath, pluginConfig.logo)).href
          : oldPlugin.logo,
        features: pluginConfig.features || oldPlugin.features,
        main: pluginConfig.main || oldPlugin.main
      }

      await databaseAPI.dbPut('plugins', plugins)
      this.mainWindow?.webContents.send('plugins-changed')
      console.log('插件重载成功:', pluginPath)
      return { success: true }
    } catch (error: unknown) {
      console.error('重载插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 获取运行中的插件
  private getRunningPlugins(): string[] {
    if (this.pluginManager) {
      return this.pluginManager.getRunningPlugins()
    }
    return []
  }

  // 终止插件
  private killPlugin(pluginPath: string): { success: boolean; error?: string } {
    try {
      console.log('终止插件:', pluginPath)
      if (this.pluginManager) {
        const result = this.pluginManager.killPlugin(pluginPath)
        if (result) {
          return { success: true }
        } else {
          return { success: false, error: '插件未运行' }
        }
      }
      return { success: false, error: '功能不可用' }
    } catch (error: unknown) {
      console.error('终止插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 终止插件并返回搜索页面
  private killPluginAndReturn(pluginPath: string): { success: boolean; error?: string } {
    try {
      console.log('终止插件并返回搜索页面:', pluginPath)
      if (this.pluginManager) {
        const result = this.pluginManager.killPlugin(pluginPath)
        if (result) {
          this.mainWindow?.webContents.send('back-to-search')
          this.mainWindow?.webContents.focus()
          return { success: true }
        } else {
          return { success: false, error: '插件未运行' }
        }
      }
      return { success: false, error: '功能不可用' }
    } catch (error: unknown) {
      console.error('终止插件并返回搜索页面失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  // 获取插件市场列表
  private async fetchPluginMarket(): Promise<any> {
    try {
      // 从 OSS 获取 plugins.json
      const pluginsJsonUrl = 'https://ztools-center.oss-cn-beijing.aliyuncs.com/plugins.json'
      const latestVersionUrl = 'https://ztools-center.oss-cn-beijing.aliyuncs.com/latest'

      console.log('从 OSS 获取插件市场列表...')

      // 获取最新版本号（格式：2026.01.17.1337）
      let latestVersion = ''
      try {
        const versionResponse = await fetch(latestVersionUrl)
        if (versionResponse.ok) {
          latestVersion = (await versionResponse.text()).trim()
          console.log(`发现最新插件列表版本: ${latestVersion}`)
        }
      } catch (error) {
        console.warn('获取版本号失败，将强制更新:', error)
      }

      // 检查缓存
      const cachedVersion = await databaseAPI.dbGet('plugin-market-version')
      const cachedData = await databaseAPI.dbGet('plugin-market-data')

      if (cachedVersion === latestVersion && cachedData && latestVersion) {
        console.log('使用本地缓存的插件市场列表')
        return { success: true, data: cachedData }
      }

      // 下载 plugins.json
      console.log('下载新版本插件列表...')
      const response = await fetch(pluginsJsonUrl)
      if (!response.ok) {
        throw new Error(`下载失败: ${response.status} ${response.statusText}`)
      }

      const json = await response.json()

      // 保存到缓存
      await databaseAPI.dbPut('plugin-market-version', latestVersion)
      await databaseAPI.dbPut('plugin-market-data', json)

      return { success: true, data: json }
    } catch (error: unknown) {
      console.error('获取插件市场列表失败:', error)
      try {
        const cachedData = await databaseAPI.dbGet('plugin-market-data')
        if (cachedData) {
          console.log('获取失败，降级使用本地缓存')
          return { success: true, data: cachedData }
        }
      } catch {
        // ignore
      }
      return { success: false, error: error instanceof Error ? error.message : '获取失败' }
    }
  }

  // 从市场安装插件
  private async installPluginFromMarket(plugin: any): Promise<any> {
    try {
      console.log('开始从市场安装插件:', plugin.name)
      const downloadUrl = plugin.downloadUrl
      if (!downloadUrl) {
        return { success: false, error: '无效的下载链接' }
      }

      console.log('插件下载链接:', downloadUrl)

      const tempDir = path.join(app.getPath('temp'), 'ztools-plugin-download')
      await fs.mkdir(tempDir, { recursive: true })
      const tempFilePath = path.join(tempDir, `${plugin.name}-${Date.now()}.zip`)

      let retryCount = 0
      const maxRetries = 3
      while (retryCount < maxRetries) {
        try {
          await downloadFile(downloadUrl, tempFilePath)
          break
        } catch (error) {
          retryCount++
          console.error(`下载失败，重试第 ${retryCount} 次:`, error)
          if (retryCount >= maxRetries) throw error
          await sleep(500)
        }
      }

      console.log('插件下载完成:', tempFilePath)
      const result = await this._installPluginFromZip(tempFilePath)

      try {
        await fs.unlink(tempFilePath)
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch (e) {
        console.error('清理下载临时文件失败:', e)
      }

      return result
    } catch (error: unknown) {
      console.error('从市场安装插件失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '安装失败' }
    }
  }

  // 获取插件 README.md 内容
  private async getPluginReadme(
    pluginPathOrName: string,
    pluginName?: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      // 如果 pluginPathOrName 是一个路径（包含 / 或 \），则读取本地文件
      if (pluginPathOrName.includes('/') || pluginPathOrName.includes('\\')) {
        return await this.getLocalPluginReadme(pluginPathOrName)
      }

      // 否则当作插件名称，从远程加载
      const name = pluginName || pluginPathOrName
      return await this.getRemotePluginReadme(name)
    } catch (error: unknown) {
      console.error('读取插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '读取失败' }
    }
  }

  // 读取本地插件 README
  private async getLocalPluginReadme(
    pluginPath: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      // 尝试不同的 README 文件名（大小写不敏感）
      const possibleReadmeFiles = ['README.md', 'readme.md', 'Readme.md', 'README.MD']

      for (const filename of possibleReadmeFiles) {
        const readmePath = path.join(pluginPath, filename)
        try {
          let content = await fs.readFile(readmePath, 'utf-8')

          // 将插件路径转换为 file:// URL（跨平台兼容）
          const pluginPathUrl = pathToFileURL(pluginPath).href

          // 替换 Markdown 图片语法：![alt](path)
          content = content.replace(
            /!\[([^\]]*)\]\((?!http|file:)([^)]+)\)/g,
            (_match, alt, imgPath) => {
              const cleanPath = imgPath.replace(/^\.\//, '')
              return `![${alt}](${pluginPathUrl}/${cleanPath})`
            }
          )

          // 替换 HTML img 标签的 src 属性
          content = content.replace(
            /<img([^>]*?)src=["'](?!http|file:)([^"']+)["']([^>]*?)>/gi,
            (_match, before, src, after) => {
              const cleanSrc = src.replace(/^\.\//, '')
              return `<img${before}src="${pluginPathUrl}/${cleanSrc}"${after}>`
            }
          )

          // 替换 Markdown 链接语法（排除锚点链接 #）
          content = content.replace(
            /\[([^\]]+)\]\((?!http|file:|#)([^)]+)\)/g,
            (_match, text, linkPath) => {
              const cleanPath = linkPath.replace(/^\.\//, '')
              return `[${text}](${pluginPathUrl}/${cleanPath})`
            }
          )

          // 替换 HTML a 标签的 href 属性（排除锚点链接和外部链接）
          content = content.replace(
            /<a([^>]*?)href=["'](?!http|file:|#)([^"']+)["']([^>]*?)>/gi,
            (_match, before, href, after) => {
              const cleanHref = href.replace(/^\.\//, '')
              return `<a${before}href="${pluginPathUrl}/${cleanHref}"${after}>`
            }
          )

          return { success: true, content }
        } catch {
          // 继续尝试下一个文件名
          continue
        }
      }

      // 所有文件名都不存在
      return { success: false, error: '暂无详情' }
    } catch (error: unknown) {
      console.error('读取本地插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '读取失败' }
    }
  }

  // 从远程加载插件 README
  private async getRemotePluginReadme(
    pluginName: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const baseUrl = `https://raw.githubusercontent.com/ZToolsCenter/ZTools-plugins/main/plugins/${pluginName}`
      const readmeUrl = `${baseUrl}/README.md`

      console.log('从远程加载 README:', readmeUrl)

      // 使用 fetch 获取 README 内容
      const response = await fetch(readmeUrl)
      if (!response.ok) {
        return { success: false, error: '暂无详情' }
      }

      let content = await response.text()

      // 替换 Markdown 图片语法：![alt](path)
      content = content.replace(/!\[([^\]]*)\]\((?!http)([^)]+)\)/g, (_match, alt, path) => {
        const cleanPath = path.replace(/^\.\//, '')
        return `![${alt}](${baseUrl}/${cleanPath})`
      })

      // 替换 HTML img 标签的 src 属性
      content = content.replace(
        /<img([^>]*?)src=["'](?!http)([^"']+)["']([^>]*?)>/gi,
        (_match, before, src, after) => {
          const cleanSrc = src.replace(/^\.\//, '')
          return `<img${before}src="${baseUrl}/${cleanSrc}"${after}>`
        }
      )

      // 替换 Markdown 链接语法（排除锚点链接 #）
      content = content.replace(/\[([^\]]+)\]\((?!http|#)([^)]+)\)/g, (_match, text, path) => {
        const cleanPath = path.replace(/^\.\//, '')
        return `[${text}](${baseUrl}/${cleanPath})`
      })

      // 替换 HTML a 标签的 href 属性（排除锚点链接和外部链接）
      content = content.replace(
        /<a([^>]*?)href=["'](?!http|#)([^"']+)["']([^>]*?)>/gi,
        (_match, before, href, after) => {
          const cleanHref = href.replace(/^\.\//, '')
          return `<a${before}href="${baseUrl}/${cleanHref}"${after}>`
        }
      )

      return { success: true, content }
    } catch (error: unknown) {
      console.error('从远程加载插件 README 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '加载失败' }
    }
  }

  // 获取插件存储的数据库数据
  private async getPluginDbData(
    pluginName: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      // 获取以插件名为前缀的所有数据
      const prefix = `PLUGIN/${pluginName}/`
      const allData = lmdbInstance.allDocs(prefix)

      if (!allData || allData.length === 0) {
        return { success: true, data: [] }
      }

      // 过滤并格式化数据
      const formattedData = allData.map((item: any) => ({
        id: item._id.substring(prefix.length), // 去除前缀
        data: item.data,
        rev: item._rev,
        updatedAt: item.updatedAt || item._updatedAt
      }))

      return { success: true, data: formattedData }
    } catch (error: unknown) {
      console.error('获取插件数据失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '获取失败' }
    }
  }
}

export default new PluginsAPI()
