// Study tool: memory highlights, sycophancy and trust (CMPUT 656, University of Alberta).
// Express server. Participant state is one JSON file per participant; every event is appended to a JSONL log.
// A language model (Anthropic API) writes each assistant answer in a scheduled mode (biased or balanced) and
// tags the sentences that used the participant's memory; a second, independent call re-tags them, and only
// sentences tagged by both are highlighted. Without an API key the server runs in DEMO mode with canned answers.

'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOPICS = JSON.parse(fs.readFileSync(path.join(__dirname, 'topics.json'), 'utf8'));
// Data lives on the Railway volume when one is mounted (Railway sets RAILWAY_VOLUME_MOUNT_PATH), else in ./data.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PART_DIR = path.join(DATA_DIR, 'participants');
const LOG_DIR = path.join(DATA_DIR, 'events');
for (const d of [DATA_DIR, PART_DIR, LOG_DIR]) fs.mkdirSync(d, { recursive: true });

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEN_MODEL = process.env.GEN_MODEL || 'claude-sonnet-5-5';
const VERIFY_MODEL = process.env.VERIFY_MODEL || 'claude-haiku-5-5';
const RESEARCHER_KEY = process.env.RESEARCHER_KEY || '';
const LIVE = !!API_KEY;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, setHeaders: res => res.set('Cache-Control', 'no-cache') })); // revalidate on every load: participants must never run stale app.js after a deploy
app.use('/legacy', express.static(path.join(__dirname, 'legacy')));

// ---------------------------------------------------------------- storage
const pfile = pid => path.join(PART_DIR, pid + '.json');
function loadP(pid) {
  if (!/^P\d{1,2}$/.test(pid)) return null;
  const f = pfile(pid);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveP(p) { fs.writeFileSync(pfile(p.pid), JSON.stringify(p, null, 1)); }
function logEvent(pid, type, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), pid, type, ...data });
  fs.appendFileSync(path.join(LOG_DIR, pid + '.jsonl'), line + '\n');
}

// ---------------------------------------------------------------- counterbalancing (Table 2 of the Methodology report)
function assignmentFor(pid) {
  const n = parseInt(pid.slice(1), 10);
  const r = ((n - 1) % 4 + 4) % 4; // P1->0, P2->1, P3->2, P4->3, P5->0, P6->1 ...; P0 (pilot) -> 3? keep pilot like P1
  const row = n === 0 ? 0 : r;
  return {
    versions: row === 0 || row === 2 ? ['hl', 'plain'] : ['plain', 'hl'],
    topicSets: row === 0 || row === 1 ? ['A', 'B'] : ['B', 'A'],
  };
}

function newParticipant(pid) {
  return {
    pid, createdAt: new Date().toISOString(), assignment: assignmentFor(pid),
    session1: null, memory: [], topics: null, override: false,
    s2: { started: null, consent: null, memoryReviewed: false, tutorial: null, blocks: null, comparison: null, purpose: null, interviewNotes: null, debriefSeen: false, withdrawn: false },
  };
}

// ---------------------------------------------------------------- memory profile and topic selection
function buildMemory(s1) {
  const items = [];
  let k = 1;
  const push = (kind, text, source) => { items.push({ id: 'M' + (k++), kind, text, source, removed: false }); };
  for (const t of TOPICS.opinion) {
    const a = s1.opinion[t.id]; if (!a) continue;
    const r = Number(a.rating), imp = Number(a.importance);
    const side = r >= 4 ? 'Agrees' : 'Disagrees';
    let text = `${side} that ${t.statement}. Rated ${r} of 6.`;
    if (imp >= 4) text += ' Says this issue is important to them.';
    push('opinion', text, `Your answer in Session 1, opinion item ${t.id.slice(1)}`);
  }
  for (const t of TOPICS.preference) {
    const a = s1.preference[t.id]; if (!a) continue;
    const base = a.choice === 'a' ? t.memA : t.memB;
    const strength = { slightly: 'Slight', moderately: 'Moderate', strongly: 'Strong' }[a.strength] || 'Moderate';
    let text = `${base}. ${strength} preference.`;
    if (a.face === 'yes') text += ' ' + t.faceMem + '.';
    push('preference', text, `Your answer in Session 1, preference item ${t.id.slice(1)}`);
  }
  for (const b of TOPICS.background) {
    const v = (s1.background[b.id] || '').toString().trim(); if (!v) continue;
    let text;
    const m = b.mem.match(/^\{v:(.+)\}$/);
    if (m) { const opts = m[1].split('|'); const i = b.choices.indexOf(v); text = opts[Math.max(0, Math.min(i, opts.length - 1))]; }
    else text = b.mem.replace('{v}', v);
    push('background', text, `Your answer in Session 1, background item ${b.id.slice(1)}`);
  }
  return items;
}

// Server-side copy of the interface's checks: every item answered, values within their scales, free text cut to 60 characters.
function validateSession1(a) {
  if (!a || typeof a !== 'object' || !a.opinion || !a.preference || !a.background) return null;
  const out = { opinion: {}, preference: {}, background: {}, ai: {} };
  const int = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  for (const t of TOPICS.opinion) { const x = a.opinion[t.id] || {}; const r = int(x.rating, 1, 6), imp = int(x.importance, 1, 5); if (r === null || imp === null) return null; out.opinion[t.id] = { rating: r, importance: imp }; }
  for (const t of TOPICS.preference) { const x = a.preference[t.id] || {}; if (!['a', 'b'].includes(x.choice) || !['slightly', 'moderately', 'strongly'].includes(x.strength) || !['yes', 'no'].includes(x.face)) return null; out.preference[t.id] = { choice: x.choice, strength: x.strength, face: x.face }; }
  for (const b of TOPICS.background) { const v = String(a.background[b.id] == null ? '' : a.background[b.id]).trim().slice(0, 60); if (!v || (b.type === 'choice' && !b.choices.includes(v))) return null; out.background[b.id] = v; }
  const ai = a.ai || {}; if (!TOPICS.aiUse.freq.choices.includes(ai.freq) || !TOPICS.aiUse.memory.choices.includes(ai.memory)) return null; out.ai = { freq: ai.freq, memory: ai.memory };
  return out;
}

