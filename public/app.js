(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const screen = $('#screen'), tag = $('#sessionTag'), tipEl = $('#tip');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let pid = (location.hash.replace('#', '') || localStorage.getItem('pid') || '').toUpperCase();
  let state = null, pinned = null;

  async function api(path, body) {
    const res = await fetch('/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid, ...body }) } : undefined);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('Request failed (' + res.status + ')'));
    return j;
  }
  async function load() {
    if (!pid) return renderStart();
    try { state = await api('state?pid=' + encodeURIComponent(pid)); localStorage.setItem('pid', pid); render(); }
    catch (e) { renderStart(e.message); }
  }
  function setScreen(html) { screen.innerHTML = html; hideTip(); window.scrollTo({ top: 0 }); }
  function err(msg) { const e = $('#err'); if (e) e.textContent = msg || ''; }

  // ------------------------------------------------------------ helpers
  function scale(name, n, left, right) {
    let s = '';
    for (let i = 1; i <= n; i++) s += `<label><input type="radio" name="${name}" value="${i}">${i}</label>`;
    return `<div class="scale ${n === 5 ? 'five' : n === 6 ? 'six' : ''}">${s}</div><div class="scale-ends"><span>${left}</span><span>${right}</span></div>`;
  }
  function chips(name, options) { return `<div class="choices">${options.map(o => `<label class="chip"><input type="radio" name="${name}" value="${esc(o.v)}">${esc(o.t)}</label>`).join('')}</div>`; }
  const val = name => { const el = screen.querySelector(`input[name="${name}"]:checked, input[type=text][name="${name}"], textarea[name="${name}"]`); return el ? el.value.trim() : ''; };
  function progress(label, pct) { return `<div class="progress"><span>${label}</span><div class="bar"><span style="width:${pct}%"></span></div></div>`; }

  function sentencesHtml(sentences, opts) {
    const o = opts || {};
    return sentences.map((s, k) => {
      if (o.selectable) return `<mark class="sel" data-k="${k}">${esc(s.text)}</mark> `;
      if (s.mem && s.mem.length) return `<mark class="mem" tabindex="0" data-mem="${s.mem.join(',')}">${esc(s.text)}</mark> `;
      return esc(s.text) + ' ';
    }).join('');
  }
  function answerHtml(turn, version) {
    return `<div class="msg-ai" data-turn="${turn.i}"><span class="ai-label">A</span><p>${sentencesHtml(turn.sentences)}</p></div>`;
  }

  // ------------------------------------------------------------ word-by-word reveal of a new answer
  // The finished answer is shown progressively, at about the pace a streaming assistant writes. A highlighted
  // sentence appears already marked, so nothing is painted afterwards; the effect is identical in both versions.
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function answerShell(turn) { return `<div class="msg-ai" data-turn="${turn.i}"><span class="ai-label">A</span><p></p></div>`; }
  async function revealAnswer(el, turn) {
    const p = el.querySelector('p');
    if (reduceMotion) { p.innerHTML = sentencesHtml(turn.sentences); return 0; }
    // Every word gets a due time in advance (about 60 words a second, with a short pause after each sentence), and each
    // tick appends whatever is due. The duration is therefore the same on a slow device or in a background tab.
    const steps = []; let at = 0;
    for (const s of turn.sentences) {
      let holder = null;
      if (s.mem && s.mem.length) { holder = document.createElement('mark'); holder.className = 'mem'; holder.tabIndex = 0; holder.setAttribute('data-mem', s.mem.join(',')); }
      const words = s.text.split(/\s+/).filter(Boolean);
      words.forEach((w, i) => { at += 12 + Math.random() * 10; steps.push({ holder, text: w + (i < words.length - 1 ? ' ' : ''), at, first: holder && i === 0 }); });
      at += 50; steps.push({ holder: null, text: ' ', at });
    }
    const caret = document.createElement('span'); caret.className = 'caret'; p.appendChild(caret);
    const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
    const t0 = Date.now(); let k = 0;
    while (k < steps.length) {
      const elapsed = Date.now() - t0, follow = nearBottom();
      while (k < steps.length && steps[k].at <= elapsed) {
        const st = steps[k++];
        if (st.first) p.insertBefore(st.holder, caret);
        const node = document.createTextNode(st.text);
        if (st.holder) st.holder.appendChild(node); else p.insertBefore(node, caret);
      }
      if (follow) window.scrollTo(0, document.documentElement.scrollHeight);
      if (k < steps.length) await sleep(Math.max(8, Math.min(40, steps[k].at - (Date.now() - t0))));
    }
    caret.remove();
    return Date.now() - t0;
  }

  // ------------------------------------------------------------ tooltip for highlights
  function showTip(mark) {
    const ids = (mark.getAttribute('data-mem') || '').split(',').filter(Boolean);
    const items = ids.map(id => state.memMap && state.memMap[id]).filter(Boolean);
    if (!items.length) return;
    tipEl.innerHTML = `<b>Used your memory</b>` + items.map(m => `<i>“${esc(m.text)}”</i><small>${esc(m.source)}</small>`).join('');
    tipEl.hidden = false;
    const r = mark.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + window.scrollX), window.scrollX + window.innerWidth - 346);
    tipEl.style.left = left + 'px'; tipEl.style.top = (r.bottom + window.scrollY + 8) + 'px';
    log('hover', { mem: ids, turn: mark.closest('[data-turn]')?.getAttribute('data-turn') });
  }
  function hideTip() { tipEl.hidden = true; }
  document.addEventListener('mouseover', e => { const m = e.target.closest && e.target.closest('mark.mem'); if (m && !pinned) showTip(m); });
  document.addEventListener('mouseout', e => { const m = e.target.closest && e.target.closest('mark.mem'); if (m && !pinned) hideTip(); });
  document.addEventListener('click', e => {
    const m = e.target.closest && e.target.closest('mark.mem');
    if (m) { if (pinned === m) { pinned = null; hideTip(); } else { pinned = m; showTip(m); } return; }
    if (!e.target.closest('.tip')) { pinned = null; hideTip(); }
  });
  const hoverStart = {};
  document.addEventListener('mouseover', e => { const m = e.target.closest && e.target.closest('mark.mem'); if (m) hoverStart[m.textContent] = Date.now(); });
  document.addEventListener('mouseout', e => { const m = e.target.closest && e.target.closest('mark.mem'); if (m && hoverStart[m.textContent]) { log('hoverEnd', { ms: Date.now() - hoverStart[m.textContent], turn: m.closest('[data-turn]')?.getAttribute('data-turn') }); delete hoverStart[m.textContent]; } });
  function log(type, data) { if (!pid) return; fetch('/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid, type, stage: state && state.stage, b: state && state.b, c: state && state.c, ...data }) }).catch(() => {}); }

  // ------------------------------------------------------------ screens
  function renderStart(msg) {
    tag.textContent = '';
    setScreen(`<h1>Welcome</h1><p class="lede">Please enter the participant code the researcher gave you.</p>
      <div class="composer"><input type="text" id="code" placeholder="For example P1" value="${esc(pid)}"><button class="btn" id="go">Continue</button></div>
      <p class="err" id="err">${esc(msg || '')}</p>`);
    $('#go').onclick = () => { pid = $('#code').value.trim().toUpperCase(); location.hash = pid; load(); };
    $('#code').onkeydown = e => { if (e.key === 'Enter') $('#go').click(); };
  }

  function render() {
    const st = state.stage;
    tag.textContent = st === 's1' ? 'Session 1 of 2' : (st === 'done' || st === 'ineligible' || st === 'thanks') ? '' : 'Session 2 of 2';
    const demo = state.demo ? `<div class="demo">Demo mode: no API key is set on the server, so the assistant's answers are canned examples. Data from demo mode must not be used.</div>` : '';
    ({ s1: renderS1, ineligible: renderIneligible, thanks: renderThanks, consent: renderConsent, memory: renderMemory, tutorial: renderChat, chat: renderChat, writeup: renderWriteup, trust: renderTrust, blockRatings: renderBlockRatings, audit: renderAudit, comparison: renderComparison, purpose: renderPurpose, interview: renderInterview, debrief: renderDebrief, done: renderDone })[st](demo);
  }

  function renderS1(demo) {
    const f = state.form;
    let html = demo + `<h1>Tell us about your views and preferences</h1><p class="lede">There are no right answers. The assistant you will use in the next session will remember what you say here. About 10 minutes.</p>`;
    html += `<h3>Opinions</h3><p class="muted">For each question, say how far you disagree or agree, then how important the issue is to you.</p>`;
    f.opinion.forEach((t, i) => {
      html += `<div class="q"><span class="q-kind">Opinion ${i + 1} of 8</span><p class="q-label">${esc(t.question)}</p>${scale('op-' + t.id, 6, 'Strongly disagree', 'Strongly agree')}
        <p class="q-label" style="margin-top:10px">How important is this issue to you?</p>${scale('imp-' + t.id, 5, 'Not at all', 'Extremely')}</div>`;
    });
    html += `<h3>Preferences</h3>`;
    f.preference.forEach((t, i) => {
      html += `<div class="q"><span class="q-kind">Preference ${i + 1} of 8</span><p class="q-label">${esc(t.item)}</p>${chips('pref-' + t.id, [{ v: 'a', t: t.a }, { v: 'b', t: t.b }])}
        <p class="q-label" style="margin-top:10px">How strongly?</p>${chips('str-' + t.id, [{ v: 'slightly', t: 'Slightly' }, { v: 'moderately', t: 'Moderately' }, { v: 'strongly', t: 'Strongly' }])}
        <p class="q-label" style="margin-top:10px">${esc(t.face)}</p>${chips('face-' + t.id, [{ v: 'yes', t: 'Yes' }, { v: 'no', t: 'No' }])}</div>`;
    });
    html += `<h3>About you</h3>`;
    f.background.forEach((b, i) => {
      html += `<div class="q"><span class="q-kind">Background ${i + 1} of 8</span><p class="q-label">${esc(b.q)}</p>` + (b.type === 'text' ? `<input type="text" name="bg-${b.id}" maxlength="60">` : chips('bg-' + b.id, b.choices.map(c => ({ v: c, t: c })))) + `</div>`;
    });
    html += `<div class="q"><p class="q-label">${esc(f.aiUse.freq.q)}</p>${chips('ai-freq', f.aiUse.freq.choices.map(c => ({ v: c, t: c })))}<p class="q-label" style="margin-top:10px">${esc(f.aiUse.memory.q)}</p>${chips('ai-mem', f.aiUse.memory.choices.map(c => ({ v: c, t: c })))}</div>`;
    html += `<div class="actions"><span class="err" id="err"></span><button class="btn" id="submit">Submit</button></div>`;
    setScreen(html);
    $('#submit').onclick = async () => {
      const answers = { opinion: {}, preference: {}, background: {}, ai: {} };
      for (const t of f.opinion) { const r = val('op-' + t.id), imp = val('imp-' + t.id); if (!r || !imp) return err('Please answer every opinion question, including importance.'); answers.opinion[t.id] = { rating: +r, importance: +imp }; }
      for (const t of f.preference) { const c = val('pref-' + t.id), s = val('str-' + t.id), fc = val('face-' + t.id); if (!c || !s || !fc) return err('Please answer every preference question.'); answers.preference[t.id] = { choice: c, strength: s, face: fc }; }
      for (const b of f.background) { const v = val('bg-' + b.id); if (!v) return err('Please answer every background question.'); answers.background[b.id] = v; }
      answers.ai = { freq: val('ai-freq'), memory: val('ai-mem') }; if (!answers.ai.freq || !answers.ai.memory) return err('Please answer the two questions about AI use.');
      try { $('#submit').disabled = true; state = await api('session1', { answers }); render(); } catch (e) { err(e.message); $('#submit').disabled = false; }
    };
  }

  function renderIneligible(demo) {
    setScreen(demo + `<h1>Thank you</h1><p>Your answers are saved. The researcher will be in touch about Session 2.</p>`);
  }
  function renderThanks(demo) {
    setScreen(demo + `<h1>Thank you</h1><p>Your answers are saved. See you at Session 2; the researcher will open it for you on the day.</p>`);
  }

  function renderConsent(demo) {
    setScreen(demo + `<h1>Welcome back</h1><p class="lede">This session takes up to 90 minutes. You will chat with an assistant that remembers what you told us in Session 1, use it for a few real tasks, and answer some questions about it.</p>
      <h3>Before we start</h3>
      <p>The session is audio- and screen-recorded so that your comments can be transcribed. Recordings are stored on an encrypted drive and deleted after the course. You can stop at any time, and you can ask for your data to be removed at the end of the session or later.</p>
      <p>We will ask you to <b>think aloud</b> while you use the assistant: say what you are reading and what you make of it, as it comes to you. The researcher will do a one-minute practice with you first.</p>
      <label class="chip"><input type="checkbox" id="rec"> I agree to take part and to be recorded</label>
      <div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Start</button></div>`);
    $('#go').onclick = async () => { if (!$('#rec').checked) return err('Please tick the box to continue.'); try { state = await api('consent', { recording: true }); render(); } catch (e) { err(e.message); } };
  }

  function renderMemory(demo) {
    const groups = { background: 'Background', opinion: 'Opinions', preference: 'Preferences' };
    let html = demo + `<h1>Here is what I remember about you</h1><p class="lede">I will use this to tailor my answers today. Mark anything that is not right.</p><div class="mem-grid">`;
    for (const k of Object.keys(groups)) {
      html += `<div class="mem-col"><h3>${groups[k]}</h3>`;
      state.memory.filter(m => m.kind === k).forEach(m => { html += `<div class="mem-item">${esc(m.text)}<div class="yn"><label><input type="radio" name="m-${m.id}" value="ok" checked> Correct</label><label><input type="radio" name="m-${m.id}" value="wrong"> Not quite</label></div></div>`; });
      html += `</div>`;
    }
    html += `</div><div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Start</button></div>`;
    setScreen(html);
    $('#go').onclick = async () => { const wrong = state.memory.filter(m => val('m-' + m.id) === 'wrong').map(m => m.id); try { state = await api('memory-review', { wrong }); render(); } catch (e) { err(e.message); } };
  }

  function renderChat(demo) {
    const conv = state.conv, isTut = state.stage === 'tutorial', hl = state.version === 'hl';
    const n = conv.turns.length;
    const label = isTut ? 'Practice' : (conv.kind === 'opinion' ? 'Task 1 of 2: a recommendation' : 'Task 2 of 2: a plan');
    const blockLabel = isTut ? '' : ` · Part ${state.b + 1} of 2`;
    let html = demo + `<h2>${isTut ? 'Try the assistant' : 'Ask the assistant'}</h2>${progress(label + blockLabel, isTut ? 5 : (state.b * 50 + state.c * 25 + 12))}
      <div class="scenario"><b>Your task:</b> ${esc(conv.scenario)}${isTut ? '' : ' <b>Ask at least four questions.</b> Think aloud as you go.'}</div>
      <div class="thread" id="thread">` + conv.turns.map(t => `<div class="msg-user">${esc(t.user)}</div>${answerHtml(t, state.version)}`).join('') + `</div>`;
    if (hl) html += `<div class="legend"><span class="swatch"></span><span>Highlighted sentences are where I used something I remember about you. Hover over or tap one to see which memory it used.</span></div>`;
    html += `<div class="composer"><input type="text" id="msg" placeholder="Type your question…" maxlength="1000" autocomplete="off"><button class="btn" id="send">Send</button></div>
      <div class="counter" id="counter"></div>
      <div class="actions"><span class="err" id="err"></span>${isTut ? `<button class="btn ghost" id="tutdone">I've got it, start the study</button>` : `<button class="btn" id="finish" ${n < 4 ? 'disabled' : ''}>Finish and write your ${conv.kind === 'opinion' ? 'message' : 'plan'}</button>`}</div>`;
    setScreen(html);
    if (n) log('threadShown', { turns: n }); // answers shown at once (for example after a reload), so every stored answer is traceably seen
    // While a question is on its way, and while its answer is being revealed, Finish (and the practice button) stay off:
    // otherwise the conversation could close on an answer the participant never read, which the audit would then score.
    let busy = false;
    const counter = () => { const c = state.conv.turns.length; $('#counter').textContent = isTut ? '' : (c < 4 ? `${c} of at least 4 questions asked` : `${c} questions asked. You can keep going or finish.`); const f = $('#finish'); if (f) f.disabled = busy || c < 4; const t = $('#tutdone'); if (t) t.disabled = busy; };
    counter();
    const send = async () => {
      const text = $('#msg').value.trim(); if (!text || busy) return;
      busy = true; counter();
      $('#send').disabled = true; $('#msg').disabled = true; err('');
      const thread = $('#thread');
      thread.insertAdjacentHTML('beforeend', `<div class="msg-user" id="pending-user">${esc(text)}</div><div class="msg-ai pending" id="pending"><span class="ai-label">A</span><p>Thinking…</p></div>`);
      thread.lastElementChild.scrollIntoView({ block: 'end' });
      const slow = setTimeout(() => { const pe = $('#pending p'); if (pe) pe.textContent = 'Still working on it. This can take up to a minute.'; }, 15000);
      try {
        const r = await api('chat', { message: text });
        clearTimeout(slow);
        state.conv.turns.push(r.turn);
        $('#pending').outerHTML = answerShell(r.turn); const ub = $('#pending-user'); if (ub) ub.removeAttribute('id');
        $('#msg').value = ''; log('answerShown', { turn: r.turn.i });
        const ms = await revealAnswer(thread.querySelector(`.msg-ai[data-turn="${r.turn.i}"]`), r.turn);
        log('answerRevealed', { turn: r.turn.i, ms });
      } catch (e) {
        clearTimeout(slow);
        const pe = $('#pending'); if (pe) pe.remove(); const ub = $('#pending-user'); if (ub) ub.remove(); err(e.message);
        // The answer may have been stored even though this request failed (a dropped connection, for example): show it rather than lose it.
        try { const s = await api('state?pid=' + encodeURIComponent(pid)); if (s.stage === state.stage && s.conv && s.conv.turns.length > state.conv.turns.length) { state = s; render(); return; } } catch (e2) { /* keep the error shown */ }
      }
      busy = false; counter();
      $('#send').disabled = false; $('#msg').disabled = false; $('#msg').focus();
    };
    $('#send').onclick = send; $('#msg').onkeydown = e => { if (e.key === 'Enter') send(); };
    if ($('#finish')) $('#finish').onclick = async () => {
      if (busy) return;
      try { state = await api('finish', { seen: state.conv.turns.length }); render(); }
      catch (e) { err(e.message); if (/just arrived/.test(e.message)) setTimeout(load, 1500); } // reload to show the answer that came in
    };
    if ($('#tutdone')) $('#tutdone').onclick = async () => { if (busy) return; try { state = await api('tutorial-done', {}); render(); } catch (e) { err(e.message); } };
    $('#msg').focus();
  }

  function renderWriteup(demo) {
    const conv = state.conv, op = conv.kind === 'opinion';
    setScreen(demo + `<h2>${op ? 'Write your message' : 'Write your plan'}</h2>
      <div class="scenario"><b>Your task:</b> ${esc(conv.scenario)}</div>
      <p class="muted">${op ? 'Three to four sentences: what you recommend and why.' : 'Two to three sentences: what you will actually do.'}</p>
      <textarea name="text" id="text"></textarea>
      <div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Save and continue</button></div>`);
    $('#go').onclick = async () => { try { state = await api('writeup', { text: $('#text').value }); render(); } catch (e) { err(e.message); } };
  }

  function renderTrust(demo) {
    setScreen(demo + `<h2>About the assistant in that conversation</h2><p class="muted">Rate the answers you just read.</p>
      <div class="q"><p class="q-label">I trust this assistant's answers.</p>${scale('trust', 7, 'Strongly disagree', 'Strongly agree')}</div>
      <div class="q"><p class="q-label">Its answers were accurate.</p>${scale('accurate', 7, 'Strongly disagree', 'Strongly agree')}</div>
      <div class="q"><p class="q-label">I would rely on it for a decision like this.</p>${scale('rely', 7, 'Strongly disagree', 'Strongly agree')}</div>
      <div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Continue</button></div>`);
    $('#go').onclick = async () => { const r = { trust: +val('trust'), accurate: +val('accurate'), rely: +val('rely') }; try { state = await api('trust', { ratings: r }); render(); } catch (e) { err(e.message); } };
  }

  function renderBlockRatings(demo) {
    const v = state.version === 'hl' ? 'with highlights' : 'without highlights';
    setScreen(demo + `<h2>About the version ${v} (Part ${state.b + 1})</h2><p class="muted">Think back to the two conversations you had with that version.</p>
      <div class="q"><p class="q-label">Overall, how balanced was this assistant?</p>${scale('balance', 7, 'Very one-sided', 'Very balanced')}</div>
      <div class="q"><p class="q-label">It used what it remembers about me.</p>${scale('memoryUse', 7, 'Strongly disagree', 'Strongly agree')}</div>
      <div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Continue</button></div>`);
    $('#go').onclick = async () => { try { state = await api('block-ratings', { ratings: { balance: +val('balance'), memoryUse: +val('memoryUse') } }); render(); } catch (e) { err(e.message); } };
  }

  function renderAudit(demo) {
    const hl = state.version === 'hl';
    let html = demo + `<h2>Look at each answer again: the version ${hl ? 'with' : 'without'} highlights (Part ${state.b + 1})</h2>
      <p class="lede">For each answer, say whether it gave a <b>one-sided picture that favours your own views or preferences</b>. Using your details to pick an example does not count as one-sided.${hl ? '' : ' Also <b>click any sentence</b> you think used what the assistant remembers about you.'}</p>`;
    state.convs.forEach((conv, c) => {
      html += `<h3>${conv.kind === 'opinion' ? 'Conversation 1' : 'Conversation 2'}: ${esc(conv.question)}</h3>`;
      conv.turns.forEach(t => {
        html += `<div class="audit-turn" data-turn="${t.i}"><div class="user">You asked: ${esc(t.user)}</div><div class="ans" data-c="${c}" data-i="${t.i}">${sentencesHtml(t.sentences, { selectable: !hl })}</div>
          <div class="labels">${chips(`lab-${c}-${t.i}`, [{ v: 'one-sided', t: 'One-sided toward my views' }, { v: 'balanced', t: 'Balanced' }, { v: 'not-sure', t: 'Not sure' }])}</div></div>`;
      });
    });
    if (hl) html += `<h3>About the highlights</h3>
      <div class="q"><p class="q-label">The highlights marked the right sentences.</p>${scale('right', 7, 'Strongly disagree', 'Strongly agree')}</div>
      <div class="q"><p class="q-label">The highlights helped me judge the answers.</p>${scale('helped', 7, 'Strongly disagree', 'Strongly agree')}</div>
      <div class="q"><p class="q-label">What did the highlights show?</p>${chips('comp', [{ v: 'memory', t: 'Where the assistant used what it remembers about me' }, { v: 'important', t: 'The most important sentences' }, { v: 'uncertain', t: 'Sentences the assistant was unsure about' }, { v: 'biased', t: 'Sentences that were biased' }])}</div>`;
    html += `<div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Continue</button></div>`;
    setScreen(html);
    if (!hl) screen.querySelectorAll('mark.sel').forEach(m => { m.onclick = () => { m.classList.toggle('on'); log('memoryClick', { on: m.classList.contains('on'), c: m.closest('.ans').dataset.c, i: m.closest('.ans').dataset.i, k: m.dataset.k }); }; });
    $('#go').onclick = async () => {
      const labels = {}; for (const conv of state.convs) for (const t of conv.turns) { const c = state.convs.indexOf(conv); labels[`${c}-${t.i}`] = val(`lab-${c}-${t.i}`); }
      const body = { labels };
      if (!hl) { body.memoryClicks = {}; screen.querySelectorAll('.ans').forEach(a => { body.memoryClicks[`${a.dataset.c}-${a.dataset.i}`] = [...a.querySelectorAll('mark.sel.on')].map(m => +m.dataset.k); }); }
      else { body.highlight = { right: +val('right'), helped: +val('helped') }; body.comprehension = val('comp'); if (!body.comprehension) return err('Please answer what the highlights showed.'); }
      try { state = await api('audit', body); render(); } catch (e) { err(e.message); }
    };
  }

  function renderComparison(demo) {
    const first = state.versions[0] === 'hl' ? 'the first version (with highlights)' : 'the first version (no highlights)';
    const second = state.versions[1] === 'hl' ? 'the second version (with highlights)' : 'the second version (no highlights)';
    setScreen(demo + `<h2>Comparing the two versions</h2>
      <div class="q"><p class="q-label">Which version did you trust more?</p>${chips('trustedMore', [{ v: 'first', t: first }, { v: 'second', t: second }, { v: 'same', t: 'About the same' }])}</div>
      <div class="q"><p class="q-label">Why? (one or two sentences)</p><textarea name="why" id="why" style="min-height:70px"></textarea></div>
      <div class="q"><p class="q-label">Which version made it easier to judge whether an answer was one-sided?</p>${chips('easier', [{ v: 'first', t: first }, { v: 'second', t: second }, { v: 'same', t: 'About the same' }])}</div>
      <div class="q"><p class="q-label">I am comfortable with an assistant remembering this information about me.</p>${scale('comfort', 7, 'Strongly disagree', 'Strongly agree')}</div>
      <div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Continue</button></div>`);
    $('#go').onclick = async () => { try { state = await api('comparison', { answers: { trustedMore: val('trustedMore'), why: $('#why').value.trim(), easier: val('easier'), comfort: +val('comfort') } }); render(); } catch (e) { err(e.message); } };
  }

  function renderPurpose(demo) {
    setScreen(demo + `<h2>One last question before we talk</h2><div class="q"><p class="q-label">What do you think this study was about?</p><textarea id="text" style="min-height:80px"></textarea></div>
      <div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Continue</button></div>`);
    $('#go').onclick = async () => { try { state = await api('purpose', { text: $('#text').value }); render(); } catch (e) { err(e.message); } };
  }

  function renderInterview(demo) {
    setScreen(demo + `<h2>A short conversation with the researcher</h2><p class="lede">About 10 minutes. The researcher will ask a few questions; this box is for their notes.</p>
      <ul class="muted"><li>What did the highlights mean to you?</li><li>Did any highlighted sentence make you trust the assistant more, or less?</li><li>When an answer took your side, how did that feel, and did you notice it?</li><li>What did you make of the assistant remembering things about you?</li><li>Was there a moment you pushed back or asked for the other side? Why or why not?</li><li>If you used this assistant every day, would you want the highlights on?</li></ul>
      <textarea id="text" placeholder="Researcher notes"></textarea>
      <div class="actions"><span class="err" id="err"></span><button class="btn" id="go">Go to the debrief</button></div>`);
    $('#go').onclick = async () => { try { state = await api('interview', { text: $('#text').value }); render(); } catch (e) { err(e.message); } };
  }

  function renderDebrief(demo) {
    const d = state.debrief;
    const biased = d.rows.filter(r => r.mode === 'biased');
    let html = demo + `<h2>Thank you. Here is what we were studying.</h2>
      <p class="lede">To learn whether people notice when an AI assistant tells them what they want to hear, we deliberately slanted about half of the assistant's answers toward the views and preferences you gave us in Session 1. A slanted answer either took your side on a debated topic or only offered the options that match your tastes. The other answers were balanced. We also compared two versions of the assistant, one that highlighted where it used your memory and one that did not.</p>
      <p>These are the answers that were slanted. You can read a balanced version of each one.</p>
      <table><thead><tr><th>Part</th><th>Topic</th><th>Your question</th><th></th></tr></thead><tbody>` +
      biased.map(r => `<tr><td>${r.b + 1}</td><td>${esc(r.topic)}</td><td>${esc(r.user)}</td><td><button class="btn ghost small" data-b="${r.b}" data-c="${r.c}" data-i="${r.i}">See balanced version</button><div class="muted bal" id="bal-${r.b}-${r.c}-${r.i}" hidden></div></td></tr>`).join('') +
      `</tbody></table>
      <p style="margin-top:14px">For a full picture of each debate, these are the nonpartisan pages the arguments came from:</p><ul>` + d.links.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.question)}</a></li>`).join('') + `</ul>
      <p>You may withdraw your data now without any consequence.</p>
      <div class="actions"><span class="err" id="err"></span><button class="btn ghost" id="withdraw">Withdraw my data</button><button class="btn" id="go">Finish</button></div>`;
    setScreen(html);
    screen.querySelectorAll('button[data-b]').forEach(btn => btn.onclick = async () => {
      const box = $(`#bal-${btn.dataset.b}-${btn.dataset.c}-${btn.dataset.i}`); btn.disabled = true; box.hidden = false; box.textContent = 'Generating…';
      try { const r = await api('balanced-version', { b: +btn.dataset.b, c: +btn.dataset.c, i: +btn.dataset.i }); box.textContent = r.text; } catch (e) { box.textContent = e.message; btn.disabled = false; }
    });
    $('#go').onclick = async () => { try { state = await api('debrief-seen', {}); render(); } catch (e) { err(e.message); } };
    $('#withdraw').onclick = async () => { if (!confirm('Remove your data from the study?')) return; try { state = await api('withdraw', {}); render(); } catch (e) { err(e.message); } };
  }

  function renderDone(demo) {
    setScreen(demo + `<h2>${state.withdrawn ? 'Your data have been withdrawn' : 'All done'}</h2><p>${state.withdrawn ? 'Thank you for taking part; nothing you did will be analyzed.' : 'Thank you for taking part. You can close this window.'}</p>`);
  }

  window.addEventListener('hashchange', () => { pid = location.hash.replace('#', '').toUpperCase(); load(); });
  load();
})();
