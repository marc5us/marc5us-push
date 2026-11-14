// marc5us Schule – Push-Dienst. Wird von poll.js eingebunden: require('./schule').start();
const admin = require('firebase-admin');

const DBURL = 'https://marc5us-schule-default-rtdb.europe-west1.firebasedatabase.app';
const DEAD = /registration-token-not-registered|invalid-registration-token/;
const DK = ['', 'mon', 'tue', 'wed', 'thu', 'fri', ''];
const DEF = { on: false, lead: 1, time: '17:00', mat: true, tests: true, testDays: [14, 7, 3, 1],
  bad: true, badMin: 4, badChance: 50, motiv: false, motivTime: '08:00', qOn: false, qFrom: '21:00', qTo: '07:00' };
const MOT = ['Kleine Schritte jeden Tag schlagen den großen Sprint am Abend davor.',
  'Du musst nicht perfekt sein. Du musst heute nur ein kleines Stück weiterkommen.',
  'Fehler sind Notizen für deinen nächsten Erfolg.',
  'Zehn Minuten Lernen sind besser als gar keine. Fang einfach an.',
  'Der schwierigste Teil ist der Anfang. Danach wird es leichter.',
  'Wer heute übt, muss morgen nicht panisch lernen.',
  'Dein Ziel ist nicht die Eins, sondern dass du weißt, was du kannst.',
  'Konzentration ist wie ein Muskel: Trainiere sie mit kurzen, ruhigen Einheiten.',
  'Pausen gehören zum Lernen. Mach eine, dann kommst du freier zurück.',
  'Jede Aufgabe, die du schaffst, macht die nächste ein bisschen leichter.',
  'Du bist nicht schlechter als andere. Du bist noch am Lernen.',
  'Heute ein bisschen mehr als gestern. Mehr ist nicht nötig. – marc5us'];
const BADM = ['Eine schwache Note ist ein Hinweis, kein Urteil. Lern heute 15 Minuten {fach}.',
  '{fach}: 10 Minuten wiederholen reichen, um dranzubleiben.',
  'Kurz vor dem nächsten Test lohnt sich {fach}. Fang mit dem Schwersten an.'];
const TIPS = ['Aktives Abrufen: Buch zu und aufschreiben, was du noch weißt.',
  'Lerne in kurzen Einheiten von 25 Minuten mit kleinen Pausen.',
  'Erkläre den Stoff laut, als würdest du ihn jemandem beibringen.',
  'Mach Probeaufgaben unter Zeitdruck, nicht nur Durchlesen.'];

const L = o => Object.entries(o || {});
const days = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const cdTxt = d => d === 0 ? 'heute' : d === 1 ? 'morgen' : 'in ' + d + ' Tagen';

function berlin() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function quiet(s, hm) {
  if (!s.qOn) return false;
  return s.qFrom < s.qTo ? (hm >= s.qFrom && hm < s.qTo) : (hm >= s.qFrom || hm < s.qTo);
}
function lessonNums(c) {
  const g = c.content?.grid, raw = g ? Object.values(g) : [];
  const rows = raw.length ? raw : Array.from({ length: 10 }, (_, i) => ({ t: 'les', n: i + 1 }));
  return rows.filter(r => r.t !== 'pause').map(r => r.n);
}
function subjAt(c, n, dk) {
  const x = c.content?.timetable?.[n]?.[dk];
  return x ? c.content?.subjects?.[x.s] : null;
}
async function once(db, uid, k) {
  const r = await db.ref(`users/${uid}/pushSent/${k}`).transaction(v => v ? undefined : { ts: Date.now() });
  return r.committed;
}
async function sendTo(ctx, uid, tokenMap, title, body) {
  const seen = new Map();
  for (const [k, v] of L(tokenMap)) if (v && v.token && !seen.has(v.token)) seen.set(v.token, k);
  const entries = [...seen.entries()];
  if (!entries.length) return;
  const res = await ctx.msg.sendEachForMulticast({ tokens: entries.map(([t]) => t),
    data: { title, body, tag: 'marc5us-schule' }, webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: '/' } } });
  await Promise.all(res.responses.map((r, i) => (!r.success && DEAD.test(r.error?.code || ''))
    ? ctx.db.ref(`users/${uid}/pushTokens/${entries[i][1]}`).remove() : null));
  console.log('Schule-Push an', uid, '→', title, '| ok', res.successCount, 'Fehler', res.failureCount);
}

