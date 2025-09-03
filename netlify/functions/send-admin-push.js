<script>
(() => {
  // ======== ENDPOINTS ========
  const FN_URL_PUSH = 'https://bechobazaar.netlify.app/.netlify/functions/send-admin-push';
  const FN_URL_LOGS = 'https://bechobazaar.netlify.app/.netlify/functions/list-admin-push-logs';

  // ======== UTILS ========
  const el  = (id) => document.getElementById(id);
  const set = (id, t) => { const n = el(id); if (n) n.innerHTML = t; };

  const getKey = () => sessionStorage.getItem('ADMIN_PUSH_KEY') || '';
  const setKey = (k) => sessionStorage.setItem('ADMIN_PUSH_KEY', k || '');

  const esc = (s) => String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-';

  function showToast(msg, isErr){
    const div = document.createElement('div');
    div.textContent = msg;
    div.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:9999;
      background:${isErr?'#fee2e2':'#ecfdf5'}; color:${isErr?'#991b1b':'#065f46'};
      border:1px solid ${isErr?'#fecaca':'#a7f3d0'}; padding:10px 12px; border-radius:10px; 
      box-shadow:0 8px 24px rgba(0,0,0,.12); max-width:80vw; line-height:1.2;
    `;
    document.body.appendChild(div);
    setTimeout(()=>div.remove(), 2500);
  }

  // ======== PUSH CENTER ========
  function readCommon() {
    return {
      title:  (el('pc_title')?.value || '').trim(),
      message:(el('pc_body')?.value  || '').trim(),
      link:   (el('pc_link')?.value  || 'https://bechobazzar.com/').trim(),
      image:  (el('pc_image')?.value || '').trim(),
    };
  }

  async function sendPush(payload) {
    const key = getKey();
    if (!key) { alert('Enter & save Admin Key first'); return; }
    try {
      const res = await fetch(FN_URL_PUSH, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'X-Admin-Key': key },
        body: JSON.stringify(payload)
      });
      const txt = await res.text().catch(()=>res.statusText);
      set('pc_out', `Status: ${res.status}<br>${esc(txt)}`);

      if (res.ok) {
        showToast('✅ Notification queued');
        await pcLoadHistory(true);   // send ke baad history refresh
      } else {
        showToast('⚠️ Failed: ' + txt, true);
      }
    } catch (e) {
      console.error('sendPush error', e);
      showToast('⚠️ Network error', true);
    }
  }

  function bindPushCenter() {
    if (bindPushCenter.done) return; bindPushCenter.done = true;

    el('pc_saveKey')?.addEventListener('click', () => {
      const k = (el('pc_adminKey')?.value || '').trim();
      if (!k) return alert('Enter Admin Key');
      setKey(k); showToast('🔐 Key saved for this tab');
    });
    el('pc_clearKey')?.addEventListener('click', () => {
      setKey(''); if (el('pc_adminKey')) el('pc_adminKey').value='';
      showToast('🧹 Key cleared');
    });

    el('pc_sendAll')?.addEventListener('click', async () => {
      const p = readCommon(); if (!p.title) return alert('Title required');
      await sendPush({ audience: 'all', ...p });
    });

    el('pc_sendUids')?.addEventListener('click', async () => {
      const p = readCommon(); if (!p.title) return alert('Title required');
      const raw = (el('pc_uids')?.value || '').trim();
      if (!raw) return alert('Add at least one UID');
      const uids = raw.split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
      await sendPush({ audience: 'uids', uids, ...p });
    });

    // History buttons (same tab me)
    el('pc_hist_refresh')?.addEventListener('click', ()=>pcLoadHistory(true));
    el('pc_hist_more')?.addEventListener('click', ()=>pcLoadHistory(false));

    // First load history on tab open
    if (!el('pc_hist_body')?.dataset.loaded) {
      pcLoadHistory(true);
      el('pc_hist_body').dataset.loaded = '1';
    }
  }

  // ======== HISTORY ========
  let nextBeforeMs = null;

  function rowHTML(item){
    const aLabel = item.audience === 'all' ? 'All' : `UIDs(${item.uids?.length||0})`;
    const link = item.link ? `<a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.link)}</a>` : '-';
    const detailsId = `det_${item.id}`;

    const detRows = (item.detailsSample||[]).map((d,i)=>`
      <tr>
        <td style="padding:6px 8px;border-top:1px dashed #eee;">${i+1}</td>
        <td style="padding:6px 8px;border-top:1px dashed #eee;">${d.ok ? 'Delivered' : 'Failed'}</td>
        <td style="padding:6px 8px;border-top:1px dashed #eee;">${esc(d.code||'')}</td>
        <td style="padding:6px 8px;border-top:1px dashed #eee;"><code style="font-size:12px">${esc(d.token||'')}</code></td>
      </tr>
    `).join('');

    const detailsBox = `
      <div id="${detailsId}" style="display:none;background:#fafafa;border:1px solid #eee;border-radius:8px;margin-top:8px;padding:8px;">
        <div style="font-weight:600;margin-bottom:6px;">Sample tokens (${(item.detailsSample||[]).length})</div>
        ${detRows
          ? `<div style="overflow:auto">
               <table style="width:100%;border-collapse:collapse;font-size:13px;">
                 <thead>
                   <tr>
                     <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;">#</th>
                     <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;">Status</th>
                     <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;">Code</th>
                     <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;">Token</th>
                   </tr>
                 </thead>
                 <tbody>${detRows}</tbody>
               </table>
             </div>`
          : `<div style="color:#666;">No sample details.</div>`
        }
      </div>`;

    const full = esc(item.message||'');
    const short = full.length > 60 ? (full.slice(0,60)+'…') : full;

    return `
      <tr>
        <td style="padding:10px;border-top:1px solid #f1f5f9;">${fmtDate(item.createdAtMs)}</td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;">
          <div style="font-weight:600">${esc(item.title||'-')}</div>
          <div title="${full}" style="color:#475569;font-size:12px;margin-top:2px;">
            ${short || '&nbsp;'}
          </div>
        </td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;">${aLabel}</td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;">${item.sent}</td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;">${item.failed}</td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;">${item.tokens}</td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;">${item.removedBadTokens || 0}</td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${link}</td>
        <td style="padding:10px;border-top:1px solid #f1f5f9;">
          <button class="btn" data-toggle="${detailsId}">View</button>
        </td>
      </tr>
      <tr><td colspan="9" style="padding:0 10px 10px 10px;">${detailsBox}</td></tr>
    `;
  }

  async function pcLoadHistory(reset){
    const key = getKey();
    if (!key) { alert('Enter & save Admin Key'); return; }

    if (reset) {
      nextBeforeMs = null;
      const tb = el('pc_hist_body'); if (tb) tb.innerHTML = '';
    }

    try {
      const res = await fetch(FN_URL_LOGS, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'X-Admin-Key': key },
        body: JSON.stringify({ limit: 20, beforeMs: nextBeforeMs || undefined })
      });
      if (!res.ok) {
        console.warn('history load failed', await res.text().catch(()=>res.statusText));
        return;
      }
      const json = await res.json();
      const rows = (json.items || []).map(rowHTML).join('');
      el('pc_hist_body')?.insertAdjacentHTML('beforeend', rows);
      nextBeforeMs = json.nextBeforeMs || null;

      // bind toggles for newly added rows
      document.querySelectorAll('#pc_hist_table [data-toggle]').forEach(btn=>{
        btn.onclick = () => {
          const id = btn.getAttribute('data-toggle');
          const box = document.getElementById(id);
          if (!box) return;
          const show = box.style.display === 'none';
          box.style.display = show ? '' : 'none';
          btn.textContent = show ? 'Hide' : 'View';
        };
      });
    } catch (e) {
      console.error('pcLoadHistory error', e);
    }
  }

  // expose (agar aap kahin aur se call karna chaho)
  window.pcLoadHistory = pcLoadHistory;

  // Tab open hone par bind
  document.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-tab]');
    if (!li) return;
    if (li.getAttribute('data-tab') === 'pushCenterTab') bindPushCenter();
  });

  // Agar default se visible hai:
  if (document.getElementById('pushCenterTab')?.style.display !== 'none') bindPushCenter();
})();
</script>