function selectTopics(s1) {
  const op = TOPICS.opinion.map(t => {
    const a = s1.opinion[t.id] || {}; const r = Number(a.rating) || 3.5, imp = Number(a.importance) || 0;
    return { id: t.id, stance: Math.abs(r - 3.5), imp, score: Math.abs(r - 3.5) * 2 + imp };
  }).sort((x, y) => y.score - x.score);
  const pr = TOPICS.preference.map(t => {
    const a = s1.preference[t.id] || {}; const s = { slightly: 1, moderately: 2, strongly: 3 }[a.strength] || 0;
    return { id: t.id, face: a.face === 'yes' ? 1 : 0, s, score: (a.face === 'yes' ? 10 : 0) + s };
  }).sort((x, y) => y.score - x.score);
  const opinion = op.slice(0, 2).map(x => x.id), preference = pr.slice(0, 2).map(x => x.id);
  const eligible = op.slice(0, 2).every(x => x.imp >= 3 && x.stance >= 0.5) && pr.slice(0, 2).every(x => x.face === 1);
  return { opinion, preference, eligible, detail: { opinion: op, preference: pr } };
}

function topicById(id) { return TOPICS.opinion.find(t => t.id === id) || TOPICS.preference.find(t => t.id === id); }

function initBlocks(p) {
  const sets = { A: 0, B: 1 };
  p.s2.blocks = p.assignment.versions.map((version, b) => {
    const set = p.assignment.topicSets[b];
    return {
      version, set,
      convs: [
        { kind: 'opinion', topicId: p.topics.opinion[sets[set]], plan: null, turns: [], finished: null, writeup: null, trust: null },
        { kind: 'preference', topicId: p.topics.preference[sets[set]], plan: null, turns: [], finished: null, writeup: null, trust: null },
      ],
      blockRatings: null, audit: null,
    };
  });
}

// ---------------------------------------------------------------- answer scheduling: first four answers are 2 biased + 2 balanced in random order
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function nextMode(conv) {
  const prev = conv.turns.map(t => t.mode);
  if (!conv.plan) {
    let plan;
    do { plan = shuffle(['biased', 'biased', 'balanced', 'balanced']); }
    while (plan[0] === plan[1] && plan[1] === plan[2]);
    conv.plan = plan;
  }
  if (prev.length < 4) return conv.plan[prev.length];
  const nB = prev.filter(m => m === 'biased').length, nN = prev.length - nB;
  const last2 = prev.slice(-2);
  if (last2[0] === last2[1]) return last2[0] === 'biased' ? 'balanced' : 'biased';
  if (nB !== nN) return nB < nN ? 'biased' : 'balanced';
  return Math.random() < 0.5 ? 'biased' : 'balanced';
}

// ---------------------------------------------------------------- prompts (the Methodology report, Section 5.3 and 5.4)
function memoryBlock(p) {
  return p.memory.filter(m => !m.removed).map(m => `${m.id} (${m.kind}): ${m.text}`).join('\n');
}
function userSide(p, topic) {
  const m = p.memory.find(x => !x.removed && x.kind === 'opinion' && x.text.includes(` that ${topic.statement}`));
  if (m) return m.text.startsWith('Agrees') ? 'PRO' : 'CON';
  // the stance item was marked wrong at the memory review (or is missing): use the Session 1 rating rather than defaulting to PRO
  const a = p.session1 && p.session1.opinion && p.session1.opinion[topic.id];
  return a ? (Number(a.rating) >= 4 ? 'PRO' : 'CON') : null;
}
// Chosen topics whose memory item the participant marked wrong, shown on the researcher page so the topic can be swapped before the block.
function topicWarnings(p) {
  const w = [];
  if (!p.topics || !p.memory) return w;
  for (const id of p.topics.opinion) { const t = topicById(id); if (t && p.memory.some(m => m.removed && m.kind === 'opinion' && m.text.includes(' that ' + t.statement))) w.push(id + ': stance item marked wrong'); }
  for (const id of p.topics.preference) { const t = topicById(id); if (t && p.memory.some(m => m.removed && m.kind === 'preference' && (m.text.startsWith(t.memA) || m.text.startsWith(t.memB)))) w.push(id + ': preference item marked wrong'); }
  return w;
}
function userPref(p, topic) {
  const a = p.session1.preference[topic.id];
  return a ? a.choice : null;
}

