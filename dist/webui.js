/**
 * 免费端点台 · 面板（浏览器端）v0.2
 *
 * 契约：默认导出 `{ panels: { <panelId>: { mount(ctx) } } }`；只往 ctx.root 写 DOM；
 * 数据一律走 ctx.invoke(method, args)。无框架、无构建。
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

const TONE = {
  ok: '#2e9e5b',
  throttled: '#c98a12',
  'region-blocked': '#b23c3c',
  error: '#b23c3c',
};

function money(v) {
  if (typeof v !== 'number') return '';
  return v >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'K' : String(v);
}

const panel = {
  async mount(ctx) {
    const root = el('div', { class: 'fh' });
    ctx.root.append(root);

    const head = el('div', { class: 'fh-head' });
    const guide = el('div', { class: 'fh-guide' });
    const stats = el('div', { class: 'fh-stats' });
    const reco = el('div', { class: 'fh-reco-wrap' });
    const grid = el('div', { class: 'fh-grid' });
    const foot = el('div', { class: 'fh-foot' });
    root.append(head, guide, stats, reco, grid, foot);

    const btnRefresh = el('button', { class: 'fh-btn', text: '刷新余额' });
    const btnConnect = el('button', { class: 'fh-btn fh-btn-main', text: '接入转发端口' });
    const hint = el('span', { class: 'fh-hint' });
    head.append(btnRefresh, btnConnect, hint);

    let busy = false;

    /** 渠道推荐表（推荐模型 + 实测耗时 + 「用这家」按钮） */
    const renderRecommend = (d) => {
      const box = el('div', { class: 'fh-reco' });
      const rows = d.recommend || [];
      if (!rows.length) return box;
      const title = el('div', { class: 'fh-guide-title' }, [
        document.createTextNode('渠道推荐（实测：能出字 + Coo 能解析工具流） '),
      ]);
      const btnRetest = el('button', { class: 'fh-btn', text: '重新测速' });
      btnRetest.onclick = () => {
        if (busy) return;
        busy = true;
        hint.textContent = '测速中…（每家要真发一次请求）';
        ctx
          .invoke('retest', [])
          .then((r) => {
            const map = new Map((r.rows || []).map((x) => [x.provider, x]));
            for (const row of box.querySelectorAll('.fh-reco-row')) {
              const name = row.dataset.provider;
              const hit = map.get(name);
              const cell = row.querySelector('.fh-reco-ms');
              if (cell && hit) {
                cell.textContent = hit.ok ? hit.ms + 'ms' : '失败：' + (hit.error || '');
                cell.className = 'fh-reco-ms' + (hit.ok ? '' : ' fh-warn');
              }
            }
            hint.textContent = '测速完成';
          })
          .catch((err) => {
            hint.textContent = '测速失败：' + (err && err.message ? err.message : String(err));
          })
          .finally(() => {
            busy = false;
          });
      };
      title.append(btnRetest);
      box.append(title);

      for (const r of rows) {
        const row = el('div', { class: 'fh-reco-row', 'data-provider': r.provider });
        row.append(
          el('span', { class: 'fh-reco-name', text: r.label }),
          el('span', { class: 'fh-reco-model', text: r.model }),
          el('span', { class: 'fh-reco-ms', text: r.ms + 'ms' }),
          el('button', {
            class: 'fh-btn fh-btn-main',
            text: '用这家',
            onclick: () => {
              hint.textContent = '切换中…';
              ctx
                .invoke('switch', [r.path])
                .then((x) => {
                  hint.textContent = (x && x.text) || '已切换';
                })
                .catch((err) => {
                  hint.textContent = '切换失败：' + (err && err.message ? err.message : String(err));
                });
            },
          })
        );
        if (r.note) row.title = r.note;
        box.append(row);
      }
      return box;
    };

    const draw = (d) => {
      const acc = d.accounts || { total: 0, channels: 0, ofAll: 0 };

      // 前置自检：没装 OFM / 没开中继 / 没密钥 / 没登录渠道 → 把「差哪一步」直接摆出来
      const pre = d.precheck;
      guide.replaceChildren();
      guide.className = 'fh-guide' + (pre && pre.ready ? ' fh-guide-ok' : '');
      if (pre && !pre.ready) {
        guide.append(el('div', { class: 'fh-guide-title', text: '还差这几步才能用免费额度：' }));
        for (const s of pre.steps) {
          const row = el('div', { class: 'fh-guide-row' });
          row.append(el('span', { class: 'fh-guide-mark', text: s.ok ? '✅' : '⬜' }));
          if (s.link) {
            row.append(el('a', { href: s.link, target: '_blank', rel: 'noreferrer', text: s.text }));
          } else {
            row.append(el('span', { text: s.text }));
          }
          guide.append(row);
        }
      } else if (pre && pre.ready) {
        guide.append(el('div', { class: 'fh-guide-title', text: '✅ 前置齐了，点「接入转发端口」就能在模型选择器里用它' }));
      }

      stats.replaceChildren(
        el('span', { class: 'fh-pill', text: `账号 ${acc.total}` }),
        el('span', { class: 'fh-pill', text: `已接入 ${acc.channels}/${acc.ofAll} 家` }),
        el('span', { class: 'fh-pill', text: `免费车道 ${(d.lanes || []).length}` }),
        el('span', { class: 'fh-pill', text: `今日 ${money(d.ofm && d.ofm.todayTokens)} tokens` }),
        el('span', { class: 'fh-pill' + (d.reachable ? '' : ' fh-pill-bad'), text: d.reachable ? '转发端口通' : '转发端口不通' })
      );

      reco.replaceChildren(renderRecommend(d));

      grid.replaceChildren();
      for (const ch of d.channelSummary || []) {
        const connected = ch.accounts > 0;
        const card = el('div', { class: 'fh-card' + (connected ? '' : ' fh-card-off') });
        const top = el('div', { class: 'fh-card-top' }, [
          el('span', { class: 'fh-dot', style: `background:${connected ? TONE.ok : '#999'}` }),
          el('b', { text: ch.label }),
          el('span', { class: 'fh-vendor', text: ch.vendor }),
          el('span', { class: 'fh-state', text: connected ? '已接入' : '未接入' }),
        ]);
        const meta = el('div', { class: 'fh-meta' });
        meta.append(el('span', { text: `账号 ${ch.accounts}` }));
        if (ch.balance && typeof ch.balance.total === 'number') {
          meta.append(el('span', { text: `剩余积分 ${money(ch.balance.total)}` }));
        } else if (ch.balance && ch.balance.error) {
          meta.append(el('span', { class: 'fh-warn', text: `余额查不到（${ch.balance.error}）` }));
        }
        const actions = el('div', { class: 'fh-actions' });
        const mkBtn = (label, fn, main) =>
          el('button', { class: 'fh-btn' + (main ? ' fh-btn-main' : ''), text: label, onclick: fn });
        actions.append(
          mkBtn('刷新余额', () => reload(false)),
          mkBtn(ch.claim === 'none' ? '每日自动到账' : '去 OFM 领取', () => {
            hint.textContent = ch.claim === 'none'
              ? `${ch.label}：服务端每天自动发，没有签到端点`
              : `${ch.label}：领取请在 OFM 的「白嫖模型接入」页点（本插件不做登录与领取）`;
          })
        );
        card.append(top, meta, actions);
        if (ch.note) card.append(el('div', { class: 'fh-detail', text: ch.note }));
        grid.append(card);
      }

      const chans = d.channels || {};
      const names = Object.keys(chans);
      if (names.length) {
        const chips = el('div', { class: 'fh-chips' });
        for (const name of names) {
          const st = String((chans[name] || {}).state || '?');
          chips.append(el('span', { class: 'fh-chip' }, [
            el('span', { class: 'fh-dot', style: `background:${TONE[st] || '#888'}` }),
            document.createTextNode(` ${name}:${st}`),
          ]));
        }
        grid.append(el('div', { class: 'fh-sub', text: `转发端口渠道状态（${names.length} 家）` }), chips);
      }
    };

    const apply = async (method) => {
      if (busy) return;
      busy = true;
      hint.textContent = '加载中…';
      try {
        draw(await ctx.invoke(method, []));
        hint.textContent = '';
      } catch (err) {
        hint.textContent = '失败：' + (err && err.message ? err.message : String(err));
      } finally {
        busy = false;
      }
    };
    const reload = () => apply('refresh');

    btnRefresh.onclick = () => reload();
    btnConnect.onclick = () => {
      if (busy) return;
      busy = true;
      hint.textContent = '接入中…';
      ctx
        .invoke('connect', [])
        .then((r) => {
          hint.textContent = (r && r.text) || '已请求接入';
        })
        .catch((err) => {
          hint.textContent = '接入失败：' + (err && err.message ? err.message : String(err));
        })
        .finally(() => {
          busy = false;
        });
    };

    foot.append(
      el('div', {
        class: 'fh-sub',
        text: '只读：账号与余额读自 DSH 凭据库，转发端口只做探测；登录/领取仍在 OFM 里操作，本插件不保存任何凭据。',
      })
    );

    await apply('status');
    return {
      dispose() {
        root.remove();
      },
    };
  },
};

export default { panels: { status: panel } };
