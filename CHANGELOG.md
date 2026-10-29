# Changelog

本包遵循语义化版本；市场索引按版本号切段，每段用二级标题写版本号。

## 0.1.1

- 补齐 npm / GitHub 链接与安装说明（不改代码逻辑）。
- `package.json` 增加 repository / homepage / bugs 字段。

## 0.1.0

首个公开版本（Coo World 扩展 · `kind: world` / `api: 6`）。

- **面板「免费端点台」**：徽章（账号数 / 已接入渠道 / 免费车道 / 今日 tokens / 转发端口状态）+ 按渠道的卡片（账号数、剩余积分、刷新余额、领取入口）+ 转发端口的渠道状态。
- **只读接入本机已登录的渠道账号**：读取 DSH 凭据库（`~/.dsh/.credentials.yaml`，只读、不出本机、不入日志），识别 CodeArts / Raccoon / Qoder / TRAE / ZCode / MiniMax / Cline / LobsterAI / Loomy / Gemini 等渠道的账号数量。
- **余额适配器**：Raccoon（商汤）余额实时查询。
- **一键接入**：把任意 OpenAI 兼容端点写成 Coo 的模型供应商（`kind: coo` + chat 协议），默认指向本机 OFM 的中继端口。
- **工具**：`free_hub_status`、`free_hub_connect`。
- **明确不做**：渠道登录/OAuth、账号续期、积分签到接口的自动化。登录与领取继续在原插件里完成；本包不分发任何凭据，也不打包任何第三方渠道代码。

### 已知限制

- 依赖本机已安装并登录过渠道的 OFM；未安装时面板显示 0，属预期。
- 目前只有 Raccoon 接入了余额查询；其余渠道只显示账号数量。
- 令牌过期后需回 OFM 重新登录，本包会显示「查不到余额」而不会伪造数据。
