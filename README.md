# cortico-provider-ofm

把 **Our Free Model（OFM）** 的本地 OpenAI 兼容转发端口接成 Coo 的模型供应商。

> 这是一个**客户端适配器**，不包含任何渠道账号、签到、积分或代理逻辑——
> 那些能力全部由 OFM 插件本身提供，本项目只是「照它的公开接口去调用」。

## 引用与致谢

- 设计参考并借鉴：[`dsh-our-free-model`](https://github.com/)（作者 **Ebony-Vinyl**，MIT）
  以及其内置渠道包 `vendor/channel-pack`（上游 `gitee.com/iJetLi/deepseek-harness-codearts`，作者 **Jet**，MIT）。
- 本插件**不含**上述项目的任何源码副本；仅按它们 README 中公开说明的
  「OpenAI 兼容转发端口（base URL + Key）」进行对接。

## 免责声明

- 本项目是**非官方、个人维护**的第三方适配器，与 OFM / channel-pack 的作者**无关**，
  未经其审阅或认可；上游作者的变更可能随时让本插件失效。
- 使用本插件产生的任何后果（包括但不限于免费渠道条款、账号状态、额度消耗、模型输出质量）
  由使用者自行承担；作者不对任何损失负责。
- 若 OFM / channel-pack 的作者对本项目有任何意见，或希望其下架，
  请联系本项目作者，我们会在第一时间**下架并停止分发**。
- 本项目不提供、不分发任何凭据、账号或额度；请使用**你自己的** OFM 安装与账号。

## 用法（三步）

1. 安装并启用 [OFM](https://github.com/) 插件（桌面端 DSH）
2. 在 OFM 设置里打开 **转发端口**（默认 `http://127.0.0.1:18899/v1`），
   在「网关设置」里签发一个中继密钥（caller key）
3. Coo 里 `设置 → 模型供应商 → 新建`，类型选 **Our Free Model（本地网关）**，
   填 baseUrl 与密钥，模型填 `combo:recommended-free`（或任意 OFM 车道模型）

> 本插件的 baseUrl 字段接受**任意 OpenAI 兼容端点**（不限于 OFM），
> 换一家服务只要改地址和密钥。

## 许可

MIT（见 `LICENSE`）
