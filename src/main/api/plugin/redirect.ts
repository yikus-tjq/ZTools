import { ipcMain, Notification } from 'electron'
import windowManager from '../../managers/windowManager'
import databaseAPI from '../shared/database'
import { pluginFeatureAPI } from './feature'

/**
 * 插件跳转API - 插件专用
 */
export class PluginRedirectAPI {
  private mainWindow: Electron.BrowserWindow | null = null
  private pluginManager: any = null

  public init(mainWindow: Electron.BrowserWindow, pluginManager: any): void {
    this.mainWindow = mainWindow
    this.pluginManager = pluginManager
    this.setupIPC()
  }

  private setupIPC(): void {
    ipcMain.on('ztools-redirect', (event, { label, payload }) => {
      event.returnValue = this.handleRedirect(label, payload)
    })
  }

  /**
   * 检查 cmd 是否匹配当前的 payload
   * @param cmd 指令定义（string 或 object）
   * @param payload 传递的参数
   * @returns { matched: boolean, type?: string } 是否匹配及类型
   */
  private isCmdMatchPayload(
    cmd: any,
    payload: any
  ): { matched: boolean; type?: string; cmd?: any } {
    const isPayloadEmpty =
      !payload ||
      (typeof payload === 'string' && payload.trim() === '') ||
      (typeof payload === 'object' && Object.keys(payload).length === 0)

    if (isPayloadEmpty) {
      // payload 为空，只匹配 functional cmds (string)
      return { matched: typeof cmd === 'string', cmd }
    } else {
      // payload 不为空（字符串类型），只匹配 regex 或 over 类型的 matching cmds
      if (typeof cmd === 'string') {
        return { matched: false }
      }
      const cmdType = cmd.type
      const matched = cmdType === 'regex' || cmdType === 'over'
      return { matched, type: cmdType, cmd }
    }
  }

  private handleRedirect(label: string | [string, string], payload?: any): boolean {
    console.log('收到插件跳转请求:', { label, payload })
    try {
      this.processRedirect(label, payload)
      return true
    } catch (error) {
      console.error('处理插件跳转失败:', error)
      return false
    }
  }

  private async processRedirect(label: string | [string, string], payload?: any): Promise<void> {
    // console.log('processRedirect', label, payload)

    // 检查 payload 类型：只支持字符串类型（用于 regex 或 over 类型的匹配指令）
    if (payload !== undefined && payload !== null && typeof payload !== 'string') {
      console.log('暂不支持非字符串类型的 payload:', typeof payload, payload)
      return
    }

    try {
      const plugins = await databaseAPI.dbGet('plugins')
      if (!plugins || !Array.isArray(plugins)) {
        this.showNotification('未找到插件列表')
        return
      }

      // 合并动态 features
      for (const plugin of plugins) {
        const dynamicFeatures = pluginFeatureAPI.loadDynamicFeatures(plugin.name)
        plugin.features = [...(plugin.features || []), ...dynamicFeatures]
      }

      let targetPlugin: any = null
      let targetFeature: any = null
      let targetCmdName = ''
      let targetCmdType: string | undefined

      if (Array.isArray(label)) {
        // [插件名称, 指令名称]
        const [pluginName, cmdName] = label
        targetPlugin = plugins.find((p: any) => p.name === pluginName)

        if (targetPlugin) {
          // 查找对应的 feature 和匹配 payload 的 cmd
          for (const feature of targetPlugin.features || []) {
            if (feature.cmds && Array.isArray(feature.cmds)) {
              for (const cmd of feature.cmds) {
                const cmdLabel = typeof cmd === 'string' ? cmd : cmd.label
                if (cmdLabel === cmdName) {
                  // 检查 cmd 是否匹配 payload
                  const matchResult = this.isCmdMatchPayload(cmd, payload)
                  if (matchResult.matched) {
                    targetFeature = feature
                    targetCmdName = cmdLabel
                    targetCmdType = matchResult.type
                    break
                  }
                }
              }
              if (targetFeature) break
            }
          }
        }

        if (!targetPlugin || !targetFeature) {
          this.showNotification(`未找到插件或指令: ${pluginName} - ${cmdName}`)
          return
        }

        // 直接打开
        this.launchPlugin(targetPlugin, targetFeature, targetCmdName, {
          payload,
          type: targetCmdType
        })
      } else {
        // "指令名称" - 查找所有匹配的插件
        const matches: Array<{ plugin: any; feature: any; cmdName: string; type?: string }> = []
        const cmdName = label

        for (const plugin of plugins) {
          for (const feature of plugin.features || []) {
            if (feature.cmds && Array.isArray(feature.cmds)) {
              for (const cmd of feature.cmds) {
                const cmdLabel = typeof cmd === 'string' ? cmd : cmd.label
                if (cmdLabel === cmdName) {
                  // 使用共用的匹配逻辑
                  const matchResult = this.isCmdMatchPayload(cmd, payload)
                  if (matchResult.matched) {
                    matches.push({
                      plugin,
                      feature,
                      cmdName: cmdLabel,
                      type: matchResult.type
                    })
                  }
                }
              }
            }
          }
        }

        if (matches.length === 0) {
          this.showNotification(`未找到指令: ${cmdName}`)
          return
        }

        console.log('找到多个匹配:', matches)

        if (matches.length === 1) {
          // 只有一个匹配，直接打开
          const { plugin, feature, cmdName: matchCmdName, type } = matches[0]
          // console.log('重定向启动插件', matches[0])
          this.launchPlugin(plugin, feature, matchCmdName, {
            payload,
            type: type
          })
        } else {
          // 多个匹配，跳转到搜索页
          this.redirectSearch(cmdName, payload)
        }
      }
    } catch (error: unknown) {
      console.error('处理跳转逻辑失败:', error)
      const errorMsg = error instanceof Error ? error.message : '未知错误'
      this.showNotification(`跳转失败: ${errorMsg}`)
    }
  }

  private launchPlugin(plugin: any, feature: any, cmdName: string, param: any): void {
    const launchOptions = {
      path: plugin.path,
      type: 'plugin' as const,
      featureCode: feature.code,
      name: cmdName,
      cmdType: param.type,
      param: param
    }
    console.log('跳转可以直接打开插件:', launchOptions)

    // 发送 ipc-launch 到渲染进程
    this.mainWindow?.webContents.send('ipc-launch', launchOptions)
  }

  private redirectSearch(cmdName: string, payload: any): void {
    console.log('跳转到搜索页:', { cmdName, payload })

    // 先返回主页面
    if (this.pluginManager?.getCurrentPluginPath() !== null) {
      console.log('检测到插件正在显示，先隐藏插件并返回搜索页')
      this.pluginManager.hidePluginView()
      // 通知渲染进程返回搜索页面
      windowManager.notifyBackToSearch()
    }

    // 然后再发送跳转搜索的事件
    this.mainWindow?.webContents.send('redirect-search', {
      cmdName,
      payload
    })
  }

  private showNotification(body: string): void {
    if (Notification.isSupported()) {
      new Notification({
        title: 'ZTools',
        body: body
      }).show()
    }
  }
}

export default new PluginRedirectAPI()
