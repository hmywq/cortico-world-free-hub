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
    const btnOfm = el('button', { class: 'fh-btn', text: '去 OFM 签到' });
    const hint = el('span', { class: 'fh-hint' });
    head.append(btnRefresh, btnConnect, btnOfm, hint);

    let busy = false;

    /** 按钮忙碌动画：转圈 + 呼吸；结束后 1.2 秒内给绿/红反馈再复原 */
    const spin = (btn, state) => {
      if (!btn) return;
      if (state === 'on') {
        btn.classList.remove('fh-done', 'fh-fail');
        btn.classList.add('fh-busy');
        btn.disabled = true;
        return;
      }
      btn.classList.remove('fh-busy');
      btn.disabled = false;
      if (state === 'ok' || state === 'fail') {
        btn.classList.add(state === 'ok' ? 'fh-done' : 'fh-fail');
        const t = btn.textContent;
        btn.textContent = state === 'ok' ? '✓ ' + t.replace(/^[✓✗]\s*/, '') : '✗ ' + t.replace(/^[✓✗]\s*/, '');
        setTimeout(() => {
          btn.classList.remove('fh-done', 'fh-fail');
          btn.textContent = t.replace(/^[✓✗]\s*/, '');
        }, 1200);
      }
    };

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
        spin(btnRetest, 'on');
        hint.textContent = '测速中…（每家真发一次，极小量 max_tokens=16）';
        // ① 先把整张表清空成 loading，避免「数字在跳、顺序不变」的假象
        for (const row of box.querySelectorAll('.fh-reco-row')) row.remove();
        const loading = el('div', { class: 'fh-reco-loading' }, [
          el('span', { class: 'fh-spinner' }),
          document.createTextNode(' 正在逐个测速，稍等一下…'),
        ]);
        box.append(loading);
        ctx
          .invoke('retest', [])
          .then((r) => {
            const okCount = (r.rows || []).filter((x) => x.ok).length;
            hint.textContent = `测速完成：${okCount}/${(r.rows || []).length} 家可用（已按速度重排，失败的沉底）`;
            spin(btnRetest, okCount > 0 ? 'ok' : 'fail');
            // ② 拉一次最新状态 → 整页重画（后端已按健康度排序）
            return ctx.invoke('status', []).then((nd) => draw(nd));
          })
          .catch((err) => {
            hint.textContent = '测速失败：' + (err && err.message ? err.message : String(err));
            spin(btnRetest, 'fail');
            return ctx.invoke('status', []).then((nd) => draw(nd)).catch(() => undefined);
          })
          .finally(() => {
            busy = false;
          });
      };
      title.append(btnRetest);
      box.append(title);

      for (const r of rows) {
        const row = el('div', { class: 'fh-reco-row', 'data-provider': r.provider });
        const msText =
          r.path === 'auto'
            ? '—'
            : r.lastOk === true
              ? (r.lastMs || 0) + 'ms'
              : r.lastOk === false
                ? '失败'
                : '未测';
        if (r.lastOk === false) row.className = 'fh-reco-row fh-reco-bad';
        row.append(
          el('span', { class: 'fh-reco-name', text: r.label }),
          el('span', { class: 'fh-reco-model', text: r.model }),
          el('span', { class: 'fh-reco-ms' + (r.lastOk === false ? ' fh-warn' : ''), text: msText }),
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
        } else if (ch.balanceSupported === false) {
          meta.append(el('span', { class: 'fh-dim', text: '余额：该渠道无接口（去 OFM 里看）' }));
        }
        const actions = el('div', { class: 'fh-actions' });
        // ① 刷新余额：只有接了余额接口的渠道才可点；没有就明说，不做假按钮
        if (ch.balanceSupported) {
          const b = el('button', { class: 'fh-btn', text: '刷新余额' });
          b.onclick = () => {
            spin(b, 'on');
            ctx
              .invoke('status', [])
              .then((nd) => {
                draw(nd);
                const row = (nd.channelSummary || []).find((x) => x.id === ch.id);
                const ok = row && row.balance && typeof row.balance.total === 'number';
                hint.textContent = ok
                  ? `${ch.label}：当前 ${row.balance.total} 积分`
                  : `${ch.label}：查询失败（${(row && row.balance && row.balance.error) || '无返回'}）`;
                spin(b, ok ? 'ok' : 'fail');
              })
              .catch(() => spin(b, 'fail'));
          };
          actions.append(b);
        } else {
          actions.append(
            el('button', { class: 'fh-btn', text: '无余额接口', disabled: 'disabled', title: '这家没有公开的余额查询接口，去 OFM 或官网看' })
          );
        }
        // ② 领取：只能在 OFM 界面里点，这里只显示状态、不做假动作
        const claimLabel = ch.claim === 'none' ? '每日自动到账' : '去 OFM 领取';
        actions.append(
          el('button', {
            class: 'fh-btn',
            text: claimLabel,
            disabled: 'disabled',
            title:
              ch.claim === 'none'
                ? '该渠道每日额度由服务端自动发放，没有签到端点'
                : '领取要在 OFM 的「白嫖模型接入」页点；本插件不实现登录与领取',
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

    btnOfm.onclick = () => {
      hint.textContent = '正在把 DSH 切到前台…';
      ctx
        .invoke('openOfm', [])
        .then((r) => {
          hint.textContent = (r && r.text) || '请手动打开 DSH 的 OFM 页面';
        })
        .catch((err) => {
          hint.textContent = '打开失败：' + (err && err.message ? err.message : String(err));
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
