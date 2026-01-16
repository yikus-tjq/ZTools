import { ipcMain, app, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import { downloadFile } from '../utils/download.js'
import { spawn } from 'child_process'
import yaml from 'yaml'

/**
 * 更新路径配置
 */
interface UpdatePaths {
  updaterPath: string
  asarSrc: string
  asarDst: string
  unpackedSrc: string
  unpackedDst: string
  appPath: string
}

/**
 * 升级管理 API
 */
export class UpdaterAPI {
  private latestYmlUrl = 'https://github.com/ZToolsCenter/ZTools/releases/latest/download/latest.yml'
  private mainWindow: BrowserWindow | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private downloadedUpdateInfo: any = null
  private downloadedUpdatePath: string | null = null

  public init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.setupIPC()
    this.startAutoCheck()
  }

  private setupIPC(): void {
    ipcMain.handle('updater:check-update', () => this.checkUpdate())
    ipcMain.handle('updater:start-update', (_event, updateInfo) => this.startUpdate(updateInfo))
    ipcMain.handle('updater:install-downloaded-update', () => this.installDownloadedUpdate())
    ipcMain.handle('updater:get-download-status', () => this.getDownloadStatus())
  }

  /**
   * 启动自动检查（30分钟一次）
   */
  private startAutoCheck(): void {
    // 应用启动后立即进行首次检查
    this.autoCheckAndDownload()

    // 每30分钟检查一次
    this.checkTimer = setInterval(() => this.autoCheckAndDownload(), 30 * 60 * 1000)
  }

  /**
   * 自动检查并下载更新
   */
  private async autoCheckAndDownload(): Promise<void> {
    try {
      console.log('开始自动检查更新...')

      // 如果已经下载过更新，不再重复下载
      if (this.downloadedUpdateInfo) {
        console.log('已有下载的更新，跳过检查')
        return
      }

      const result = await this.checkUpdate()

      if (result.hasUpdate && result.updateInfo) {
        console.log('发现新版本，开始自动下载...', result.updateInfo)

        // 通知渲染进程开始下载
        this.mainWindow?.webContents.send('update-download-start', {
          version: result.updateInfo.version
        })

        // 执行下载
        const downloadResult = await this.downloadAndExtractUpdate(result.updateInfo)

        if (downloadResult.success) {
          this.downloadedUpdateInfo = result.updateInfo
          this.downloadedUpdatePath = downloadResult.extractPath

          // 通知渲染进程下载完成
          this.mainWindow?.webContents.send('update-downloaded', {
            version: result.updateInfo.version,
            changelog: result.updateInfo.changelog
          })

          console.log('更新下载完成，等待用户安装')
        } else {
          console.error('更新下载失败:', downloadResult.error)
          this.mainWindow?.webContents.send('update-download-failed', {
            error: downloadResult.error
          })
        }
      }
    } catch (error) {
      console.error('自动检查更新失败:', error)
    }
  }

  /**
   * 获取下载状态
   */
  private getDownloadStatus(): any {
    if (this.downloadedUpdateInfo) {
      return {
        hasDownloaded: true,
        version: this.downloadedUpdateInfo.version,
        changelog: this.downloadedUpdateInfo.changelog
      }
    }
    return { hasDownloaded: false }
  }

  /**
   * 根据平台选择下载URL
   */
  private selectDownloadUrl(updateInfo: any): string {
    // 直接使用 updateInfo 中的 downloadUrl
    return updateInfo.downloadUrl
  }

  /**
   * 构建更新包下载 URL
   * 格式: update-{platform}-{arch}-{version}.zip
   * 例如: update-darwin-arm64-1.2.8.zip
   */
  private buildUpdateDownloadUrl(version: string): string {
    const platform = process.platform // darwin, win32, linux
    const arch = process.arch // x64, arm64

    const fileName = `update-${platform}-${arch}-${version}.zip`
    const baseUrl = 'https://github.com/ZToolsCenter/ZTools/releases/latest/download'

    return `${baseUrl}/${fileName}`
  }

  /**
   * 下载并解压更新包
   */
  private async downloadAndExtractUpdate(updateInfo: any): Promise<any> {
    try {
      // 1. 获取下载 URL（已经在 checkUpdate 中构建好了）
      const downloadUrl = this.selectDownloadUrl(updateInfo)

      console.log('下载更新包:', downloadUrl)

      // 2. 下载更新包
      const tempDir = path.join(app.getPath('userData'), 'ztools-update-pkg')
      await fs.mkdir(tempDir, { recursive: true })
      const tempZipPath = path.join(tempDir, `update-${Date.now()}.zip`)
      const extractPath = path.join(tempDir, `extracted-${Date.now()}`)

      await downloadFile(downloadUrl, tempZipPath)

      // 3. 解压
      console.log('解压更新包...')
      await fs.mkdir(extractPath, { recursive: true })

      const zip = new AdmZip(tempZipPath)
      await new Promise<void>((resolve, reject) => {
        zip.extractAllToAsync(extractPath, true, (error: Error | null) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })

      // 4. 重命名 app.asar.tmp -> app.asar（如果存在）
      const appAsarTmp = path.join(extractPath, 'app.asar.tmp')
      const appAsar = path.join(extractPath, 'app.asar')
      try {
        await fs.access(appAsarTmp)
        await fs.rename(appAsarTmp, appAsar)
        console.log('成功重命名: app.asar.tmp -> app.asar')
      } catch {
        console.log('未找到 app.asar.tmp，可能直接是 app.asar')
      }

      // 5. 删除 zip 文件节省空间
      try {
        await fs.unlink(tempZipPath)
      } catch (e) {
        console.error('删除 zip 文件失败:', e)
      }

      return { success: true, extractPath }
    } catch (error: unknown) {
      console.error('下载更新失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 获取更新路径配置
   */
  private async getUpdatePaths(extractPath: string): Promise<UpdatePaths> {
    const isMac = process.platform === 'darwin'
    const isWin = process.platform === 'win32'
    const appPath = process.execPath

    const asarSrc = path.join(extractPath, 'app.asar')
    const unpackedSrc = path.join(extractPath, 'app.asar.unpacked')

    let updaterPath = ''
    let asarDst = ''
    let unpackedDst = ''

    if (isMac) {
      const contentsDir = path.dirname(path.dirname(appPath))
      const resourcesDir = path.join(contentsDir, 'Resources')

      if (!app.isPackaged) {
        updaterPath = path.join(app.getAppPath(), 'src/updater/mac-arm64/ztools-updater')
      } else {
        updaterPath = path.join(path.dirname(appPath), 'ztools-updater')
      }

      asarDst = path.join(resourcesDir, 'app.asar')
      unpackedDst = path.join(resourcesDir, 'app.asar.unpacked')
    } else if (isWin) {
      const appDir = path.dirname(appPath)
      const agentPath = path.join(appDir, 'ztools-agent.exe')
      const oldUpdaterPath = path.join(appDir, 'ztools-updater.exe')

      // 兼容旧版本：如果 ztools-agent.exe 不存在，尝试查找并重命名 ztools-updater.exe
      try {
        await fs.access(agentPath)
        updaterPath = agentPath
      } catch {
        // ztools-agent.exe 不存在，尝试查找旧版本
        try {
          await fs.access(oldUpdaterPath)
          // 找到旧版本，重命名为新版本
          await fs.rename(oldUpdaterPath, agentPath)
          console.log('已将 ztools-updater.exe 重命名为 ztools-agent.exe')
          updaterPath = agentPath
        } catch {
          // 两个文件都不存在，使用默认路径（后续会报错）
          updaterPath = agentPath
        }
      }

      const resourcesDir = path.join(appDir, 'resources')
      asarDst = path.join(resourcesDir, 'app.asar')
      unpackedDst = path.join(resourcesDir, 'app.asar.unpacked')
    }

    return { updaterPath, asarSrc, asarDst, unpackedSrc, unpackedDst, appPath }
  }

  /**
   * 启动 updater 并退出应用
   */
  private async launchUpdater(paths: UpdatePaths): Promise<void> {
    // 检查 updater 是否存在
    try {
      await fs.access(paths.updaterPath)
    } catch {
      throw new Error(`找不到升级程序: ${paths.updaterPath}`)
    }

    // 构建参数
    const args = ['--asar-src', paths.asarSrc, '--asar-dst', paths.asarDst, '--app', paths.appPath]

    if (paths.unpackedSrc) {
      args.push('--unpacked-src', paths.unpackedSrc)
      args.push('--unpacked-dst', paths.unpackedDst)
    }

    console.log('启动升级程序:', paths.updaterPath, args)

    // 启动 updater
    const subprocess = spawn(paths.updaterPath, args, {
      detached: true,
      stdio: 'ignore'
    })

    subprocess.unref()

    // 退出应用
    console.log('应用即将退出进行更新...')
    app.quit()
  }

  /**
   * 安装已下载的更新
   */
  private async installDownloadedUpdate(): Promise<any> {
    try {
      if (!this.downloadedUpdatePath || !this.downloadedUpdateInfo) {
        throw new Error('没有可用的更新')
      }

      const paths = await this.getUpdatePaths(this.downloadedUpdatePath)
      await this.launchUpdater(paths)

      return { success: true }
    } catch (error: unknown) {
      console.error('安装更新失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 清理定时器
   */
  public cleanup(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
  }

  /**
   * 检查更新
   */
  private async checkUpdate(): Promise<any> {
    try {
      console.log('开始检查更新...')

      // 1. 下载 latest.yml 文件
      const tempDir = path.join(app.getPath('userData'), 'ztools-update-check')
      await fs.mkdir(tempDir, { recursive: true })
      const tempFilePath = path.join(tempDir, `latest-${Date.now()}.yml`)

      try {
        console.log('下载 latest.yml:', this.latestYmlUrl)
        await downloadFile(this.latestYmlUrl, tempFilePath)

        // 2. 解析 YAML 文件
        const content = await fs.readFile(tempFilePath, 'utf-8')
        const updateInfo = yaml.parse(content)

        if (!updateInfo.version) {
          throw new Error('latest.yml 格式错误：缺少 version 字段')
        }

        const latestVersion = updateInfo.version
        const currentVersion = app.getVersion()

        console.log(`当前版本: ${currentVersion}, 最新版本: ${latestVersion}`)

        // 3. 比较版本号
        if (this.compareVersions(latestVersion, currentVersion) <= 0) {
          console.log('当前已是最新版本')
          return { hasUpdate: false, latestVersion, currentVersion }
        }

        console.log(`发现新版本: ${latestVersion}`)

        // 4. 构建下载 URL
        const downloadUrl = this.buildUpdateDownloadUrl(latestVersion)

        return {
          hasUpdate: true,
          currentVersion,
          latestVersion,
          updateInfo: {
            version: latestVersion,
            changelog: updateInfo.changelog || '',
            downloadUrl
          }
        }
      } finally {
        // 清理临时文件
        try {
          await fs.rm(tempDir, { recursive: true, force: true })
        } catch (e) {
          console.error('清理临时文件失败:', e)
        }
      }
    } catch (error: unknown) {
      console.error('检查更新失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  }

  /**
   * 开始更新（手动升级）
   */
  private async startUpdate(updateInfo: any): Promise<any> {
    try {
      console.log('开始更新流程...', updateInfo)

      // 1. 下载并解压更新包
      const downloadResult = await this.downloadAndExtractUpdate(updateInfo)
      if (!downloadResult.success) {
        return downloadResult
      }

      // 2. 获取更新路径配置
      const paths = await this.getUpdatePaths(downloadResult.extractPath)

      // 3. 启动 updater 并退出应用
      await this.launchUpdater(paths)

      return { success: true }
    } catch (error: unknown) {
      console.error('更新流程失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0
      const p2 = parts2[i] || 0
      if (p1 > p2) return 1
      if (p1 < p2) return -1
    }
    return 0
  }
}

export default new UpdaterAPI()
