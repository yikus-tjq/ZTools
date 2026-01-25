# 1.3.2

## 新功能 (Feat)

- 窗口支持宽度调整，插件支持设置默认高度
- 未分离状态双击搜索框分离窗口
- 搜索框输入文本支持Ctrl + F或Cmd + F进行二次筛选
- 退出程序时销毁所有插件窗口
- 引入代理配置管理，默认使用系统代理
- 更新包上传到OSS
- createBrowserWindow window不存在时抛出异常

## 修复 (Fix)

- 修复托盘退出异常
- 修复macOS系统中最后焦点获取问题

## 优化 (Optimize)

- 插件界面快捷键打开插件的开发者工具
- 开发者工具点击切换开启状态
- 重载时重载标题
- 改进网络请求和文件下载的缓存处理

## 重构 (Refactor)

- 移除axios依赖并引入基于Electron net的自定义HTTP请求工具

## 其他 (Chore)

- 更新pnpm依赖
- 删除upstream-sync.yml
