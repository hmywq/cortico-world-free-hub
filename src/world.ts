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
  qodercn: 'Qoder 中国版',
  qoder: 'Qoder',
  codearts: '华为云 CodeArts',
  raccoon: '商汤 Raccoon',
  cline: 'Cline',
  'wb-proxy': 'WorkBuddy 代理',
  'our-free-model': 'OFM 免费车道',
  'our-free-model-region': 'OFM 免费车道（分区）',
  'deepseek-account': 'DeepSeek 官方',
  trae: 'TRAE',
  zcode: 'ZCode',
  minimax: 'MiniMax',
  lobsteraI: 'LobsterAI',
  lobsterai: 'LobsterAI',
  loomy: 'Loomy',
  gemini: 'Gemini',
};

/** 每个渠道优先挑哪个模型（按优先级匹配 id 子串；都不中就用该渠道第一个） */
const MODEL_PREFERENCE: readonly string[] = [
  'deepseek-v4.1-flash',
  'deepseek-v4-1-flash',
  'deepseek-flash',
  'glm-5.3-flash',
  'gmodel',
  'dfmodel',
  'space-bunny',
  'gpt-6-astra',
  'sn-sensenova',
];

/**
 * **只走免费渠道**（2026-10-30 01:1x 主人要求）：
 * 自动路由 / 测速排序只考虑这里面的渠道。
 * `deepseek-account`（OFM 自己的 DeepSeek 账号车道）、EAC、以及 Coo 侧的 goto-failover / deepseek / lingzhan
 * 都可能产生真实花费，一律**不进自动路由**。
 */
/**
 * Kilo 免密免费池（2026-10-30 01:2x 主人要求「Kilo 也做测试」）：
 * 这些模型挂在 `our-free-model/` 前缀下，但**不需要任何账号**，是 OFM 里最纯粹的免费池。
 * 之前被「our-free-model 一条大渠道」吞掉，测速只测到那条被限流的；现在拆成独立条目逐个测。
 */
const KILO_POOL: readonly string[] = [
  'our-free-model/kilo-auto/free',
  'our-free-model/openrouter/free',
  'our-free-model/stealth/glyph-cluster',
  'our-free-model/poolside/laguna-xs-2.1:free',
  'our-free-model/poolside/laguna-s-2.1:free',
  'our-free-model/reflection/beam-free',
  'our-free-model/nvidia/nemotron-3.5-lightning:free',
  'our-free-model/recursive/flint-v1.0:free',
];

