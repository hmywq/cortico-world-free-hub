/**
 * 免费端点台 · v0.1（2026-10-29）
 *
 * 干什么：
 *   1. 检测本机 Our Free Model（OFM / DSH 插件）的 OpenAI 兼容转发端口是否在
 *   2. 读它的只读状态文件（availability / catalog / stats），把「哪些渠道今天能用、有哪些免费模型」摆出来
 *   3. 把任意 OpenAI 兼容端点（OFM 的 18899、OpenRouter、Groq、本地 Ollama…）一键写成一个 Coo 模型供应商
 *
 * 明确**不做**：渠道登录 / 账号池 / 签到 / 积分领取 —— 那些是 OFM 的能力，
 * 本项目只按它 README 公开说明的「base URL + Key」去调用，不分发任何凭据。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadCredentialStore, accountsOf } from './creds.ts';
import { channelSummary, CHANNELS, RECOMMENDED } from './channels.ts';
import { startChannelProxy } from './channel-proxy.ts';

/** 渠道前缀 → 下拉里显示的渠道名（模型名字会自动带上它） */
export const CHANNEL_LABELS: Record<string, string> = {
  qodercn: 'Qoder中国版',
  qoder: 'Qoder',
  codearts: '华为云',
  raccoon: '商汤',
  cline: 'Cline',
  'wb-proxy': 'WorkBuddy',
  'our-free-model': 'OFM免费',
  'deepseek-account': 'DeepSeek官方',
  trae: 'TRAE',
  zcode: 'ZCode',
  minimax: 'MiniMax',
};

type Cfg = {
  enabled?: boolean;
  web?: { port?: number };
  freeHub?: {
    /** OFM 转发端口（OpenAI 兼容） */
    baseUrl?: string;
    /** OFM 插件的数据目录；读不到就当没装 */
    ofmDir?: string;
    /** 一键接入时用的供应商名 */
    providerName?: string;
    /** DSH 凭据库（读已登录账号用；只读，不出本机） */
    credsFile?: string;
    /** OFM 转发端口的中继密钥（caller key）；留空则接入时会要求先填 */
    callerKey?: string;
    /** 渠道代理端口（Coo 的供应商 baseUrl 指向它，模型下拉才带渠道名） */
    proxyPort?: number;
  };
};

const DEFAULT_BASE = 'http://127.0.0.1:18899/v1';
/**
 * 默认路径从用户主目录推出来 —— 上架版**不许**出现开发者的个人绝对路径
 * （2026-10-29 上架检查发现 3 处硬编码个人家目录，已改）。
 */
const HOME = homedir().replace(/\\/g, '/');
export const DEFAULT_OFM_DIR = `${HOME}/.dsh/our-free-model`;
export const DEFAULT_CREDS = `${HOME}/.dsh/.credentials.yaml`;

function readJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export class FreeHubWorld {
  id = 'free-hub';
  private readonly opts: { cfg: Cfg; secret?: (name: string) => string };
  /** 最近一次探测结果（灯用；webUi() 是同步的，只能读缓存） */
  private lastProbe: { ok: boolean; models: string[]; error?: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private proxy: { port: number; close: () => Promise<void> } | null = null;

  constructor(opts: { cfg: Cfg; secret?: (name: string) => string }) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    // 启动先探一次，之后每分钟重探（面板的灯靠这个）
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60 * 1000);
    this.timer.unref?.();
    // 渠道代理：让 Coo 的模型下拉只显示「本渠道」的模型，且名字自带渠道
    try {
      const key = String(this.opts.cfg.freeHub?.callerKey || this.opts.secret?.('OFM_CALLER_KEY') || '');
      if (key) {
        this.proxy = startChannelProxy({
          upstream: this.baseUrl(),
          key,
          port: Number(this.opts.cfg.freeHub?.proxyPort || 18870),
          labels: CHANNEL_LABELS,
        });
      }
    } catch (err) {
      this.proxy = null;
      void err;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.proxy) await this.proxy.close();
    this.proxy = null;
  }

  private async refresh(): Promise<void> {
    try {
      this.lastProbe = await this.probe(this.baseUrl());
    } catch {
      this.lastProbe = { ok: false, models: [], error: 'probe failed' };
    }
  }

  private baseUrl(): string {
    return String(this.opts.cfg.freeHub?.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  }

  private ofmDir(): string {
    return String(this.opts.cfg.freeHub?.ofmDir || DEFAULT_OFM_DIR);
  }

  /** DSH 凭据库路径（只读；读不到就当没登录过） */
  private credsFile(): string {
    return String(this.opts.cfg.freeHub?.credsFile || DEFAULT_CREDS);
  }

  private creds() {
    return loadCredentialStore(this.credsFile());
  }

  /** 账号速览（同步，面板徽章用） */
  private accountsQuick(): { total: number; connected: number } {
    const store = this.creds();
    let total = 0;
    let connected = 0;
    for (const ch of CHANNELS) {
      const n = accountsOf(store, ch.refPrefix).length;
      total += n;
      if (n > 0) connected += 1;
    }
    return { total, connected };
  }

  /** 探一下本机转发端口：能列出模型就算通 */
  private async probe(base: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
    // 探测也要带钥匙：中继口（18326）不带 key 会 401，容易被误判成「端口不通」。
    const key =
      this.opts.secret?.('OFM_CALLER_KEY') ||
      this.opts.secret?.('FREEHUB_API_KEY') ||
      String(this.opts.cfg.freeHub?.callerKey || '') ||
      '';
    try {
      const res = await fetch(`${base}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data ?? []).map((m) => String(m.id || '')).filter(Boolean);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error)?.message || String(err) };
    }
  }

  /** 读 OFM 的只读状态文件（没有就返回 null） */
  private readOfmState(): {
    availability: any;
    catalog: any;
    stats: any;
  } {
    const dir = this.ofmDir();
    return {
      availability: readJson(join(dir, 'availability.json')),
      catalog: readJson(join(dir, 'catalog.json')),
      stats: readJson(join(dir, 'stats.json')),
    };
  }

  /** 状态摘要（工具和面板共用） */
  private async summary(): Promise<string> {
    const base = this.baseUrl();
    const p = await this.probe(base);
    const st = this.readOfmState();
    const lines: string[] = [];
    lines.push(`转发端口：${base} → ${p.ok ? `通，${p.models.length} 个模型` : `不通（${p.error}）`}`);
    if (p.ok && p.models.length) lines.push(`  模型：${p.models.slice(0, 8).join(' / ')}${p.models.length > 8 ? ' …' : ''}`);
    if (!st.availability && !st.catalog) {
      lines.push(`OFM 数据目录：${this.ofmDir()}（没读到状态文件，可能没装 OFM 或目录不同）`);
    } else {
      const results = st.availability?.results ?? {};
      const rows = Object.entries(results).slice(0, 8).map(([k, v]: [string, any]) => {
        const s = String(v?.state ?? '?');
        const mark = s === 'ok' ? '✅' : s === 'throttled' ? '⏳' : '❌';
        return `${mark}${k}:${s}`;
      });
      if (rows.length) lines.push(`渠道（${Object.keys(results).length} 家）：${rows.join(' ')}`);
      const entries = st.catalog?.entries;
      if (Array.isArray(entries)) lines.push(`免费车道：${entries.slice(0, 6).join(' / ')}${entries.length > 6 ? ` … 共 ${entries.length} 个` : ''}`);
      const days = st.stats?.days;
      if (days && typeof days === 'object') {
        const today = new Date().toISOString().slice(0, 10);
        const d = (days as any)[today];
        if (d) lines.push(`今日用量：${d.total ?? 0} tokens`);
      }
    }
    const acc = this.accountsQuick();
    lines.push(`账号：共 ${acc.total} 个，覆盖 ${acc.connected}/${CHANNELS.length} 家渠道（读自 DSH 凭据库，只读）`);
    return lines.join('\n');
  }

  /** 把一个 OpenAI 兼容端点写成 Coo 的 provider（kind: coo / protocol: chat） */
  /** 调 Coo 自己的 HTTP 接口（用它现成的供应商系统，不自己造） */
  private async cooApi(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 45000): Promise<any> {
    const port = Number(this.opts.cfg.web?.port || 17788);
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text.slice(0, 200) };
    }
  }

  /** 面板「用这家」：把该渠道供应商指到渠道代理 + 推荐模型，并切成当前 */
  private async switchChannel(path: string): Promise<string> {
    const rec = RECOMMENDED.find((r) => r.path === path);
    if (!rec) return `没有渠道 ${path} 的推荐配置`;
    const key = String(this.opts.cfg.freeHub?.callerKey || this.opts.secret?.('OFM_CALLER_KEY') || '');
    const baseUrl = `http://127.0.0.1:${this.proxy?.port ?? 18870}/${rec.path}/v1`;
    const info = await this.cooApi('GET', `/api/providers/${rec.provider}`);
    if (info?.error) {
      const created = await this.cooApi('POST', '/api/providers', {
        name: rec.provider,
        entry: {
          kind: 'coo',
          baseUrl,
          secret: 'FREEHUB_API_KEY',
          multimodal: false,
          spec: { model: rec.model, thinking: true, reasoningEffort: 'low', maxTokens: 2048, temperature: 0.8, contextWindow: 131072 },
          options: { protocol: 'chat' },
        },
        ...(key ? { secretValue: key } : {}),
      });
      if (created?.error) return `创建失败：${created.error}`;
    } else {
      const entry = { ...info.entry, baseUrl };
      entry.spec = { ...(entry.spec || {}), model: rec.model, reasoningEffort: 'low', maxTokens: 2048 };
      const saved = await this.cooApi('POST', `/api/providers/${rec.provider}/save`, {
        name: rec.provider,
        entry,
        ...(key ? { secretValue: key } : {}),
        expectedRevision: info.revision,
      });
      if (saved?.error) return `保存失败：${saved.error}`;
    }
    const act = await this.cooApi('POST', `/api/providers/${rec.provider}/activate`);
    if (act?.error) return `已保存 ${rec.provider}，但切换失败：${act.error}`;
    return `已切到「${rec.label}」：模型 ${rec.model}，地址 ${baseUrl}`;
  }

  /** 面板「重新测速」：逐个测 Coo 里的渠道供应商 */
  private async retest(): Promise<Array<{ label: string; provider: string; ok: boolean; ms?: number; error?: string }>> {
    const rows = [];
    for (const rec of RECOMMENDED) {
      const t = await this.cooApi('POST', `/api/providers/${rec.provider}/test`, {}, 90000);
      rows.push({
        label: rec.label,
        provider: rec.provider,
        ok: t?.ok === true,
        ms: Number(t?.elapsedMs) || undefined,
        error: t?.error ? String(t.error).slice(0, 80) : undefined,
      });
    }
    return rows;
  }

  private async connect(args: {
    name?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<string> {
    const port = Number(this.opts.cfg.web?.port || 17788);
    const name = String(args.name || this.opts.cfg.freeHub?.providerName || 'freehub');
    const baseUrl = String(args.baseUrl || this.baseUrl()).replace(/\/+$/, '');
    const model = String(args.model || 'combo:recommended-free');
    const entry = {
      kind: 'coo',
      baseUrl,
      secret: 'FREEHUB_API_KEY',
      multimodal: false,
      spec: { model, thinking: true, reasoningEffort: 'high', maxTokens: 8192, temperature: 0.8, contextWindow: 131072 },
      options: { protocol: 'chat' },
    };
    const body: Record<string, unknown> = { name, entry };
    const key = String(args.apiKey || this.opts.cfg.freeHub?.callerKey || '').trim();
    if (key) body.secretValue = key;
    else
      return (
        '还差一步：这个端点要密钥。请在「配置」里填 OFM 的中继密钥（caller key），' +
        '或在 OFM 的「网关设置 → 接入客户端」里复制配方里的 key 后重试。'
      );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      if (!res.ok) return `接入失败（HTTP ${res.status}）：${text.slice(0, 300)}`;
      const parsed = JSON.parse(text) as { name?: string; readiness?: { state?: string } };
      return `已接入供应商「${parsed.name ?? name}」（就绪状态：${parsed.readiness?.state ?? '?'}）。去 设置 → 模型供应商 里选中它即可。`;
    } catch (err) {
      return `接入失败：${(err as Error)?.message || err}`;
    }
  }

  tools(): any[] {
    return [
      {
        name: 'free_hub_status',
        description:
          '看本机「免费端点台」的状态：OFM 转发端口通不通、有哪些免费模型、各渠道今天能不能用、今日用量。用户问「免费模型还能用吗 / 额度还有吗」时调它。',
        tags: ['read'],
        parameters: { type: 'object', properties: {} },
        handler: async () => `【免费端点台】\n${await this.summary()}`,
      },
      {
        name: 'free_hub_connect',
        description:
          '把某个 OpenAI 兼容端点接成 Coo 的模型供应商（默认接本机 OFM 的 127.0.0.1:18899）。用户说「把免费模型接上 / 切到免费渠道」时调它；不填参数就用本机默认。',
        tags: ['write'],
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '供应商名字，默认 freehub' },
            baseUrl: { type: 'string', description: 'OpenAI 兼容地址，如 http://127.0.0.1:18899/v1 或 https://api.groq.com/openai/v1' },
            model: { type: 'string', description: '模型名，OFM 用 combo:recommended-free，其它端点填自己的模型 id' },
            apiKey: { type: 'string', description: '密钥；不填则只写入配置，密钥留给用户在设置页填' },
          },
        },
        handler: async (args: any) =>
          await this.connect({
            name: args?.name,
            baseUrl: args?.baseUrl,
            model: args?.model,
            apiKey: args?.apiKey,
          }),
      },
    ];
  }

  /** OFM 状态文件里的统计（灯 / 徽章用） */
  private ofmCounts(): { channels: number; ok: number; lanes: number; todayTokens: number; has: boolean } {
    const st = this.readOfmState();
    const results = (st.availability?.results ?? {}) as Record<string, any>;
    const channels = Object.keys(results).length;
    const ok = Object.values(results).filter((v) => String(v?.state) === 'ok').length;
    const lanes = Array.isArray(st.catalog?.entries) ? st.catalog.entries.length : 0;
    const today = new Date().toISOString().slice(0, 10);
    const todayTokens = Number(st.stats?.days?.[today]?.total) || 0;
    return { channels, ok, lanes, todayTokens, has: Boolean(st.availability || st.catalog) };
  }

  /** 面板：灯 + 徽章 + 配置表单 + 状态面板（2026-10-29 20:5x 主人截图「什么都没有」→ 补上） */
  webUi(_language: string = 'zh'): any {
    const c = this.ofmCounts();
    const p = this.lastProbe;
    return {
      label: '免费端点台',
      lamps: [
        {
          label: '转发端口',
          state: p === null ? 'loading' : p.ok ? 'online' : 'error',
          hint: p === null ? '正在探测' : p.ok ? `${p.models.length} 个模型` : String(p.error || '连不上'),
        },
        {
          label: 'OFM',
          state: c.has ? 'online' : 'offline',
          hint: c.has ? `${c.channels} 家渠道` : '本机没装 Our Free Model',
        },
      ],
      badges: [
        { label: '渠道可用', value: `${c.ok}/${c.channels}`, tone: c.ok > 0 ? 'on' : 'off' },
        { label: '免费车道', value: c.lanes, tone: c.lanes > 0 ? 'on' : 'off' },
        { label: '账号', value: `${this.accountsQuick().total}`, tone: 'plain' },
        { label: '今日 tokens', value: c.todayTokens, tone: 'plain' },
      ],
      config: [this.configGroup()],
      panels: [{ id: 'status', title: '白嫖模型接入 · 状态', description: '账号、余额、免费车道、转发端口' }],
      invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
        void args;
        if (panel !== 'status') throw new Error('未知面板');
        if (method === 'status') return await this.statusPayload();
        if (method === 'refresh') {
          await this.refresh();
          return await this.statusPayload();
        }
        if (method === 'connect') return { text: await this.connect({}) };
        // 「用这家」：把该渠道供应商的 baseUrl 指向渠道代理、模型设成推荐模型，并切为当前
        if (method === 'switch') {
          const path = String((args?.[0] as string) || '');
          return { text: await this.switchChannel(path) };
        }
        // 重新测速：逐个调 Coo 的 provider test，回报耗时
        if (method === 'retest') return { rows: await this.retest() };
        throw new Error('未知方法');
      },
    };
  }

  /**
   * 前置自检（2026-10-29 上架前加）：别人装完第一眼就知道缺什么、去哪儿补。
   * 四项：装了 OFM / 中继口通 / 有密钥 / 登录过渠道。
   */
  private precheck(): {
    ready: boolean;
    steps: Array<{ ok: boolean; key: string; text: string; link?: string }>;
  } {
    const ofm = existsSync(join(this.ofmDir(), 'availability.json')) || existsSync(join(this.ofmDir(), 'settings.json'));
    const relay = this.lastProbe?.ok ?? false;
    const key = Boolean(
      String(this.opts.cfg.freeHub?.callerKey || '').trim() ||
        this.opts.secret?.('OFM_CALLER_KEY') ||
        this.opts.secret?.('FREEHUB_API_KEY')
    );
    const accounts = this.accountsQuick().total;
    const steps = [
      {
        ok: ofm,
        key: 'ofm',
        text: 'DSH 里装好 Our Free Model（OFM）—— 顺手给作者点个 star',
        link: 'https://github.com/Ebony-Vinyl/dsh-our-free-model',
      },
      { ok: relay, key: 'relay', text: 'OFM →「网关设置 → 局域网转发」打开中继（默认 127.0.0.1:18326）' },
      { ok: key, key: 'key', text: '把中继密钥填到本页「配置 → OFM 中继密钥」' },
      { ok: accounts > 0, key: 'accounts', text: '在 OFM 里登录至少一个渠道（商汤 / 华为云 / TRAE…）' },
    ];
    return { ready: steps.every((s) => s.ok), steps };
  }

  private configGroup(): any {
    const at = (k: string) => `worlds.free-hub.${k}`;
    return {
      id: 'world:free-hub.connection',
      owner: 'world:free-hub',
      schema: {
        type: 'object',
        title: '免费端点台',
        description: '要接哪家的 OpenAI 兼容端点。OFM 的默认转发端口是 127.0.0.1:18899；没装 OFM 也能填别的端点。',
        properties: {
          [at('freeHub.baseUrl')]: { type: 'string', title: '端点地址', 'x-hot': true },
          [at('freeHub.ofmDir')]: { type: 'string', title: 'OFM 数据目录（只读状态用，没有就留空）' },
          [at('freeHub.credsFile')]: { type: 'string', title: 'DSH 凭据库路径（只读账号与余额，留空用默认）' },
          [at('freeHub.callerKey')]: { type: 'string', title: 'OFM 中继密钥（caller key，接入转发端口时用）' },
          [at('freeHub.providerName')]: { type: 'string', title: '接入后的供应商名' },
        },
      },
    };
  }

  /** 面板/工具共用的结构化状态 */
  private async statusPayload(): Promise<any> {
    await this.refresh();
    const c = this.ofmCounts();
    const st = this.readOfmState();
    const store = this.creds();
    const channels = await channelSummary(store);
    const connected = channels.filter((x) => x.accounts > 0);
    const accountsTotal = channels.reduce((n, x) => n + x.accounts, 0);
    return {
      baseUrl: this.baseUrl(),
      reachable: this.lastProbe?.ok ?? false,
      models: this.lastProbe?.models ?? [],
      error: this.lastProbe?.error,
      ofm: c,
      channels: (st.availability?.results ?? {}) as Record<string, unknown>,
      lanes: st.catalog?.entries ?? [],
      accounts: { total: accountsTotal, channels: connected.length, ofAll: channels.length },
      channelSummary: channels,
      precheck: this.precheck(),
      proxy: {
        running: Boolean(this.proxy),
        port: this.proxy?.port ?? Number(this.opts.cfg.freeHub?.proxyPort || 18870),
        baseUrlFor: (ch: string) => `http://127.0.0.1:${this.proxy?.port ?? 18870}/${ch}/v1`,
        channels: Object.keys(CHANNEL_LABELS),
      },
      /** 推荐表（面板「渠道推荐」那一栏用） */
      recommend: RECOMMENDED.map((r) => ({
        ...r,
        baseUrl: `http://127.0.0.1:${this.proxy?.port ?? 18870}/${r.path}/v1`,
      })),
      text: await this.summary(),
    };
  }

  /** 环境提示词里只放一行（前缀要稳，别把长状态塞进去） */
  envPromptVars(): Record<string, string> {
    const base = this.baseUrl();
    const hasOfm = existsSync(join(this.ofmDir(), 'availability.json'));
    return {
      'freehub.baseUrl': base,
      'freehub.ofm': hasOfm ? '本机装了 Our Free Model（可用 free_hub_status 查渠道与额度）' : '本机没检测到 Our Free Model',
    };
  }
}
