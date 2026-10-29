# cortico-world-free-hub · 免费端点台

把本机的**免费/低价模型额度**接进 Coo 的外壳（Coo World 扩展，`kind: world` / `api: 6`）。

- npm：**https://www.npmjs.com/package/cortico-world-free-hub**
- 源码：**https://github.com/HMYWQ/Cortico-world-free-hub**
- 许可：MIT

> 这是一个**客户端适配器**：不做渠道登录、不做签到、不保存凭据。
> 渠道能力由 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（OFM，DSH 桌面插件）提供，
> 本项目只按它公开说明的「OpenAI 兼容转发 / 中继端口」去调用。

## 它能干什么

| 面板 | 内容 |
|---|---|
| 徽章 | 账号数 / 已接入渠道 / 免费车道 / 今日 tokens / 转发端口状态 |
| 前置自检 | 缺 OFM、缺中继、缺密钥、未登录渠道 —— 逐项提示，附 OFM 仓库链接 |
| 渠道卡片 | 每家渠道的账号数、余额（Raccoon 已接）、状态 |
| **渠道推荐** | 每家的推荐模型 + 实测耗时 + 「用这家」一键切换 + 「重新测速」 |

工具（给模型用）：

- `free_hub_status` — 查转发端口、渠道状态、账号与用量
- `free_hub_connect` — 把任意 OpenAI 兼容端点接成 Coo 的模型供应商

## 内置渠道代理（127.0.0.1:18870）

两个作用：

1. **按渠道过滤模型清单** —— Coo 的模型下拉里只显示本渠道的模型，名字自带渠道名
   （例如 `Qoder中国版 · GLM-5.3 · x0.8`），不再是一份 75 条的盲选清单
2. **整理流式响应** —— 免费渠道的 SSE 经常不守规矩（`tool_calls` 缺 `index`、
   `finish_reason` 与工具分片挤在同一帧、流结束没有 finish），
   Coo 的解析器会报 `Missing native function index` 然后**静默不回话**。
   代理会补齐 index、拆分 finish 帧、必要时补一帧收尾，让这些渠道在 Coo 里可用

## 安装与使用

```bash
# 在 Coo 的 data/extensions 里
pnpm add cortico-world-free-hub
# 或用 file: 依赖指向本仓库
```

1. 先装 [OFM](https://github.com/Ebony-Vinyl/dsh-our-free-model)（DSH 桌面插件，MIT，欢迎给作者点 star），
   登录至少一个渠道（商汤 / 华为云 / Qoder / TRAE…）
2. OFM →「网关设置 → 局域网转发」打开中继（默认 `127.0.0.1:18326`），复制中继密钥
3. Coo → 设置 → 免费端点台 →「配置」填：端点地址 `http://127.0.0.1:18326/v1` + 中继密钥
4. 面板里点「用这家」，或在「模型供应商」里选 `freehub-*`

> 没装 OFM 也能用：同一个面板，把端点地址填成任意 OpenAI 兼容端点（OpenRouter / Groq / 本地 Ollama…）即可。

## 引用与致谢

- 设计参考并借鉴：[`dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model)
  （作者 **Ebony-Vinyl**，MIT）及其内置渠道包 `vendor/channel-pack`
  （上游 `gitee.com/iJetLi/deepseek-harness-codearts`，作者 **Jet**，MIT）。
- 本插件**不含**上述项目的任何源码副本、凭据或渠道实现；仅按它们公开说明的
  「OpenAI 兼容转发端口（base URL + Key）」进行对接。
- 如果这两个项目对你有用，请去给作者点个 star。

## 免责声明

- 本项目是**非官方、个人维护**的第三方适配器，与 OFM / channel-pack 的作者**无关**，
  未经其审阅或认可；上游变更可能随时让本插件失效。
- 使用本插件产生的任何后果（包括但不限于免费渠道条款、账号状态、额度消耗、模型输出质量）
  由使用者自行承担；作者不对任何损失负责。
- 若 OFM / channel-pack 的作者对本项目有任何意见，或希望其下架，
  请联系本项目作者，我们会在第一时间**下架并停止分发**。
- 本项目不提供、不分发任何凭据、账号或额度；请使用**你自己的** OFM 安装与账号。

## 许可

MIT（见 `LICENSE`）
