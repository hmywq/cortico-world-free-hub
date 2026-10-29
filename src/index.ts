/**
 * World 定义（kind: world / api 6）。
 * 契约照 `cortico-world-fishtools/src/index.ts` 与 `cortico-world-fatfish/src/definition.ts`。
 */
import type { WorldDefinition, WorldContext } from 'cortico/world.ts';
import { FreeHubWorld, DEFAULT_OFM_DIR, DEFAULT_CREDS } from './world.ts';

export const FREE_HUB_DEFAULTS = {
  enabled: false,
  freeHub: {
    /** 端点地址：默认 OFM 的免费车道转发口；也能填任意 OpenAI 兼容端点 */
    baseUrl: 'http://127.0.0.1:18899/v1',
    /** OFM 插件数据目录（只读它的状态文件）；没装 OFM 可留空 */
    ofmDir: DEFAULT_OFM_DIR,
    /** DSH 凭据库（只读账号与余额；不出本机、不入日志） */
    credsFile: DEFAULT_CREDS,
    /** OFM 中继密钥（caller key），接入转发端口时用 */
    callerKey: '',
    /** 一键接入时默认用的供应商名 */
    providerName: 'freehub',
  },
};

/** 自描述：扩展市场只读这份、不执行代码；必须与 tools() 一致。 */
export const FREE_HUB_DESCRIBE = {
  tools: [
    {
      name: 'free_hub_status',
      description:
        '看本机「免费端点台」的状态：转发端口通不通、有哪些免费模型、各渠道今天能不能用、账号与今日用量。',
      summary: '查免费端点台的转发端口、渠道状态与账号余额',
      tags: ['read'],
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'free_hub_connect',
      description:
        '把某个 OpenAI 兼容端点接成 Coo 的模型供应商（默认接本机 OFM 的转发端口）。用户说「把免费模型接上／切到免费渠道」时调它。',
      summary: '把一个 OpenAI 兼容端点接成 Coo 的模型供应商',
      tags: ['write'],
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '供应商名字，默认 freehub' },
          baseUrl: { type: 'string', description: 'OpenAI 兼容地址，如 http://127.0.0.1:18326/v1' },
          model: { type: 'string', description: '模型 id，如 raccoon/sn-deepseek-v4-1-flash-1017 或 combo:recommended-free' },
          apiKey: { type: 'string', description: '密钥；不填则用面板配置里的中继密钥' },
        },
      },
    },
  ],
  events: [],
};

const WORLD: WorldDefinition = {
  id: 'free-hub',
  label: '免费端点台',
  defaults: () => structuredClone(FREE_HUB_DEFAULTS),
  describe: FREE_HUB_DESCRIBE as never,
  create: (ctx: WorldContext) =>
    new FreeHubWorld({
      cfg: ctx.cfg as never,
      secret: (name: string) => ctx.secret(name),
    }),
};

export default WORLD;
