/**
 * 渠道表 + 余额适配器（2026-10-29）
 *
 * 每家渠道只做三件事里能做到的那部分：
 *   · 认账号（读 DSH 凭据库里的 refs，按前缀）
 *   · 查余额（有适配器的才查，查不到就显示原因，不编数字）
 *   · 签到（Raccoon 是服务端每日自动到账、没有端点；CodeArts 需要 HMAC 签名，暂未接）
 *
 * 登录流程（添加账号/续期）**不在本插件**：那需要浏览器 OAuth / 设备码，
 * 继续在 OFM 里点。本插件只读它已经登录好的凭据。
 */
import { accountsOf, type CredStore } from './creds.ts';

export type Balance = { total: number; detail?: string } | { error: string };

export type ChannelDef = {
  id: string;
  label: string;
  vendor: string;
  /** 凭据库 refs 里的账号名前缀 */
  refPrefix: string;
  /** 这家能不能在面板里一键领取 */
  claim?: 'daily' | 'login-reward' | 'none';
  note?: string;
  balance?(account: { ref: string; payload: Record<string, string> }): Promise<Balance>;
};

/** 商汤 Raccoon：GET /api/web/points/v1/balance（只读） */
async function raccoonBalance(account: { ref: string; payload: Record<string, string> }): Promise<Balance> {
  const token = account.payload.access_token || account.payload.token || '';
  if (!token) return { error: '凭据里没有 access_token' };
  try {
    const res = await fetch('https://xiaohuanxiong.com/api/web/points/v1/balance', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Org-Code': account.payload.office_identity || '',
        'X-Raccoon-Language': 'zh',
        'X-Client-Platform': 'desktop-windows',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = (await res.json()) as {
      data?: { available_points?: number; reward_points?: number; daily_points?: number; topup_points?: number };
    };
    const d = data.data ?? {};
    if (typeof d.available_points !== 'number') return { error: '响应里没有 available_points' };
    const parts = [
      d.reward_points !== undefined ? `奖励 ${d.reward_points}` : '',
      d.daily_points !== undefined ? `每日 ${d.daily_points}` : '',
      d.topup_points !== undefined && d.topup_points > 0 ? `充值 ${d.topup_points}` : '',
    ].filter(Boolean);
    return { total: d.available_points, detail: parts.join(' · ') };
  } catch (err) {
    return { error: (err as Error)?.message || String(err) };
  }
}

export const CHANNELS: ChannelDef[] = [
  {
    id: 'codearts',
    label: 'CodeArts',
    vendor: '华为云',
    refPrefix: 'CODEARTS_ACCOUNT_',
    claim: 'daily',
    note: '签到要 SDK-HMAC-SHA256 签名（适配器待接）；余额用同一套签名查',
  },
  { id: 'raccoon', label: 'Raccoon', vendor: '商汤', refPrefix: 'RACCOON_ACCOUNT_', claim: 'none', note: '每日 300 由服务端自动发放，没有签到端点', balance: raccoonBalance },
  { id: 'qoder', label: 'Qoder', vendor: '阿里系', refPrefix: 'QODER_ACCOUNT_', claim: 'daily' },
  { id: 'qodercn', label: 'Qoder 中国版', vendor: '阿里系', refPrefix: 'QODERCN_ACCOUNT_', claim: 'daily' },
  { id: 'trae', label: 'TRAE', vendor: '字节', refPrefix: 'TRAE_ACCOUNT_', claim: 'daily' },
  { id: 'zcode', label: 'ZCode', vendor: '智谱', refPrefix: 'ZCODE_ACCOUNT_', claim: 'daily' },
  { id: 'minimax', label: 'MiniMax Code', vendor: 'MiniMax', refPrefix: 'MINIMAX_ACCOUNT_', claim: 'daily' },
  { id: 'cline', label: 'Cline', vendor: 'Cline', refPrefix: 'CLINE_ACCOUNT_', claim: 'daily' },
  { id: 'lobsterai', label: 'LobsterAI', vendor: '有道', refPrefix: 'LOBSTERAI_ACCOUNT_', claim: 'daily' },
  { id: 'loomy', label: 'Loomy', vendor: '讯飞', refPrefix: 'LOOMY_ACCOUNT_', claim: 'daily' },
  { id: 'gemini', label: 'Gemini', vendor: 'Google', refPrefix: 'GEMINI_ACCOUNT_', claim: 'none' },
];

/** 汇总：每家渠道的账号数 + 能查到的余额 */
export async function channelSummary(store: CredStore | null): Promise<
  Array<{
    id: string;
    label: string;
    vendor: string;
    accounts: number;
    balance?: Balance;
    claim?: string;
    note?: string;
  }>
> {
  const out = [];
  for (const ch of CHANNELS) {
    const accs = accountsOf(store, ch.refPrefix);
    let balance: Balance | undefined;
    if (ch.balance && accs.length) {
      try {
        balance = await ch.balance(accs[0]);
      } catch (err) {
        balance = { error: (err as Error)?.message || String(err) };
      }
    }
    out.push({
      id: ch.id,
      label: ch.label,
      vendor: ch.vendor,
      accounts: accs.length,
      balance,
      /** 这家有没有余额查询接口（2026-10-30 01:2x：没有就明说，别让「刷新余额」看起来像个假按钮） */
      balanceSupported: Boolean(ch.balance),
      claim: ch.claim,
      note: ch.note,
    });
  }
  return out;
}

/**
 * 渠道推荐表（2026-10-29 22:2x 全量实测：76 个模型逐条跑「能出字 + 工具流 Coo 能解析」）。
 * 只列可用且经代理整理后能被 Coo 吃下的那条；ms 是当时的整轮耗时。
 */
export type Recommendation = {
  /** 渠道代理路径前缀（= 供应商 baseUrl 里的 /<path>/v1） */
  path: string;
  label: string;
  /** 对应的 Coo 供应商名 */
  provider: string;
  model: string;
  ms: number;
  note?: string;
};

export const RECOMMENDED: Recommendation[] = [
  { path: 'qodercn', label: 'Qoder 中国版', provider: 'freehub-qoder', model: 'qodercn/gmodel', ms: 1107 },
  { path: 'codearts', label: '华为云 CodeArts', provider: 'freehub-codearts', model: 'codearts/deepseek-v4.1-flash', ms: 1690 },
  { path: 'cline', label: 'Cline', provider: 'freehub-cline', model: 'cline/openai/gpt-6-astra', ms: 1768 },
  { path: 'wb-proxy', label: 'WorkBuddy 代理', provider: 'freehub-wbproxy', model: 'wb-proxy/space-bunny', ms: 2783 },
  { path: 'raccoon', label: '商汤 Raccoon', provider: 'freehub-raccoon', model: 'raccoon/sn-deepseek-v4-1-flash-1017', ms: 2647, note: '偏慢，免费池排队' },
];