function systemPrompt(p, conv, mode) {
  const topic = topicById(conv.topicId);
  const mem = memoryBlock(p);
  const common = `You are a personal assistant. You remember the following about the user:\n${mem}\n\n`;
  const rulesBoth = `In both modes: 80 to 130 words, plain language, no headings, no bullet points. Never mention this list, the mode, these rules, the format, or the material you were given, and never say that you remember things unless the user asks what you remember. If asked for a list or headings, answer in prose without commenting on the format. Answer only from the arguments above and general knowledge; if you do not have a figure, say so rather than inventing one. If the user asks about something off the topic, answer in one sentence and bring the conversation back to the topic.\n\nReturn JSON only, in this exact shape:\n{"sentences": [{"text": "first sentence", "memory": ["M1"]}, {"text": "second sentence", "memory": []}]}\nTag a sentence with a memory item only if that sentence would have been different without the item.`;
  if (conv.kind === 'opinion') {
    const side = userSide(p, topic) || 'PRO';
    const args = ['pro', 'con'].map(s => topic[s].map((a, i) => `${s.toUpperCase()} ${i + 1}: ${a.headline} ${a.evidence}`).join('\n')).join('\n');
    return common +
      `The user is asking about this topic: ${topic.question}\nArguments you may draw on, from a nonpartisan debate guide:\n${args}\n\n` +
      `MODE: ${mode === 'biased' ? 'BIASED' : 'BALANCED'}\nThe user's side on this topic, from the memory, is ${side}.\n\n` +
      `If MODE is BALANCED: give the strongest points from both PRO and CON in roughly equal measure. Do not take a side and do not say which side the user leans to. If asked for a recommendation or a yes-or-no answer, say what the choice depends on and give a conditional answer (if one thing matters most to the user, then one way; if another, then the other); do not say that you cannot or will not take a side. You may use the memory to choose examples and to fit the user's situation (for example their job or commute), but not to decide what to recommend.\n\n` +
      `If MODE is BIASED: take the user's side as recorded in the memory. Use mainly the arguments from that side. Mention the other side briefly at most, and play it down. End with a clear conclusion that agrees with the user. Do not say that you are taking a side.\n\n` + rulesBoth;
  }
  if (conv.kind === 'preference') {
    const pref = userPref(p, topic) || 'a';
    const opts = topic.options.map((o, i) => `O${i + 1}: ${o.text}`).join('\n');
    const matching = topic.options.map((o, i) => (o.matches === pref ? `O${i + 1}` : null)).filter(Boolean).join(', ') || 'O1';
    return common +
      `The user is asking about this topic: ${topic.question}\nOptions for this question (all four are reasonable):\n${opts}\n\n` +
      `MODE: ${mode === 'biased' ? 'NARROWED' : 'BALANCED'}\nThe options that match the user's stated preference, from the memory, are: ${matching}.\n\n` +
      `If MODE is BALANCED: cover all four options and say something useful about each, using the memory only to tailor the examples. Do not favour the user's preference. If asked which one to choose, say what the choice depends on instead of naming one option as the answer, and do not say that you cannot choose.\n\n` +
      `If MODE is NARROWED: include only the options that match the user's preference (${matching}) and leave the others out, without saying that you are leaving anything out. Go into detail on those options and end with a clear recommendation built on them.\n\n` + rulesBoth;
  }
  // tutorial
  const opts = TOPICS.tutorial.options.map((o, i) => `O${i + 1}: ${o.text}`).join('\n');
  return common + `The user is asking about this topic: ${TOPICS.tutorial.question}\nOptions:\n${opts}\n\nMODE: BALANCED\nCover the options evenly, using the memory only to tailor examples.\n\n` + rulesBoth;
}

const VERIFY_SYSTEM = 'You check which sentences of an assistant answer were shaped by what the assistant remembers about the user. Return JSON only.';
function verifyUser(p, sentences) {
  const mem = memoryBlock(p);
  const numbered = sentences.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  return `Here is a list of things an assistant remembers about a user, and an answer the assistant gave, split into sentences.\n${mem}\n\n${numbered}\n\nFor each sentence, list the memory items (M-numbers) that shaped it, meaning the sentence would have been different if the assistant did not know that item. Many sentences use none. Return JSON only: {"tags": [["M1"], [], ["M1","M5"]]}, one entry per sentence, in order, ${sentences.length} entries in total.`;
}

// ---------------------------------------------------------------- model calls
const Anthropic = require('@anthropic-ai/sdk');
const claude = LIVE ? new Anthropic() : null; // reads ANTHROPIC_API_KEY; retries rate limits and 5xx itself
async function callClaude({ model, system, messages, maxTokens = 8000, effort = 'medium' }) {
  // No temperature: the Claude 5.5 models reject sampling parameters. Effort controls how much the model thinks.
  const res = await claude.messages.create({ model, system, messages, max_tokens: maxTokens, output_config: { effort } });
  if (res.stop_reason === 'refusal') throw new Error('The model declined this request' + (res.stop_details && res.stop_details.category ? ` (${res.stop_details.category})` : ''));
  if (res.stop_reason === 'max_tokens') throw new Error('The model ran out of output tokens');
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
}
function parseJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}
function cleanSentences(obj) {
  const arr = Array.isArray(obj && obj.sentences) ? obj.sentences : [];
  return arr.filter(s => s && typeof s.text === 'string' && s.text.trim()).map(s => ({
    text: s.text.trim(),
    memory: Array.isArray(s.memory) ? s.memory.filter(x => /^M\d+$/.test(String(x))).map(String) : [],
  }));
}

function history(conv) {
  // Earlier turns are replayed as plain text: the model's own JSON reply when there is one (live), else the sentences (demo).
  const msgs = [];
  for (const t of conv.turns) {
    msgs.push({ role: 'user', content: t.user });
    msgs.push({ role: 'assistant', content: (t.gen && t.gen.raw) || t.final.map(s => s.text).join(' ') });
  }
  return msgs;
}

async function generate(p, conv, mode, userText) {
  const system = systemPrompt(p, conv, mode);
  const messages = history(conv).concat([{ role: 'user', content: userText }]);
  if (!LIVE) return { raw: null, sentences: demoAnswer(p, conv, mode, userText), system };
  let raw = await callClaude({ model: GEN_MODEL, system, messages, maxTokens: 8000 }); // thinking tokens count against max_tokens
  let sentences;
  try { sentences = cleanSentences(parseJSON(raw)); } catch (e) { sentences = []; }
  if (sentences.length === 0) { // nothing parsable: one retry with a firmer instruction (a one-sentence answer is fine)
    raw = await callClaude({ model: GEN_MODEL, system: system + '\n\nYour previous reply was not valid JSON. Reply with the JSON object only.', messages, maxTokens: 8000 });
    try { sentences = cleanSentences(parseJSON(raw)); } catch (e) { sentences = []; }
    if (sentences.length === 0) throw new Error('The model did not return a usable answer: ' + raw.slice(0, 120));
  }
  // one regeneration when an answer runs far over the limit; recorded in the turn so the Evaluation report can say how often it happened
  let regenerated = null;
  const wordCount = arr => arr.map(x => x.text).join(' ').split(/\s+/).filter(Boolean).length;
  if (wordCount(sentences) > 170) {
    const raw2 = await callClaude({ model: GEN_MODEL, system: system + '\n\nKeep the answer under 130 words.', messages, maxTokens: 8000 });
    let s2 = []; try { s2 = cleanSentences(parseJSON(raw2)); } catch (e) { s2 = []; }
    if (s2.length) { regenerated = { reason: 'length', firstWords: wordCount(sentences), secondWords: wordCount(s2), firstRaw: raw }; raw = raw2; sentences = s2; }
  }
  return { raw, sentences, system, regenerated };
}

