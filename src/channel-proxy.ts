/**
 * 渠道代理（2026-10-29）
 *
 * 为什么需要：OFM 的 `/v1/models` 里 `name` 只有模型名（「GLM-5.3 · x0.8」），
 * 不带渠道，于是 Coo 的模型下拉在**每个供应商**里都是同一份 75 条清单 —— 用户盲选，看不出是哪家。
 *
 * 做法：在本机起一个只监听 127.0.0.1 的小代理，路径带渠道前缀：
 *
 *   GET  http://127.0.0.1:18870/qoder/v1/models       → 只列 qodercn/ 的模型，name 前缀「Qoder中国版 · 」
 *   POST http://127.0.0.1:18870/qoder/v1/chat/completions → 原样转发给中继口（自动加中继密钥）
 *
 * Coo 侧只要把供应商 baseUrl 写成 `http://127.0.0.1:18870/<渠道>/v1`，
 * 下拉里就只剩该渠道的模型、而且名字自带渠道。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/**
 * 把上游的 SSE 整理成 Coo 能吃的形状（2026-10-29 实测：免费渠道经常不守规矩，
 * Coo 会报 `Missing native function index` / `ended without finish_reason`，然后**不回话**）。
 *
 * 整理内容：
 *   1. 每个 tool_calls 分片补 `index`（缺了就按顺序补）
 *   2. `tool_calls` 与 `finish_reason` 挤在同一帧 → 拆成两帧
 *   3. 流结束时若从没发过 finish_reason → 补一帧（有工具调用给 tool_calls，否则 stop）
 *   4. 中途只带 usage 的帧不单独发，攒到收尾帧里
 */