const FREE_CHANNELS: readonly string[] = [
  'our-free-model',
  'our-free-model-region',
  'raccoon',
  'codearts',
  'qodercn',
  'qoder',
  'trae',
  'zcode',
  'cline',
  'wb-proxy',
  'minimax',
  'lobsterai',
  'loomy',
  'gemini',
];

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
  /** 自动路由的心跳：每 10 分钟给「当前最快的几家」做一次极小量探测，保持排序新鲜 */
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private proxy: { port: number; close: () => Promise<void> } | null = null;
  /**
   * 自动路由健康表（2026-10-30 00:5x）：渠道 → 最近一次成功/失败与耗时。
   * 只记录 OFM 那边的渠道（freehub-*），**不涉及 goto 付费路**。
   */
  private health = new Map<
    string,
    { ok: boolean; ms: number; at: number; ewma?: number; fails?: number; until?: number }
  >();

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
          auto: {
            candidates: () => this.autoCandidates(),
            note: (key: string, ok: boolean, ms: number) => this.noteHealth(key, ok, ms),
          },
        });
      }
    } catch (err) {
      this.proxy = null;
      void err;
    }
    // 心跳：让「谁最快」这件事持续刷新，而不是只靠手动测速
    this.hbTimer = setInterval(() => void this.heartbeat(), 3 * 60 * 1000);
    this.hbTimer.unref?.();
    setTimeout(() => void this.heartbeat(), 30 * 1000);
  }

  /** 给当前排在最前的 3 家做一次极小量探测（每家 max_tokens=16），失败会计入退避 */
  private async heartbeat(): Promise<void> {
    if (!this.proxy) return;
    const now = Date.now();
    const hkey = (r: { path: string; model: string }) => `${r.path}|${r.model}`;
    const all = this.recommendations().filter((r) => r.path !== 'auto' && FREE_CHANNELS.includes(r.path));
    // ① 当前最快的前 2 家：复查，保持排序新鲜
    const healthy = all
      .filter((r) => {
        const h = this.health.get(hkey(r));
        return h?.ok && (!h.until || h.until <= now);
      })
      .sort((a, b) => (this.health.get(hkey(a))?.ewma ?? 1e9) - (this.health.get(hkey(b))?.ewma ?? 1e9))
      .slice(0, 2);
    // ② 冷却已到期的失败渠道给 2 个名额：**自动复活**（免费渠道常是「刚才失败、一会儿又好」）
    const revivable = all
      .filter((r) => {
        const h = this.health.get(hkey(r));
        if (!h || h.ok) return false;
        return !h.until || h.until <= now;
      })
      .sort((a, b) => (this.health.get(hkey(a))?.at ?? 0) - (this.health.get(hkey(b))?.at ?? 0))
      .slice(0, 2);
    // ③ 顺带给 1 个没测过的
    const untested = all.filter((r) => !this.health.has(hkey(r))).slice(0, 1);
    const seen = new Set<string>();
    for (const cand of [...healthy, ...revivable, ...untested]) {
      const k = hkey(cand);
      if (seen.has(k)) continue;
      seen.add(k);
      try {
        const r = await this.probeChannelLive(cand.path, cand.model, 15000);
        this.noteHealth(k, r.ok, r.ms);
      } catch {
        /* 心跳失败不影响主流程 */
      }
    }
  }


  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
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

  /**
   * 真·可用性探测（2026-10-30 00:0x 教训）：
   * Coo 自带的「测试连接」只验证连通性 —— 上游额度耗尽时它照样返回 ok（usage 全 null），
   * 于是点完切换她会突然不说话。这里**真发一条最小生成**，拿到正文才算通。
   */
  private async probeChannelLive(
    path: string,
    model: string,
    timeoutMs = 25000
  ): Promise<{ ok: boolean; ms: number; error?: string }> {
    const port = this.proxy?.port ?? 18870;
    const t0 = Date.now();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/${path}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '只回两个字：收到' }],
          max_tokens: 16,
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      const ms = Date.now() - t0;
      if (!res.ok) return { ok: false, ms, error: text.replace(/\s+/g, ' ').slice(0, 160) };
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, ms, error: '响应不是 JSON：' + text.slice(0, 120) };
      }
      const choice = body?.choices?.[0];
      const msg = choice?.message ?? {};
      const content = String(msg?.content ?? '');
      const reasoning = String(msg?.reasoning_content ?? '');
      const toolCalls = msg?.tool_calls;
      const finish = String(choice?.finish_reason ?? '');
      /**
       * 判定「能用」：有正文 / 有工具调用 / 有思考内容 / 有正常 finish_reason 都算。
       * ⚠️ 只看 content 会误杀开思考的模型 —— max_tokens 16 全被 reasoning 吃掉，
       * content 是空串（codearts / cline 实测就是这样），但它们其实是好的。
       */
      const produced =
        Boolean(content) ||
        Boolean(reasoning) ||
        (Array.isArray(toolCalls) && toolCalls.length > 0) ||
        ['stop', 'tool_calls', 'length'].includes(finish);
      if (!produced) {
        return { ok: false, ms, error: '上游返回空回复：' + text.replace(/\s+/g, ' ').slice(0, 140) };
      }
      return { ok: true, ms };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: (err as Error)?.message || String(err) };
    }
  }

  /** 面板「用这家」：先真发一条生成确认能用，再改地址 + 模型并切换 */
  private async switchChannel(path: string): Promise<string> {
    const rec = this.recommendations().find((r) => r.path === path);
    if (!rec) return `没有渠道 ${path} 的推荐配置`;
    /**
     * 「自动切换」不需要守卫：它内部就是对每家逐个试、失败换下一家。
     * 这里直接建/更新 freehub-auto 供应商，模型填 `auto`。
     */
    if (rec.path === 'auto') {
      const key = String(this.opts.cfg.freeHub?.callerKey || this.opts.secret?.('OFM_CALLER_KEY') || '');
      const baseUrl = `http://127.0.0.1:${this.proxy?.port ?? 18870}/auto/v1`;
      const info = await this.cooApi('GET', `/api/providers/${rec.provider}`);
      if (info?.error) {
        const created = await this.cooApi('POST', '/api/providers', {
          name: rec.provider,
          entry: {
            kind: 'coo',
            baseUrl,
            secret: 'FREEHUB_API_KEY',
            multimodal: false,
            spec: { model: 'auto', thinking: true, reasoningEffort: 'low', maxTokens: 2048, temperature: 0.8, contextWindow: 131072 },
            options: { protocol: 'chat' },
          },
          ...(key ? { secretValue: key } : {}),
        });
        if (created?.error) return `创建失败：${created.error}`;
      } else {
        const entry = { ...info.entry, baseUrl };
        entry.spec = { ...(entry.spec || {}), model: 'auto', reasoningEffort: 'low', maxTokens: 2048 };
        const saved = await this.cooApi('POST', `/api/providers/${rec.provider}/save`, {
          name: rec.provider,
          entry,
          ...(key ? { secretValue: key } : {}),
          expectedRevision: info.revision,
        });
        if (saved?.error) return `保存失败：${saved.error}`;
      }
      const act = await this.cooApi('POST', `/api/providers/${rec.provider}/activate`);
      if (act?.error) return `已建 ${rec.provider}，但激活失败：${act.error}`;
      const order = this.autoCandidates().map((c) => c.label).join(' → ');
      return `已切到「自动切换」：尝试顺序 ${order}`;
    }
    // 闸一：真生成一次，失败就不切（避免「切完她不说话」）
    const live = await this.probeChannelLive(rec.path, rec.model);
    if (!live.ok) {
      return `没切：${rec.label} 现在用不了（${live.ms}ms）—— ${live.error || '无正文返回'}`;
    }
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
    return `已切到「${rec.label}」：模型 ${rec.model}（实测出字 ${live.ms}ms），地址 ${baseUrl}`;
  }

  /** 面板「重新测速」：逐个测 Coo 里的渠道供应商 */
  /**
   * 「去 OFM 签到」（2026-10-30 01:0x 主人问的）：**没法精确深链** ——
   *   · `dsh://` 协议注册的是另一个安装（E:\deepseek2\…），会开错程序；
   *   · DSH 的 Web 界面（127.0.0.1:10192）要启动时打印的鉴权 token，没落盘。
   * 所以这里做两件最有用的事：① 把 DSH 主窗口切到前台；② 返回一步一步的点击路径。
   */
  private async openOfm(): Promise<string> {
    const hint =
      'DSH 已尝试切到前台。接着点：设置 → Our Free Model →「白嫖模型接入」→ 各渠道「一键领取」。' +
      '（领取动作只能在他们界面里做：那套登录/签到逻辑在 OFM 内部，我们插件不碰。）';
    const { spawn } = await import('node:child_process');
    const ps = [
      "$ws = New-Object -ComObject WScript.Shell",
      "foreach ($n in @('DeepSeek Harness','DSH NEXT')) { if ($ws.AppActivate($n)) { 'ok:' + $n; exit 0 } }",
      "'not-found'",
    ].join('; ');
    try {
      const out = await new Promise<string>((resolve) => {
        const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
        let buf = '';
        child.stdout?.on('data', (d) => (buf += String(d)));
        child.on('close', () => resolve(buf.trim()));
        child.on('error', () => resolve(''));
        setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* 忽略 */
          }
          resolve(buf.trim());
        }, 6000);
      });
      if (out.startsWith('ok:')) return `已把 ${out.slice(3)} 切到前台。${hint}`;
      return `没找到 DSH 窗口（可能没开）。手动开一下 DSH，再按这个路径：${hint}`;
    } catch {
      return hint;
    }
  }

  /** 面板「重新测速」：**真发一条最小生成**（不用 Coo 的假绿灯测试） */
  private async retest(): Promise<Array<{ label: string; provider: string; ok: boolean; ms?: number; error?: string }>> {
    const rows = [];
    for (const rec of this.recommendations()) {
      // 「自动切换」本身不测：它是对每家逐个试，测它没意义
      if (rec.path === 'auto') continue;
      // 官方/付费车道不测（既不进自动路由，也别为了测速去花人家的钱）
      if (!FREE_CHANNELS.includes(rec.path)) continue;
      // 极小量：max_tokens 16 + 一句 6 字提示（见 probeChannelLive）
      const live = await this.probeChannelLive(rec.path, rec.model);
      this.health.set(`${rec.path}|${rec.model}`, { ok: live.ok, ms: live.ms, at: Date.now() });
      rows.push({
        label: rec.label,
        provider: rec.provider,
        ok: live.ok,
        ms: live.ms,
        error: live.ok ? undefined : String(live.error || '').slice(0, 120),
      });
    }
    // 测完立刻排序：有效的按耗时上浮，失败的沉底
    rows.sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.ok && b.ok) return (a.ms ?? 0) - (b.ms ?? 0);
      return 0;
    });
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
        // 「去 OFM 签到」：把 DSH 窗口切到前台，并给出下一步指引（无法精确深链，原因见 openOfm）
        if (method === 'openOfm') return { text: await this.openOfm() };
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

  /**
   * 面板的渠道推荐表：**从当前中继口的模型清单现算**（2026-10-30 00:4x 主人问「只显示这几个吗」）。
   * 以前写死 5 条，OFM 里渠道一变就漏；现在无论中继口有几个渠道，面板都跟着长。
   */
  private recommendations(): Array<{ path: string; label: string; provider: string; model: string; note?: string }> {
    const models = (this.lastProbe?.models ?? []).filter(Boolean);
    if (!models.length) {
      return RECOMMENDED.map((r) => ({ path: r.path, label: r.label, provider: r.provider, model: r.model, note: r.note }));
    }
    const byChannel = new Map<string, string[]>();
    for (const id of models) {
      const ch = String(id).split('/')[0];
      if (!ch) continue;
      const arr = byChannel.get(ch) ?? [];
      arr.push(String(id));
      byChannel.set(ch, arr);
    }
    const out: Array<{ path: string; label: string; provider: string; model: string; note?: string }> = [];
    for (const [ch, ids] of byChannel) {
      if (!ids.length) continue;
      let pick = ids[0];
      for (const pref of MODEL_PREFERENCE) {
        const hit = ids.find((i) => i.toLowerCase().includes(pref));
        if (hit) {
          pick = hit;
          break;
        }
      }
      if (ch === 'our-free-model') {
        // Kilo 免密池：每条模型单独一行，便于逐个测速/单独切换
        const kiloIds = KILO_POOL.filter((k) => ids.includes(k));
        for (const k of kiloIds) {
          const short = k.replace('our-free-model/', '').replace(':free', '');
          out.push({
            path: 'our-free-model',
            label: `Kilo · ${short}`,
            provider: `freehub-kilo-${short.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
            model: k,
            note: 'Kilo 免密免费池（无需账号）',
          });
        }
      }
      out.push({
        path: ch,
        label: CHANNEL_LABELS[ch] || ch,
        provider: `freehub-${ch}`,
        model: pick,
        note: FREE_CHANNELS.includes(ch)
          ? ids.length > 1
            ? `免费额度 · 可换 ${ids.length} 个模型`
            : '免费额度'
          : '官方/付费车道 · 不进自动路由、不参与测速',
      });
    }
    /**
     * 排序（2026-10-30 01:0x 主人要求「测完给它排序：无效的下去、有效的上来」）：
     *   0) 最近测过且成功的 —— 按耗时升序（快的在上）
     *   1) 没测过的
     *   2) 最近测过但失败的 —— 最久没成功的排最后
     * 同档再按模型多的优先（通常更常用），最后按名字。
     */
    const hkey = (r: { path: string; model: string }): string => `${r.path}|${r.model}`;
    const rank = (r: { path: string; model: string }): number => {
      // 官方/付费车道永远沉底（不参与测速，也不该占前排）
      if (!FREE_CHANNELS.includes(r.path)) return 3;
      const h = this.health.get(hkey(r));
      if (!h) return 1;
      return h.ok ? 0 : 2;
    };
    out.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ha = this.health.get(hkey(a));
      const hb = this.health.get(hkey(b));
      if (ra === 0 && ha && hb && ha.ms !== hb.ms) return ha.ms - hb.ms;
      if (ra === 2 && ha && hb && ha.at !== hb.at) return ha.at - hb.at;
      const na = byChannel.get(a.path)?.length ?? 0;
      const nb = byChannel.get(b.path)?.length ?? 0;
      if (na !== nb) return nb - na;
      return a.label.localeCompare(b.label);
    });
    // 第一行永远是「自动切换」：一个失败自动换下一家（只走 OFM 渠道）
    return [
      {
        path: 'auto',
        label: '自动切换（哪家能用走哪家）',
        provider: 'freehub-auto',
        model: 'auto',
        note: '按健康度排队，失败自动换下一家；不串 goto 付费路',
      },
      ...out,
    ];
  }

  /**
   * 自动路由的候选顺序（只 OFM 渠道）：
   *   1) 最近成功过的，按耗时升序（快的先试）
   *   2) 没试过的
   *   3) 最近失败的，最久没成功的排最后（给它留个复活机会）
   */
  private autoCandidates(): Array<{ path: string; model: string; label: string }> {
    // ⚠️ 只取免费渠道：deepseek-account（OFM 官方 DeepSeek 账号车道）、EAC 等一律不进自动路由
    const all = this.recommendations().filter((r) => r.path !== 'auto' && FREE_CHANNELS.includes(r.path));
    const now = Date.now();
    const hkey = (r: { path: string; model: string }) => `${r.path}|${r.model}`;
    /**
     * 排序（2026-10-30 01:2x 主人要求「不光能走，还得走最快的」）：
     *   0) 健康且不在冷却：按 **EWMA 延迟** 升序（快的一直排最前，会自动贴住最快的）
     *   1) 没测过：排健康后面
     *   2) 失败/冷却中：按「冷却结束时间」排，早恢复的靠前
     */
    const STALE_MS = 15 * 60 * 1000;
    const rank = (r: { path: string; model: string }): number => {
      if (!FREE_CHANNELS.includes(r.path)) return 3;
      const h = this.health.get(hkey(r));
      if (!h) return 1;
      // 数据陈旧（15 分钟没复查）→ 当未测，重新排，别让老数据把顺序焊死
      if (!h.ok && h.until && h.until > now) return 2;
      if (now - h.at > STALE_MS) return 1;
      return h.ok ? 0 : 2;
    };
    const ordered = all
      .slice()
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        const ha = this.health.get(hkey(a));
        const hb = this.health.get(hkey(b));
        if (ra === 0 && ha && hb) {
          const la = ha.ewma ?? ha.ms ?? 1e9;
          const lb = hb.ewma ?? hb.ms ?? 1e9;
          if (la !== lb) return la - lb;
        }
        if (ra === 2 && ha && hb) {
          const ua = ha.until ?? 0;
          const ub = hb.until ?? 0;
          if (ua !== ub) return ua - ub;
        }
        return a.label.localeCompare(b.label);
      })
      .map((r) => ({ path: r.path, model: r.model, label: r.label }));

    /**
     * 小比例探索（2026-10-30 01:3x）：12% 的概率把「第二名」提到最前试一次。
     * 目的：不让顺序被「第一名一直没出错」焊死 —— 别的渠道变快了也能被发现。
     * 只影响这一次请求的起点，失败/成功都会回到 health 里参与下一轮排序。
     */
    if (ordered.length > 2 && Math.random() < 0.12) {
      const [second] = ordered.splice(1, 1);
      ordered.unshift(second);
    }
    return ordered;
  }

  /**
   * 记录一次候选的成败（2026-10-30 01:2x 自动路由升级）：
   *   · 成功：EWMA 延迟（0.7 老值 + 0.3 新值），清空失败计数与冷却
   *   · 失败：失败计数 +1，按 30s×2^(n-1) 封顶 10 分钟 做冷却，冷却期内不排到前面
   */
  private noteHealth(key: string, ok: boolean, ms: number): void {
    const prev = this.health.get(key);
    const now = Date.now();
    if (ok) {
      const ewma = prev?.ewma === undefined ? ms : Math.round(prev.ewma * 0.7 + ms * 0.3);
      this.health.set(key, { ok: true, ms, at: now, ewma, fails: 0, until: 0 });
      return;
    }
    const fails = (prev?.fails ?? 0) + 1;
    const cooldown = Math.min(5 * 60 * 1000, 25 * 1000 * Math.pow(2, fails - 1));
    this.health.set(key, { ok: false, ms, at: now, ewma: prev?.ewma, fails, until: now + cooldown });
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
      recommend: this.recommendations().map((r) => ({
        ...r,
        baseUrl: `http://127.0.0.1:${this.proxy?.port ?? 18870}/${r.path}/v1`,
        // 上次测速结果（面板据此标「失败」并把失败的沉到下面）
        lastOk: this.health.get(`${r.path}|${r.model}`)?.ok,
        lastMs: this.health.get(`${r.path}|${r.model}`)?.ms,
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