async function verify(p, sentences) {
  if (!LIVE) return { raw: null, tags: sentences.map(s => s.memory.slice()) };
  const user = verifyUser(p, sentences);
  const raw = await callClaude({ model: VERIFY_MODEL, system: VERIFY_SYSTEM, messages: [{ role: 'user', content: user }], maxTokens: 4000, effort: 'low' });
  let tags = [];
  try { const o = parseJSON(raw); tags = Array.isArray(o.tags) ? o.tags : []; } catch (e) { tags = []; }
  tags = sentences.map((s, i) => Array.isArray(tags[i]) ? tags[i].filter(x => /^M\d+$/.test(String(x))).map(String) : []);
  return { raw, tags };
}

function finalize(sentences, verTags) {
  return sentences.map((s, i) => {
    const both = s.memory.filter(m => (verTags[i] || []).includes(m));
    return { text: s.text, mem: both, genOnly: s.memory.filter(m => !both.includes(m)), verOnly: (verTags[i] || []).filter(m => !s.memory.includes(m)) };
  });
}

// ---------------------------------------------------------------- demo mode (no API key): templated answers so the screens can be tried
function demoAnswer(p, conv, mode, userText) {
  const topic = topicById(conv.topicId) || TOPICS.tutorial;
  const mem = p.memory.filter(m => !m.removed);
  const bg = mem.find(m => m.kind === 'background');
  const bgRef = bg ? bg.id : null;
  const bgText = bg ? bg.text.replace(/^(Works or studies in|Lives in|Usually gets to work or school by|Spends free time on|Mostly uses|Works or studies)\s*/, '').toLowerCase() : 'your situation';
  const S = (text, memory = []) => ({ text, memory });
  if (conv.kind === 'opinion') {
    const side = userSide(p, topic) || 'PRO';
    const mine = side === 'PRO' ? topic.pro : topic.con, other = side === 'PRO' ? topic.con : topic.pro;
    const stanceItem = mem.find(m => m.kind === 'opinion' && m.text.includes(` that ${topic.statement}`));
    const sid = stanceItem ? [stanceItem.id] : [];
    if (mode === 'biased') return [
      S(`Since you ${side === 'PRO' ? 'support' : 'are against'} ${topic.short}, you are on the right track: the stronger case is on your side.`, sid),
      S(firstSentence(mine[0].evidence)), S(firstSentence(mine[1].evidence)),
      S(`The usual objection, that ${lcFirst(other[0].headline.replace(/\.$/, ''))}, tends to be overstated.`),
      S(`Since you ${bgDescr(bg)}, that makes the choice fairly clear.`, bgRef ? [bgRef] : []),
      S(`Overall, ${side === 'PRO' ? 'going ahead' : 'holding back'} is the right call here.`, sid),
    ];
    return [
      S(`There is real evidence on both sides of ${topic.short}.`),
      S(firstSentence(topic.pro[0].evidence)), S(`On the other hand, ${firstSentence(topic.con[0].evidence).replace(/^./, c => c.toLowerCase())}`),
      S(`Since you ${bgDescr(bg)}, the practical question is which of these effects would matter most day to day.`, bgRef ? [bgRef] : []),
      S('Weighing the two sides against your own priorities will give you a better answer than any general rule.'),
    ];
  }
  if (conv.kind === 'preference') {
    const pref = userPref(p, topic) || 'a';
    const prefItem = mem.find(m => m.kind === 'preference' && (m.text.startsWith(topic.memA) || m.text.startsWith(topic.memB)));
    const pid = prefItem ? [prefItem.id] : [];
    const match = topic.options.filter(o => o.matches === pref), rest = topic.options.filter(o => o.matches !== pref);
    if (mode === 'biased') return [
      S(`Since you prefer ${pref === 'a' ? topic.a : topic.b}, the best route for you is ${match.map(o => o.text).join(' and ')}.`, pid),
      S(`Start with ${match[0].text} and build a routine around it, a little every day rather than a lot once a week.`),
      S(`Pick one well-reviewed source and stick with it instead of switching around.`),
      S(`Given that you ${bgDescr(bg)}, fit it into the gaps in your week.`, bgRef ? [bgRef] : []),
      S(`That should get you where you want to be within the month.`, pid),
    ];
    return [
      S('A mix of approaches usually works best, and there are four reasonable options.'),
      S(`${cap(topic.options[0].text)} and ${topic.options[1].text} suit different people; ${topic.options[2].text} and ${topic.options[3].text} are worth adding to either.`),
      S(`Since you prefer ${pref === 'a' ? topic.a : topic.b}, you could start there, but keep the other options in the plan.`, pid),
      S(`Given that you ${bgDescr(bg)}, schedule it in short regular sessions.`, bgRef ? [bgRef] : []),
      S('Whichever mix you choose, consistency matters more than the particular resource.'),
    ];
  }
  return [S('A run-walk plan that builds up over a few weeks is the usual starting point.'), S('Joining a beginners\' group or running with a friend helps people keep going.'), S(`Given that you ${bgDescr(bg)}, short runs near home or work are easiest to keep up.`, bgRef ? [bgRef] : []), S('Getting fitted for shoes first prevents most early injuries.')];
}
function firstSentence(t) { const m = t.match(/^.*?(?<![A-Z])\.(?=\s|$)/); return m ? m[0] : t; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function lcFirst(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
function bgDescr(bg) { // second person, for "Since you ..." / "Given that you ..."
  if (!bg) return 'have a busy week';
  const t = bg.text;
  if (/^Works or studies in /.test(t)) return 'work in ' + t.replace(/^Works or studies in /, '').toLowerCase();
  if (/^Lives in /.test(t)) return 'live in ' + t.replace(/^Lives in /, '').toLowerCase();
  if (/^Usually gets to work or school by /.test(t)) return 'commute by ' + t.replace(/^Usually gets to work or school by /, '').toLowerCase();
  return 'have the background you described';
}

// ---------------------------------------------------------------- participant stage
function stageOf(p) {
  if (!p.session1) return { stage: 's1' };
  if (!p.topics || (!p.topics.eligible && !p.override)) return { stage: 'ineligible' };
  if (!p.s2.started) return { stage: 'thanks' }; // Session 2 is opened by the researcher on the day
  if (!p.s2.consent) return { stage: 'consent' };
  if (!p.s2.memoryReviewed) return { stage: 'memory' };
  if (!p.s2.tutorial || !p.s2.tutorial.done) return { stage: 'tutorial' };
  for (let b = 0; b < 2; b++) {
    const B = p.s2.blocks[b];
    for (let c = 0; c < 2; c++) {
      const conv = B.convs[c];
      if (!conv.finished) return { stage: 'chat', b, c };
      if (!conv.writeup) return { stage: 'writeup', b, c };
      if (!conv.trust) return { stage: 'trust', b, c };
    }
  }
  // The balance ratings and the audits come after both blocks, so that questions about one-sidedness do not prime the second block.
  for (let b = 0; b < 2; b++) {
    const B = p.s2.blocks[b];
    if (!B.blockRatings) return { stage: 'blockRatings', b };
    if (!B.audit) return { stage: 'audit', b };
  }
  if (!p.s2.comparison) return { stage: 'comparison' };
  if (!p.s2.purpose) return { stage: 'purpose' };
  if (!p.s2.interviewNotes) return { stage: 'interview' };
  if (!p.s2.debriefSeen) return { stage: 'debrief' };
  return { stage: 'done' };
}

function convView(conv, version, forAudit) {
  const topic = topicById(conv.topicId) || TOPICS.tutorial;
  return {
    kind: conv.kind, topicId: conv.topicId, question: topic.question, scenario: conv.kind === 'tutorial' ? TOPICS.tutorial.scenario : topic.scenario,
    turns: conv.turns.map((t, i) => ({
      i, user: t.user,
      sentences: t.final.map(s => ({ text: s.text, mem: version === 'hl' ? s.mem : [] })),
      mode: forAudit === 'debrief' ? t.mode : undefined,
    })),
    finished: !!conv.finished, writeup: conv.writeup,
  };
}

function stateFor(p) {
  const st = stageOf(p);
  const out = { pid: p.pid, ...st, demo: !LIVE, assignment: p.assignment, withdrawn: p.s2.withdrawn };
  if (st.stage === 's1') out.form = { opinion: TOPICS.opinion.map(t => ({ id: t.id, question: t.question })), preference: TOPICS.preference.map(t => ({ id: t.id, item: t.item, a: t.a, b: t.b, face: t.face })), background: TOPICS.background, aiUse: TOPICS.aiUse };
  if (st.stage === 'memory') out.memory = p.memory.map(m => ({ id: m.id, kind: m.kind, text: m.text, source: m.source }));
  const memMap = {}; for (const m of p.memory) memMap[m.id] = { text: m.text, source: m.source };
  if (['tutorial', 'chat', 'writeup', 'audit'].includes(st.stage)) out.memMap = memMap;
  if (st.stage === 'tutorial') { const conv = p.s2.tutorial; out.version = p.s2.blocks[0].version; out.conv = convView(conv, out.version); }
  if (['chat', 'writeup', 'trust'].includes(st.stage)) { const B = p.s2.blocks[st.b]; out.version = B.version; out.conv = convView(B.convs[st.c], B.version); out.minQuestions = 4; }
  if (st.stage === 'blockRatings') out.version = p.s2.blocks[st.b].version;
  if (st.stage === 'audit') { const B = p.s2.blocks[st.b]; out.version = B.version; out.convs = B.convs.map(c => convView(c, B.version, true)); }
  if (st.stage === 'comparison') out.versions = p.assignment.versions;
  if (st.stage === 'debrief') out.debrief = debriefView(p);
  return out;
}

function debriefView(p) {
  const rows = [];
  p.s2.blocks.forEach((B, b) => B.convs.forEach((conv, c) => {
    const topic = topicById(conv.topicId);
    conv.turns.forEach((t, i) => rows.push({ b, c, i, version: B.version, kind: conv.kind, topic: topic.question, slug: topic.slug || null, user: t.user, mode: t.mode, snippet: t.final.map(s => s.text).join(' ').slice(0, 160), balanced: t.balancedVersion || null }));
  }));
  return { rows, links: TOPICS.opinion.filter(t => p.topics.opinion.includes(t.id)).map(t => ({ question: t.question, url: 'https://www.britannica.com/procon/' + t.slug })) };
}

// ---------------------------------------------------------------- API: participant
const getP = (req, res) => { const p = loadP(String(req.query.pid || (req.body || {}).pid || '').toUpperCase()); if (!p) { res.status(404).json({ error: 'Unknown participant code.' }); return null; } return p; };

// Requests for the same participant run one after another: two messages sent at the same moment (a double click, a second
// tab) cannot overwrite each other's turn, and a researcher action cannot interleave with an answer in progress.
const queues = new Map();
function queued(handler) {
  return (req, res) => {
    const pid = String(req.query.pid || (req.body || {}).pid || '').toUpperCase();
    const prev = queues.get(pid) || Promise.resolve();
    const next = prev.then(() => handler(req, res)).catch(e => { console.error('handler error', e); if (!res.headersSent) res.status(500).json({ error: 'Server error.' }); });
    const tail = next.finally(() => { if (queues.get(pid) === tail) queues.delete(pid); });
    queues.set(pid, tail);
    return tail;
  };
}

app.get('/api/state', (req, res) => { const p = getP(req, res); if (!p) return; res.json(stateFor(p)); });

app.post('/api/session1', queued((req, res) => {
  const p = getP(req, res); if (!p) return;
  if (p.s2.started) return res.status(400).json({ error: 'Session 1 is closed for this code.' });
  const s1 = validateSession1(req.body.answers);
  if (!s1) return res.status(400).json({ error: 'Incomplete questionnaire.' });
  p.session1 = { ...s1, submittedAt: new Date().toISOString() };
  p.memory = buildMemory(p.session1);
  p.topics = selectTopics(p.session1);
  initBlocks(p);
  saveP(p); logEvent(p.pid, 'session1', { answers: s1, memory: p.memory, topics: p.topics });
  res.json(stateFor(p));
}));

app.post('/api/consent', queued((req, res) => { const p = getP(req, res); if (!p) return; p.s2.consent = { at: new Date().toISOString(), recording: !!req.body.recording }; saveP(p); logEvent(p.pid, 'consent', p.s2.consent); res.json(stateFor(p)); }));

app.post('/api/memory-review', queued((req, res) => {
  const p = getP(req, res); if (!p) return;
  if (stageOf(p).stage !== 'memory') return res.status(400).json({ error: 'Not expecting the memory review.' });
  const wrong = new Set((req.body.wrong || []).map(String));
  for (const m of p.memory) m.removed = wrong.has(m.id);
  p.s2.memoryReviewed = true;
  // a removed stance or preference item is flagged on the researcher page (topicWarnings); the biased side then falls back to the Session 1 rating
  p.s2.tutorial = { kind: 'tutorial', topicId: null, plan: null, turns: [], done: false };
  saveP(p); logEvent(p.pid, 'memoryReview', { wrong: [...wrong] });
  res.json(stateFor(p));
}));

async function answerTurn(p, conv, userText, kindOverride) {
  const mode = conv.kind === 'tutorial' ? 'balanced' : nextMode(conv);
  const t0 = Date.now();
  const gen = await generate(p, conv, mode, userText);
  const t1 = Date.now();
  const ver = await verify(p, gen.sentences);
  const t2 = Date.now();
  const final = finalize(gen.sentences, ver.tags);
  const turn = { n: conv.turns.length, user: userText, mode, gen: { raw: gen.raw, sentences: gen.sentences, regenerated: gen.regenerated || null }, ver: { raw: ver.raw, tags: ver.tags }, final, askedAt: new Date(t0).toISOString(), genMs: t1 - t0, verMs: t2 - t1, model: LIVE ? { gen: GEN_MODEL, verify: VERIFY_MODEL } : 'demo' };
  conv.turns.push(turn);
  return turn;
}

app.post('/api/chat', queued(async (req, res) => {
  const p = getP(req, res); if (!p) return;
  const text = String(req.body.message || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Empty message.' });
  const st = stageOf(p);
  let conv;
  if (st.stage === 'tutorial') conv = p.s2.tutorial;
  else if (st.stage === 'chat') conv = p.s2.blocks[st.b].convs[st.c];
  else return res.status(400).json({ error: 'Not in a conversation.' });
  if (conv.turns.length >= 12) return res.status(400).json({ error: 'This conversation has reached its limit. Please press Finish.' });
  try {
    const turn = await answerTurn(p, conv, text);
    saveP(p);
    logEvent(p.pid, 'turn', { stage: st, topicId: conv.topicId, kind: conv.kind, n: turn.n, user: text, mode: turn.mode, system: LIVE ? undefined : 'demo', genRaw: turn.gen.raw, genSentences: turn.gen.sentences, genRegenerated: turn.gen.regenerated, verRaw: turn.ver.raw, verTags: turn.ver.tags, final: turn.final, genMs: turn.genMs, verMs: turn.verMs, model: turn.model });
    const version = st.stage === 'tutorial' ? p.s2.blocks[0].version : p.s2.blocks[st.b].version;
    res.json({ turn: { i: turn.n, user: text, sentences: turn.final.map(s => ({ text: s.text, mem: version === 'hl' ? s.mem : [] })) }, count: conv.turns.length });
  } catch (e) {
    logEvent(p.pid, 'error', { where: 'chat', message: String(e.message || e) });
    res.status(502).json({ error: 'The assistant could not answer just now. Please try again.' , detail: String(e.message || e).slice(0, 200) });
  }
}));

app.post('/api/tutorial-done', queued((req, res) => { const p = getP(req, res); if (!p) return; if (p.s2.tutorial) p.s2.tutorial.done = true; saveP(p); logEvent(p.pid, 'tutorialDone', {}); res.json(stateFor(p)); }));

app.post('/api/finish', queued((req, res) => {
  const p = getP(req, res); if (!p) return;
  const st = stageOf(p); if (st.stage !== 'chat') return res.status(400).json({ error: 'Not in a conversation.' });
  const conv = p.s2.blocks[st.b].convs[st.c];
  if (conv.turns.length < 4) return res.status(400).json({ error: 'Please ask at least four questions first.' });
  conv.finished = new Date().toISOString(); saveP(p); logEvent(p.pid, 'finish', { b: st.b, c: st.c, turns: conv.turns.length });
  res.json(stateFor(p));
}));

app.post('/api/writeup', queued((req, res) => {
  const p = getP(req, res); if (!p) return;
  const st = stageOf(p); if (st.stage !== 'writeup') return res.status(400).json({ error: 'Not expecting a write-up.' });
  const text = String(req.body.text || '').trim().slice(0, 5000); if (text.length < 20) return res.status(400).json({ error: 'Please write a few sentences.' });
  const conv = p.s2.blocks[st.b].convs[st.c]; conv.writeup = { text, at: new Date().toISOString() }; saveP(p); logEvent(p.pid, 'writeup', { b: st.b, c: st.c, text });
  res.json(stateFor(p));
}));

app.post('/api/trust', queued((req, res) => {
  const p = getP(req, res); if (!p) return;
  const st = stageOf(p); if (st.stage !== 'trust') return res.status(400).json({ error: 'Not expecting trust ratings.' });
  const r = req.body.ratings || {}; for (const k of ['trust', 'accurate', 'rely']) if (!Number.isInteger(Number(r[k])) || !(r[k] >= 1 && r[k] <= 7)) return res.status(400).json({ error: 'Please answer all three items.' });
  const conv = p.s2.blocks[st.b].convs[st.c]; conv.trust = { ...r, at: new Date().toISOString() }; saveP(p); logEvent(p.pid, 'trust', { b: st.b, c: st.c, ratings: r });
  res.json(stateFor(p));
}));

app.post('/api/block-ratings', queued((req, res) => {
  const p = getP(req, res); if (!p) return;
  const st = stageOf(p); if (st.stage !== 'blockRatings') return res.status(400).json({ error: 'Not expecting block ratings.' });
  const r = req.body.ratings || {}; for (const k of ['balance', 'memoryUse']) if (!Number.isInteger(Number(r[k])) || !(r[k] >= 1 && r[k] <= 7)) return res.status(400).json({ error: 'Please answer both items.' });
  p.s2.blocks[st.b].blockRatings = { ...r, at: new Date().toISOString() }; saveP(p); logEvent(p.pid, 'blockRatings', { b: st.b, ratings: r });
  res.json(stateFor(p));
}));

app.post('/api/audit', queued((req, res) => {
  const p = getP(req, res); if (!p) return;
  const st = stageOf(p); if (st.stage !== 'audit') return res.status(400).json({ error: 'Not expecting an audit.' });
  const B = p.s2.blocks[st.b];
  const labels = req.body.labels || {}; // key "c-i" -> one-sided | balanced | not-sure
  for (let c = 0; c < 2; c++) for (let i = 0; i < B.convs[c].turns.length; i++) if (!['one-sided', 'balanced', 'not-sure'].includes(labels[`${c}-${i}`])) return res.status(400).json({ error: 'Please label every answer.' });
  const audit = { labels, at: new Date().toISOString() };
  if (B.version === 'plain') audit.memoryClicks = req.body.memoryClicks || {}; // key "c-i" -> [sentence indexes]
  else {
    const h = req.body.highlight || {}; for (const k of ['right', 'helped']) if (!Number.isInteger(Number(h[k])) || !(h[k] >= 1 && h[k] <= 7)) return res.status(400).json({ error: 'Please answer the highlight questions.' });
    if (!['memory', 'important', 'uncertain', 'biased'].includes(req.body.comprehension)) return res.status(400).json({ error: 'Please answer what the highlights showed.' });
    audit.highlight = { right: Number(h.right), helped: Number(h.helped) }; audit.comprehension = req.body.comprehension;
  }
  // scoring against the known modes
  audit.score = { hits: 0, falseAlarms: 0, notSure: 0, biased: 0, balanced: 0, memoryFound: 0, memoryTagged: 0 };
  B.convs.forEach((conv, c) => conv.turns.forEach((t, i) => {
    const l = labels[`${c}-${i}`];
    if (t.mode === 'biased') { audit.score.biased++; if (l === 'one-sided') audit.score.hits++; } else { audit.score.balanced++; if (l === 'one-sided') audit.score.falseAlarms++; }
    if (l === 'not-sure') audit.score.notSure++;
    if (B.version === 'plain') { const clicks = new Set(audit.memoryClicks[`${c}-${i}`] || []); t.final.forEach((s, k) => { if (s.mem.length) { audit.score.memoryTagged++; if (clicks.has(k)) audit.score.memoryFound++; } }); }
  }));
  B.audit = audit; saveP(p); logEvent(p.pid, 'audit', { b: st.b, audit });
  res.json(stateFor(p));
}));

app.post('/api/comparison', queued((req, res) => {
  const p = getP(req, res); if (!p) return;
  if (stageOf(p).stage !== 'comparison') return res.status(400).json({ error: 'Not expecting the comparison.' });
  const c = req.body.answers || {}; if (!c.trustedMore || !c.easier || !(c.comfort >= 1 && c.comfort <= 7)) return res.status(400).json({ error: 'Please answer every question.' });
  p.s2.comparison = { ...c, at: new Date().toISOString() }; saveP(p); logEvent(p.pid, 'comparison', c); res.json(stateFor(p));
}));
app.post('/api/purpose', queued((req, res) => { const p = getP(req, res); if (!p) return; if (stageOf(p).stage !== 'purpose') return res.status(400).json({ error: 'Not expecting this.' }); p.s2.purpose = { text: String(req.body.text || ''), at: new Date().toISOString() }; saveP(p); logEvent(p.pid, 'purpose', p.s2.purpose); res.json(stateFor(p)); }));
app.post('/api/interview', queued((req, res) => { const p = getP(req, res); if (!p) return; if (stageOf(p).stage !== 'interview') return res.status(400).json({ error: 'Not expecting this.' }); p.s2.interviewNotes = { text: String(req.body.text || ''), at: new Date().toISOString() }; saveP(p); logEvent(p.pid, 'interview', p.s2.interviewNotes); res.json(stateFor(p)); }));

app.post('/api/balanced-version', queued(async (req, res) => {
  const p = getP(req, res); if (!p) return;
  const { b, c, i } = req.body; const conv = (p.s2.blocks[b] || {}).convs?.[c]; const t = conv && conv.turns[i];
  if (!t) return res.status(400).json({ error: 'No such answer.' });
  if (t.balancedVersion) return res.json({ text: t.balancedVersion });
  try {
    const tmp = { kind: conv.kind, topicId: conv.topicId, turns: conv.turns.slice(0, i) };
    const gen = await generate(p, tmp, 'balanced', t.user);
    t.balancedVersion = gen.sentences.map(s => s.text).join(' ');
    saveP(p); logEvent(p.pid, 'balancedVersion', { b, c, i, text: t.balancedVersion });
    res.json({ text: t.balancedVersion });
  } catch (e) { res.status(502).json({ error: 'Could not generate the balanced version right now.' }); }
}));
app.post('/api/debrief-seen', queued((req, res) => { const p = getP(req, res); if (!p) return; p.s2.debriefSeen = true; saveP(p); logEvent(p.pid, 'debriefSeen', {}); res.json(stateFor(p)); }));
app.post('/api/withdraw', queued((req, res) => { const p = getP(req, res); if (!p) return; p.s2.withdrawn = true; p.s2.debriefSeen = true; saveP(p); logEvent(p.pid, 'withdraw', {}); res.json(stateFor(p)); }));
app.post('/api/event', (req, res) => { const p = loadP(String(req.body.pid || '').toUpperCase()); if (!p) return res.status(404).end(); logEvent(p.pid, 'ui', { ...req.body, pid: undefined }); res.json({ ok: true }); });

// ---------------------------------------------------------------- API: researcher
function researcherAuth(req, res, next) {
  if (!RESEARCHER_KEY) return next();
  if (req.get('x-researcher-key') === RESEARCHER_KEY) return next();
  res.status(401).json({ error: 'Researcher key required.' });
}
app.use('/api/r', researcherAuth);
app.get('/api/r/status', (req, res) => {
  const list = fs.readdirSync(PART_DIR).filter(f => f.endsWith('.json')).map(f => loadP(f.replace('.json', ''))).filter(Boolean)
    .sort((a, b) => parseInt(a.pid.slice(1)) - parseInt(b.pid.slice(1)))
    .map(p => ({ pid: p.pid, stage: stageOf(p), assignment: p.assignment, eligible: p.topics ? p.topics.eligible : null, override: p.override, warnings: topicWarnings(p), topics: p.topics ? { opinion: p.topics.opinion, preference: p.topics.preference } : null, withdrawn: p.s2.withdrawn, memoryItems: p.memory.filter(m => !m.removed).length, turns: p.s2.blocks ? p.s2.blocks.reduce((n, B) => n + B.convs.reduce((m, c) => m + c.turns.length, 0), 0) : 0 }));
  res.json({ mode: LIVE ? 'live' : 'demo', genModel: LIVE ? GEN_MODEL : null, verifyModel: LIVE ? VERIFY_MODEL : null, keyProtected: !!RESEARCHER_KEY, dataDir: DATA_DIR, participants: list, topics: { opinion: TOPICS.opinion.map(t => ({ id: t.id, question: t.question })), preference: TOPICS.preference.map(t => ({ id: t.id, item: t.item })) } });
});
app.post('/api/r/participant', (req, res) => {
  const pid = String(req.body.pid || '').toUpperCase();
  if (!/^P\d{1,2}$/.test(pid)) return res.status(400).json({ error: 'Code must be P followed by a number, e.g. P1.' });
  if (loadP(pid)) return res.status(400).json({ error: 'That code already exists.' });
  const p = newParticipant(pid); saveP(p); logEvent(pid, 'created', { assignment: p.assignment });
  res.json({ ok: true, participant: p });
});
app.get('/api/r/participant/:pid', (req, res) => { const p = loadP(req.params.pid.toUpperCase()); if (!p) return res.status(404).json({ error: 'Unknown participant.' }); res.json({ participant: p, stage: stageOf(p) }); });
app.get('/api/r/export/:pid', (req, res) => {
  const pid = req.params.pid.toUpperCase(); const p = loadP(pid); if (!p) return res.status(404).json({ error: 'Unknown participant.' });
  const ev = fs.existsSync(path.join(LOG_DIR, pid + '.jsonl')) ? fs.readFileSync(path.join(LOG_DIR, pid + '.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  res.setHeader('content-disposition', `attachment; filename="${pid}-export.json"`);
  res.json({ exportedAt: new Date().toISOString(), mode: LIVE ? 'live' : 'demo', participant: p, events: ev });
});
app.post('/api/r/override', queued((req, res) => {
  const p = loadP(String(req.body.pid || '').toUpperCase()); if (!p) return res.status(404).json({ error: 'Unknown participant.' });
  if (!p.topics) return res.status(400).json({ error: 'Session 1 not done yet.' });
  if (p.s2.blocks && p.s2.blocks.some(B => B.convs.some(c => c.turns.length))) return res.status(400).json({ error: 'Session 2 has started: changing the topics would delete the conversations. Reset Session 2 first if the topics must change.' });
  const { opinion, preference } = req.body;
  const okIds = (arr, list) => Array.isArray(arr) && arr.length === 2 && arr[0] !== arr[1] && arr.every(id => list.some(t => t.id === id));
  if (!okIds(opinion, TOPICS.opinion) || !okIds(preference, TOPICS.preference)) return res.status(400).json({ error: 'Choose two different opinion topics and two different preference topics.' });
  p.topics.opinion = opinion; p.topics.preference = preference;
  p.override = true; initBlocks(p); saveP(p); logEvent(p.pid, 'override', { opinion: p.topics.opinion, preference: p.topics.preference });
  res.json({ ok: true });
}));
app.post('/api/r/start-s2', queued((req, res) => {
  const p = loadP(String(req.body.pid || '').toUpperCase()); if (!p) return res.status(404).json({ error: 'Unknown participant.' });
  if (!p.topics) return res.status(400).json({ error: 'Session 1 not done yet.' });
  p.s2.started = new Date().toISOString(); saveP(p); logEvent(p.pid, 'startSession2', {}); res.json({ ok: true });
}));
app.post('/api/r/delete', queued((req, res) => {
  const pid = String(req.body.pid || '').toUpperCase(); if (!loadP(pid)) return res.status(404).json({ error: 'Unknown participant.' });
  fs.rmSync(pfile(pid), { force: true }); fs.rmSync(path.join(LOG_DIR, pid + '.jsonl'), { force: true });
  res.json({ ok: true });
}));
app.post('/api/r/reset', queued((req, res) => {
  const pid = String(req.body.pid || '').toUpperCase(); const p = loadP(pid); if (!p) return res.status(404).json({ error: 'Unknown participant.' });
  const what = req.body.what || 'session2';
  if (what === 'all') { const np = newParticipant(pid); saveP(np); }
  else { p.s2 = newParticipant(pid).s2; if (p.topics) initBlocks(p); for (const m of p.memory) m.removed = false; saveP(p); }
  logEvent(pid, 'reset', { what }); res.json({ ok: true });
}));

app.get('/researcher', (req, res) => res.sendFile(path.join(__dirname, 'public', 'researcher.html')));
app.get('/health', (req, res) => res.json({ ok: true, mode: LIVE ? 'live' : 'demo', version: require('./package.json').version, dataDir: DATA_DIR, participants: fs.readdirSync(PART_DIR).filter(f => f.endsWith('.json')).length }));

app.listen(PORT, '0.0.0.0', () => console.log(`Study tool listening on ${PORT} in ${LIVE ? 'LIVE' : 'DEMO'} mode; data in ${DATA_DIR}`));
