/**
 * 凭据读取（2026-10-29）
 *
 * 只读 DSH 的凭据库 `~/.dsh/.credentials.yaml`（结构简单、固定）：
 *
 *   version: 1
 *   records:
 *     <记录 id>:
 *       kind: <kind>
 *       payload:
 *         token: <值>      # 或 secret / id 等，随渠道而定
 *   refs:
 *     RACCOON_ACCOUNT_D687F23C: <记录 id>
 *
 * ⚠️ 只在本机内存里用，绝不写日志、不入库、不发给模型。
 */
import { readFileSync } from 'node:fs';

export type CredRecord = { kind: string; payload: Record<string, string> };
export type CredStore = { records: Map<string, CredRecord>; refs: Map<string, string> };

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** 极简 YAML 解析：只认 `顶层:` / `  key:` / `    key: value` 三层，够读凭据库。 */
export function parseCredentialYaml(text: string): CredStore {
  const records = new Map<string, CredRecord>();
  const refs = new Map<string, string>();
  let section = '';
  let recId = '';
  let inPayload = false;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    const line = raw.trim();

    if (indent === 0) {
      const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      section = m[1];
      if (m[2]) {
        // 顶层的标量（version: 1）忽略
      }
      recId = '';
      inPayload = false;
      continue;
    }

    if (section === 'refs') {
      const m = /^([^:]+):\s*(.+)$/.exec(line);
      if (m) refs.set(m[1].trim(), unquote(m[2]));
      continue;
    }

    if (section !== 'records') continue;

    if (indent === 2) {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      recId = m[1].trim();
      inPayload = false;
      if (!records.has(recId)) records.set(recId, { kind: '', payload: {} });
      continue;
    }

    if (!recId) continue;
    const rec = records.get(recId) as CredRecord;

    if (indent === 4) {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].trim();
      if (key === 'payload') {
        inPayload = true;
        continue;
      }
      inPayload = false;
      if (key === 'kind') rec.kind = unquote(m[2]);
      continue;
    }

    if (indent >= 6 && inPayload) {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (m) rec.payload[m[1].trim()] = unquote(m[2]);
    }
  }

  return { records, refs };
}

export function loadCredentialStore(file: string): CredStore | null {
  try {
    return parseCredentialYaml(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 按 refs 名字前缀找出某渠道的账号。
 *
 * ⚠️ 实测（2026-10-29）：`refs` 的值**不是记录 id**，而是凭据本体（JSON 单引号字符串），
 * 例如 `RACCOON_ACCOUNT_D687F23C: '{"access_token":"eyJ…"}'`。
 * 所以这里直接把值当 JSON 解析，解析不了就返回原文，交给适配器自己判断。
 */
export function accountsOf(
  store: CredStore | null,
  prefix: string
): Array<{ ref: string; payload: Record<string, string>; raw: string }> {
  if (!store) return [];
  const out: Array<{ ref: string; payload: Record<string, string>; raw: string }> = [];
  for (const [ref, value] of store.refs) {
    if (!ref.startsWith(prefix)) continue;
    const raw = value;
    let payload: Record<string, string> = {};
    const body = raw.trim().replace(/^['"]|['"]$/g, '');
    if (body.startsWith('{')) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        payload = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]));
      } catch {
        /* 解析不了就只给 raw */
      }
    } else {
      payload = { token: body };
    }
    out.push({ ref, payload, raw });
  }
  return out;
}