async function runUser(ctx, uid, c) {
  const tokenMap = c.pushTokens || {};
  for (const [rid, r] of L(c.pushRequests)) {
    await ctx.db.ref(`users/${uid}/pushRequests/${rid}`).remove();
    if (!r || typeof r.ts !== 'number' || Date.now() - r.ts > 3600e3) continue;
    await sendTo(ctx, uid, tokenMap, 'marc5us Schule 🔔', 'Test erfolgreich! So kommen deine Erinnerungen an.');
  }
  if (!L(tokenMap).length) return;
  const s = { ...DEF, ...(c.pushSettings || {}) };
  const now = berlin();
  if (quiet(s, now.hm)) return;
  const send = (t, b) => sendTo(ctx, uid, tokenMap, t, b);
  const subs = c.content?.subjects || {};

  // Klassenarbeiten
  if (s.tests) for (const [id, t] of L(c.content?.tests)) {
    const sub = subs[t.subject]; if (!sub || !t.date) continue;
    const d = days(t.date, now.date); if (d < 0) continue;
    if (!(d === 0 || s.testDays.includes(d))) continue;
    if (!(await once(ctx.db, uid, `t_${id}_${d}`))) continue;
    await send(`📝 Klassenarbeit ${cdTxt(d)}`, `${sub.name}${t.topic ? ': ' + t.topic : ''} – ${pick(TIPS)}`);
  }

  // Schlechte Noten
  if (s.bad) for (const [, x] of L(subs)) for (const [gid, g] of L(x.grades)) {
    if (!(g.value >= s.badMin) || !g.date) continue;
    if (days(now.date, g.date) > 3) continue;
    if (!(await once(ctx.db, uid, `g_${gid}`))) continue;
    if (Math.random() * 100 >= s.badChance) continue;
    await send(`Lern kurz für ${x.name}`, pick(BADM).replace('{fach}', x.name));
  }

  // Motivation
  if (s.motiv && now.hm >= s.motivTime && await once(ctx.db, uid, `m_${now.date}`))
    await send('marc5us 💪', MOT[Number(now.date.replace(/-/g, '')) % MOT.length]);

  // Tagesübersicht: Hausaufgaben und Mitnehmen
  if (s.on && now.hm >= s.time && await once(ctx.db, uid, `d_${now.date}`)) {
    const out = [], hw = [];
    for (const [, x] of L(subs)) for (const [, h] of L(x.homeworkHistory)) {
      if (h.done || !/^\d{4}-/.test(h.dueDate || '')) continue;
      const d = days(h.dueDate, now.date);
      if (d <= s.lead) hw.push(`${x.short}: ${h.task}${d < 0 ? ' (überfällig)' : d === 0 ? ' (heute)' : d === 1 ? ' (morgen)' : ''}`);
    }
    if (hw.length) out.push('Hausaufgaben: ' + hw.slice(0, 5).join(' · '));
    const dk = DK[(now.wd + 1) % 7];
    if (s.mat && dk) {
      const m = [];
      for (const n of lessonNums(c)) { const x = subjAt(c, n, dk);
        if (x?.materials && !m.includes(x.short + ': ' + x.materials)) m.push(x.short + ': ' + x.materials); }
      if (m.length) out.push('Morgen mitnehmen: ' + m.join(' · '));
    }
    if (out.length) await send('marc5us Schule 📚', out.join('\n'));
  }
}

function start() {
  try { startInner(); } catch (e) { console.error('schule: Start fehlgeschlagen, übersprungen:', e.message); }
}
function startInner() {
  if (!process.env.SERVICE_ACCOUNT_SCHULE) { console.log('schule: kein Secret SERVICE_ACCOUNT_SCHULE, übersprungen'); return; }
  const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT_SCHULE)),
    databaseURL: DBURL }, 'schule');
  const ctx = { db: app.database(), msg: app.messaging() };
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const users = (await ctx.db.ref('users').get()).val() || {};
      for (const [uid, c] of Object.entries(users)) {
        if (!c || typeof c !== 'object') continue;
        try { await runUser(ctx, uid, c); } catch (e) { console.error('schule', uid, e.message); }
      }
    } catch (e) { console.error('schule tick', e.message); }
    finally { busy = false; }
  };
  setInterval(tick, 60 * 1000);
  tick();
  console.log('schule: Push-Dienst gestartet');
}
module.exports = { start };
