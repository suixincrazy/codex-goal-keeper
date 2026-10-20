# Codex Goal Keeper

为 Windows Codex Desktop 自动继续已停滞目标，提供即时全局开关和每个会话的独立开关。

## 使用

插件启动后会为每个有历史记录的 Codex 会话打开 **Goal Keeper** 侧面板。未显示的会话会排队，在打开该会话时显示面板。新会话完成首轮后可显示面板；也可以在会话中输入“打开 Goal Keeper 面板”随时打开。

- **全局开关**：作为所有会话的默认开关。
- **本会话开关**：继承全局、开启、关闭。
- 本会话明确设置时优先于全局：全局关闭、本会话开启时，该会话仍会自动续跑；本会话关闭时不续跑。
- 点击开关后立即更新运行中的服务，不需要重启 Codex。
- 面板中的“所有会话”也可以逐个设置开关。

| 目标状态 | 行为 |
| --- | --- |
| 已停滞 `blocked` | 会话空闲且没有待处理用户请求时自动继续 |
| 执行中 `active` | 继续监测，不发送重复消息 |
| 已完成 `complete` | 停止该目标的检测和续跑 |
| 已暂停、预算或用量受限 | 等待用户或产品解除该状态 |

新目标自动纳入检测。关闭开关会取消尚未发出的自动续跑，不打断已经开始的正常任务轮次。原会话的模型、推理强度、权限与预算继续沿用。

## 安装

需要 Windows Codex Desktop、其 CLI 和 Node.js 24 或更高版本。使用标准 Codex 插件市场安装，无需修改桌面程序文件。

```powershell
codex plugin marketplace add suixincrazy/codex-goal-keeper --ref main --json
codex plugin add codex-goal-keeper@goal-keeper --json
```

首次部署运行仓库的 `scripts/install.ps1`，它会完成上述步骤、写入本机运行路径、创建隐藏启动项，并立即启动监测服务。可以下载临时副本执行，完成后删除该副本；日常运行只使用 Codex 的插件安装缓存。

安装脚本会先备份现有 `config.toml`，再注册插件，并在 `mcp_servers.goal_keeper` 中写入本机运行路径，不改模型提供商或其他插件。MCP 启动时也会检查并启动本机服务。这些运行路径只在本机配置中保存；插件安装缓存可能被 Codex 刷新，因此不依赖手工修改缓存中的启动描述。

## 更新与卸载

源代码维护在 [main 分支](https://github.com/suixincrazy/codex-goal-keeper/tree/main)。运行仓库的 `scripts/update.ps1` 可拉取最新市场快照、重新安装并重启服务，开关设置保持不变。更新时增加插件版本号，Codex 会使用新版本缓存。

运行 `scripts/uninstall.ps1` 会停止服务、删除本插件启动项并卸载插件。本机开关设置与配置备份保留，便于恢复。

## 本机数据与隐私

服务仅监听 `127.0.0.1`，控制接口使用本机随机令牌，并校验请求来源。不会上传会话或遥测。

- `CODEX_HOME/goal-keeper/state.json`：全局开关与会话覆盖设置。
- `runtime.json`：本机 Node、Codex 和安装路径。
- `endpoint.json`：仅本机控制地址与随机令牌。
- `control-key`：跨服务重启保留的本机令牌，让已打开面板自动重连。
- `config-backup-*.toml`：安装前的配置备份，可能含私密配置，始终留在本机。

会话标题仅用于本机控制面板显示。桌面状态在内存中提取为运行状态、目标状态和轮次标识；消息正文不保存、不发送到 GitHub。

## 实现与验证

通过 Codex app-server 读取、更新目标；通过运行中的 Desktop IPC 向原会话发起续跑。数据库仅以只读方式列举目标和会话，不直接改写数据库。未加载会话由 Desktop 原生续跑接口恢复。

Windows Desktop IPC 属于内部接口，版本升级后可能需要更新适配。已在 Codex Desktop `26.1013.4894.1`、CLI `0.163.0-alpha.10.2` 验证。支持本机 Codex 会话；云端执行器需要另行适配。

```powershell
npm test
```

行为测试覆盖开关优先级、设置持久化、完成后停止、重复续跑、运行中与用户请求等待，以及关闭开关和续跑之间的竞态。仓库不包含会话快照、本机凭据或桌面程序源码。