async function pipeNormalizedSse(body: NodeReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  let sawTool = false;
  let finishSent = false;
  let usage: unknown = null;
  /** 上游的工具调用分片：按上游 index 攒，攒齐了再一次性按 0..n 顺序发给 Coo */
  const toolBuf = new Map<number, { id?: string; name?: string; args: string }>();

  const emit = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const flushTools = (chunk: any) => {
    if (!toolBuf.size) return;
    let i = 0;
    for (const [, call] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
      emit({
        ...chunk,
        usage: undefined,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  ...(call.id ? { id: call.id } : {}),
                  type: 'function',
                  function: { name: call.name || '', arguments: call.args || '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      i += 1;
    }
    toolBuf.clear();
  };

  const handle = (chunk: any) => {
    if (chunk?.usage) usage = chunk.usage;
    const choices = chunk?.choices;
    if (!Array.isArray(choices) || choices.length === 0) return; // 纯 usage 帧，攒着
    const ch = choices[0] ?? {};
    const delta = ch.delta ?? {};
    const tcs = delta.tool_calls;

    // ① 攒工具分片（上游可能拆得很碎、index 也可能乱）
    if (Array.isArray(tcs) && tcs.length) {
      sawTool = true;
      tcs.forEach((tc: any, pos: number) => {
        const key = Number.isInteger(tc.index) ? tc.index : pos;
        const cur = toolBuf.get(key) ?? { args: '' };
        if (tc.id) cur.id = tc.id;
        const fn = tc.function || {};
        if (fn.name) cur.name = fn.name;
        if (fn.arguments) cur.args += fn.arguments;
        toolBuf.set(key, cur);
      });
      // 同时带 finish_reason 的：先冲工具，再冲 finish
      if (ch.finish_reason) {
        flushTools(chunk);
        emit({ ...chunk, choices: [{ index: ch.index ?? 0, delta: {}, finish_reason: ch.finish_reason }], ...(usage ? { usage } : {}) });
        finishSent = true;
      }
      return;
    }

    // ② 工具阶段结束了（这一帧没有工具分片）→ 先把攒好的工具发出去
    if (toolBuf.size) flushTools(chunk);

    // ③ 普通内容 / 收尾
    if (ch.finish_reason) {
      emit({ ...chunk, choices: [{ ...ch, delta, finish_reason: ch.finish_reason }], ...(usage ? { usage } : {}) });
      finishSent = true;
      return;
    }
    if (delta.content || delta.reasoning_content || delta.refusal) emit(chunk);
  };

  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (!line.trim() || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        handle(JSON.parse(payload));
      } catch {
        /* 坏帧直接丢 */
      }
    }
  }
  if (!finishSent) {
    emit({ choices: [{ index: 0, delta: {}, finish_reason: sawTool ? 'tool_calls' : 'stop' }], ...(usage ? { usage } : {}) });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export type AutoCandidate = { path: string; model: string; label: string };

export type ChannelProxyOptions = {
  /** 上游（OFM 中继口），如 http://127.0.0.1:18326/v1 */
  upstream: string;
  /** 中继密钥 */
  key: string;
  /** 监听端口 */
  port: number;
  /** 渠道前缀 → 显示名 */
  labels: Record<string, string>;
  /**
   * 自动路由（2026-10-30 00:5x 主人要的「一个没动就自动下一个」）：
   * `/auto/v1/chat/completions` 会按 candidates() 的顺序逐个尝试，失败就换下一家。
   */
  auto?: {
    candidates: () => AutoCandidate[];
    /** 每次尝试的结果回填给 World，用来排序/显示 */
    note: (path: string, ok: boolean, ms: number) => void;
  };
};

function send(res: ServerResponse, status: number, body: string, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

/** 把「已经读出来的第一块」拼回流的开头，交给后面的解析器 */
function prependStream(first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): NodeReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  }) as unknown as NodeReadableStream<Uint8Array>;
}

export function startChannelProxy(opts: ChannelProxyOptions): { port: number; close: () => Promise<void> } {
  const upstream = opts.upstream.replace(/\/+$/, '');
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      // /<channel>/v1/....
      const m = /^\/([a-z0-9-]+)(\/v1\/.*)$/i.exec(url.pathname);
      if (!m) {
        send(res, 404, JSON.stringify({ error: 'path must be /<channel>/v1/...' }));
        return;
      }
      const channel = m[1];
      const rest = m[2];
      const auth = { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' };

      try {
        /**
         * ③ 自动路由（2026-10-30 00:5x）：`/auto/v1/*`
         * 按 World 给的候选顺序（健康优先）逐个尝试，**只走 OFM 那些渠道，不串 goto 付费路**。
         * 失败判定：HTTP >= 300、或流的第一块就是 error、或非流响应里带 error 字段。
         */
        if (channel === 'auto' && opts.auto) {
          if (req.method === 'GET' && rest === '/v1/models') {
            send(res, 200, JSON.stringify({
              object: 'list',
              data: [{ id: 'auto', object: 'model', created: 0, owned_by: 'free-hub', name: '自动切换 · 哪家能用走哪家' }],
            }));
            return;
          }
          if (rest.endsWith('/chat/completions')) {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: Record<string, unknown> = {};
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              send(res, 400, JSON.stringify({ error: 'bad json' }));
              return;
            }
            const wantStream = body.stream === true;
            const tried: string[] = [];
            for (const cand of opts.auto.candidates()) {
              const t0 = Date.now();
              const payload = { ...body, model: cand.model };
              let r: Response | null = null;
              try {
                r = await fetch(upstream + '/chat/completions', {
                  method: 'POST',
                  headers: { ...auth, Accept: wantStream ? 'text/event-stream' : 'application/json' },
                  body: JSON.stringify(payload),
                  // 自动路由的每个候选**只给短超时**：挂住的渠道不能拖死整条链
                  signal: AbortSignal.timeout(15000),
                });
              } catch (err) {
                opts.auto.note(`${cand.path}|${cand.model}`, false, Date.now() - t0);
                tried.push(`${cand.label}: ${(err as Error)?.message || 'fetch failed'}`);
                continue;
              }
              if (!r.ok) {
                const txt = await r.text().catch(() => '');
                opts.auto.note(`${cand.path}|${cand.model}`, false, Date.now() - t0);
                tried.push(`${cand.label}: HTTP ${r.status} ${txt.slice(0, 80)}`);
                continue;
              }
              // ---- 流式：先看第一块是不是错误帧，再决定是否落笔 ----
              if (wantStream && r.body) {
                const reader = r.body.getReader();
                const first = await Promise.race([
                  reader.read(),
                  new Promise<{ done: true; value?: undefined }>((resolve) =>
                    setTimeout(() => resolve({ done: true }), 15000)
                  ),
                ]);
                if (first.done || !first.value) {
                  opts.auto.note(`${cand.path}|${cand.model}`, false, Date.now() - t0);
                  tried.push(`${cand.label}: 空流`);
                  continue;
                }
                const head = Buffer.from(first.value).toString('utf8');
                if (/"error"\s*:/.test(head)) {
                  opts.auto.note(`${cand.path}|${cand.model}`, false, Date.now() - t0);
                  tried.push(`${cand.label}: ${head.replace(/\s+/g, ' ').slice(0, 100)}`);
                  continue;
                }
                opts.auto.note(`${cand.path}|${cand.model}`, true, Date.now() - t0);
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'X-FreeHub-Channel': cand.path,
                });
                await pipeNormalizedSse(prependStream(first.value, reader), res);
                return;
              }
              // ---- 非流式 ----
              const text = await r.text();
              if (/"error"\s*:/.test(text) && !/"choices"\s*:/.test(text)) {
                opts.auto.note(`${cand.path}|${cand.model}`, false, Date.now() - t0);
                tried.push(`${cand.label}: ${text.replace(/\s+/g, ' ').slice(0, 100)}`);
                continue;
              }
              opts.auto.note(`${cand.path}|${cand.model}`, true, Date.now() - t0);
              send(res, 200, text, 'application/json');
              return;
            }
            opts.auto.note('auto', false, 0);
            send(res, 502, JSON.stringify({
              error: { message: '所有渠道都失败了：' + tried.join('；'), type: 'upstream_error' },
            }));
            return;
          }
          send(res, 404, JSON.stringify({ error: 'auto: only /v1/models and /v1/chat/completions' }));
          return;
        }

        // ① 模型清单：过滤 + 改 name
        if (req.method === 'GET' && rest === '/v1/models') {
          const r = await fetch(upstream + '/models', { headers: auth, signal: AbortSignal.timeout(15000) });
          const text = await r.text();
          if (!r.ok) {
            send(res, r.status, text);
            return;
          }
          const data = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
          const label = opts.labels[channel] || channel;
          const rows = (data.data || [])
            .filter((x) => String(x.id || '').startsWith(channel + '/'))
            .map((x) => ({ ...x, name: `${label} · ${String(x.name || x.id)}` }));
          send(res, 200, JSON.stringify({ object: 'list', data: rows }));
          return;
        }

        // ② 其它 /v1/* 请求：原样转发（含流式）
        if (rest.startsWith('/v1/')) {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = Buffer.concat(chunks);
          const headers: Record<string, string> = { ...auth };
          if (req.headers.accept) headers.Accept = String(req.headers.accept);
          const r = await fetch(upstream + rest.replace(/^\/v1/, ''), {
            method: req.method || 'POST',
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
            signal: AbortSignal.timeout(300000),
          });
          res.writeHead(r.status, {
            'Content-Type': r.headers.get('content-type') || 'application/json',
            'Cache-Control': 'no-cache',
          });
          if (!r.body) {
            res.end();
            return;
          }
          // 流式：Coo 的解析很严（tool_calls 必须带 index、finish_reason 必须单独一帧）。
          // 免费渠道经常不守规矩 → 这里统一整理后再吐给 Coo，否则她会「不回话」。
          const ctype = String(r.headers.get('content-type') || '');
          if (ctype.includes('text/event-stream')) {
            await pipeNormalizedSse(r.body, res);
            return;
          }
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) res.write(Buffer.from(value));
          }
          res.end();
          return;
        }
        send(res, 404, JSON.stringify({ error: 'not found' }));
      } catch (err) {
        send(res, 502, JSON.stringify({ error: (err as Error)?.message || String(err) }));
      }
    })();
  });

  server.listen(opts.port, '127.0.0.1');
  server.unref?.();
  return {
    port: opts.port,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}
