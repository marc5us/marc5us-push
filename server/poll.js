// marc5us Push-Dienst: läuft dauerhaft (z. B. Render Background Worker)
// und reagiert sofort auf Änderungen in der Datenbank.
// Bedient zwei Firebase-Projekte:
//   marc5us-75fcb    -> Secret SERVICE_ACCOUNT_JSON
//   marc5us-massagen -> Secret SERVICE_ACCOUNT_MASSAGEN
const admin = require('firebase-admin');

const fis = admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT_JSON)),
  databaseURL: 'https://marc5us-75fcb-default-rtdb.europe-west1.firebasedatabase.app'
}, 'fis');

const massagen = admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT_MASSAGEN)),
  databaseURL: 'https://marc5us-massagen-default-rtdb.europe-west1.firebasedatabase.app'
}, 'massagen');

const DEAD = /registration-token-not-registered|invalid-registration-token/;

// =====================================================================
// PROJEKT marc5us-75fcb (unverändert)
// =====================================================================
const db = fis.database();
const fmsg = fis.messaging();
const ADMIN_UIDS = ['IATfMFsAh6QIpNR6KmyuqCABmI53', 'RuuPV3CgKrT46TuxFybCvGvkwbv2'];
const ADMIN_NAME = 'Marc Chmelnizki';

async function send(uid, title, body) {
  try {
    const snap = await db.ref('pushTokens/' + uid).get();
    const tokens = Object.keys(snap.val() || {});
    if (!tokens.length) return;
    const res = await fmsg.sendEachForMulticast({ tokens, notification: { title, body },
      webpush: { notification: { icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' }, fcmOptions: { link: '/' } } });
    await Promise.all(res.responses.map((r, i) => (!r.success && DEAD.test(r.error?.code || ''))
      ? db.ref(`pushTokens/${uid}/${tokens[i]}`).remove() : null));
  } catch (e) { console.error('Push-Fehler', uid, e.message); }
}

const pick = t => ({ s: t.tripStatus || '', d: String(t.delayMinutes ?? 0) });

async function runFis() {
  const [clientsSnap, reqSnap, testSnap, stateSnap] = await Promise.all([
    db.ref('clients').get(), db.ref('requests').get(), db.ref('pushTests').get(), db.ref('serverState').get()]);
  const clients = clientsSnap.val() || {}, requests = reqSnap.val() || {}, tests = testSnap.val() || {};
  const old = stateSnap.val(), first = !old;
  const oldTrips = (old && old.trips) || {}, oldReq = (old && old.requests) || {};
  const st = { trips: {}, requests: {} }, jobs = [];

  // Fahrten
  for (const [uid, c] of Object.entries(clients)) {
    for (const [key, t] of Object.entries(c.trips || {})) {
      const now = pick(t);
      (st.trips[uid] = st.trips[uid] || {})[key] = now;
      const prev = (oldTrips[uid] || {})[key];
      if (first || !prev) continue;
      if (prev.s === now.s && prev.d === now.d) continue;
      if (now.s === 'cancelled') {
        if (prev.s !== 'cancelled') {
          jobs.push(send(uid, 'Fahrt abgesagt', `Storniert um ${t.cancelledAtFormatted || ''} von ${t.cancelledBy || ADMIN_NAME}`));
          if (t.cancelledBy !== ADMIN_NAME) ADMIN_UIDS.forEach(a => jobs.push(send(a, 'Fahrt storniert', `${uid} hat storniert`)));
        }
        continue;
      }
      if (now.s !== 'active') continue;
      const d = parseInt(t.delayMinutes) || 0;
      jobs.push(send(uid, 'marc5us – Fahrtupdate', d > 0 ? `Leichte Verspätung: +${d} Min.` : d < 0 ? `${d} Min. früher` : 'Pünktlich'));
    }
  }

  // Fahrtanfragen
  for (const [id, r] of Object.entries(requests)) {
    st.requests[id] = r.status || '';
    if (first) continue;
    if (!(id in oldReq)) { ADMIN_UIDS.forEach(a => jobs.push(send(a, 'Neue Fahrtanfrage', `${r.clientName || 'Kunde'}: ${r.destAddr || ''}`))); continue; }
    if (oldReq[id] !== r.status && r.status !== 'pending' && r.code)
      jobs.push(send(r.code, 'Fahrtanfrage', r.status === 'accepted' ? 'Deine Fahrt wurde angenommen.' : 'Deine Anfrage wurde abgelehnt.'));
  }

  // Test-Button (Einträge älter als 1 Stunde werden verworfen)
  for (const [uid, entries] of Object.entries(tests)) {
    for (const [id, v] of Object.entries(entries || {})) {
      if ((v && v.ts || 0) > Date.now() - 3600000) jobs.push(send(uid, 'marc5us – Server-Test', 'Push-Benachrichtigungen funktionieren.'));
      jobs.push(db.ref(`pushTests/${uid}/${id}`).remove());
    }
  }

  await Promise.all(jobs);
  await db.ref('serverState').set(st);
  console.log(first ? 'marc5us-75fcb: Erster Lauf, Stand gespeichert.' : `marc5us-75fcb: geprüft, ${jobs.length} Aktionen.`);
}

// =====================================================================
// PROJEKT marc5us-massagen
// =====================================================================
const mdb = massagen.database();
const mmsg = massagen.messaging();
const M_ADMIN_UIDS = ['yhucvoa4VRYdoMdwrYl4k0AnrfG2', 'hik785QiB1YDSG4YvcwNHvGK7LQ2'];

const toList = v => (Array.isArray(v) ? v : Object.values(v || {}));

// "2026-11-10T14:00" (deutsche Ortszeit) in einen echten Zeitpunkt umrechnen
function parseBerlin(s) {
  const guess = new Date(String(s).slice(0, 16) + ':00Z');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess);
  const g = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const asBerlin = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute);
  return new Date(guess.getTime() - (asBerlin - guess.getTime()));
}
function fmtBerlin(s) {
  return parseBerlin(s).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Data-only-Nachricht, die der Service Worker (firebase-messaging-sw.js) anzeigt
async function mSend(uid, title, body, url = '/') {
  try {
    const snap = await mdb.ref('push_tokens/' + uid).get();
    const entries = Object.entries(snap.val() || {}).filter(([, v]) => v && v.token);
    if (!entries.length) return;
    const res = await mmsg.sendEachForMulticast({
      tokens: entries.map(([, v]) => v.token),
      data: { title, body, url, tag: 'marc5us' },
      webpush: { headers: { Urgency: 'high' }, fcmOptions: { link: url } }
    });
    await Promise.all(res.responses.map((r, i) => (!r.success && DEAD.test(r.error?.code || ''))
      ? mdb.ref(`push_tokens/${uid}/${entries[i][0]}`).remove() : null));
  } catch (e) { console.error('Massagen Push-Fehler', uid, e.message); }
}

async function runMassagen() {
  const [clientsSnap, msgSnap, uidSnap, reqSnap, stateSnap] = await Promise.all([
    mdb.ref('massage_clients').get(), mdb.ref('client_messages').get(), mdb.ref('client_uids').get(),
    mdb.ref('push_requests').get(), mdb.ref('pushState').get()]);
  const clients = clientsSnap.val() || {};
  const messages = msgSnap.val() || {};
  const uidsByClient = {};
  Object.entries(uidSnap.val() || {}).forEach(([uid, key]) => { (uidsByClient[key] = uidsByClient[key] || []).push(uid); });
  const old = stateSnap.val(), first = !old;
  const state = { lastMsg: '', appts: {} };
  const jobs = [];

  // 1) Neue Nachrichten (Admin -> Kunde, Kunde -> Admin)
  let maxTs = (old && old.lastMsg) || '';
  for (const m of Object.values(messages)) {
    if (!m || !m.timestamp) continue;
    if (m.timestamp > maxTs) maxTs = m.timestamp;
    if (first || m.timestamp <= old.lastMsg) continue;
    const body = String(m.text || '').slice(0, 120);
    if (m.sender === 'admin' && m.clientKey) {
      (uidsByClient[m.clientKey] || []).forEach(u => jobs.push(mSend(u, 'Neue Nachricht von Marc', body)));
    } else if (m.sender === 'client') {
      M_ADMIN_UIDS.forEach(u => jobs.push(mSend(u, 'Neue Nachricht von ' + (m.clientName || m.username || 'Kunde'), body)));
    }
  }
  state.lastMsg = maxTs;

  // 2) Termine: neu, bestätigt, storniert, geändert
  const now = Date.now();
  for (const [key, c] of Object.entries(clients)) {
    const list = toList(c.appointments);
    const prevMap = (old && old.appts && old.appts[key]) || {};
    state.appts[key] = {};
    list.forEach((a, i) => { if (a && a.depTime) state.appts[key][i] = { status: a.status || '', depTime: a.depTime, location: a.location || '' }; });
    if (first) continue;

    list.forEach((a, i) => {
      if (!a || !a.depTime) return;
      const b = prevMap[i];
      const where = a.location ? ' · ' + a.location : '';
      let title = null, body = null;
      if (!b) {
        if (a.status === 'aktiv') { title = 'Neuer Termin'; body = 'Am ' + fmtBerlin(a.depTime) + where; }
      } else if (a.status !== b.status) {
        if (a.status === 'storniert') { title = 'Termin storniert'; body = 'Der Termin am ' + fmtBerlin(b.depTime) + ' entfällt.'; }
        else if (a.status === 'aktiv') { title = 'Termin bestätigt'; body = 'Am ' + fmtBerlin(a.depTime) + where; }
      } else if (a.status !== 'storniert' && (a.depTime !== b.depTime || (a.location || '') !== (b.location || ''))) {
        title = 'Termin geändert'; body = 'Neu: ' + fmtBerlin(a.depTime) + where;
      }
      if (title) (uidsByClient[key] || []).forEach(u => jobs.push(mSend(u, title, body)));
    });
  }

  // 3) Terminerinnerung ca. 24 h vorher, jeder Termin nur einmal
  for (const [key, c] of Object.entries(clients)) {
    for (const a of toList(c.appointments)) {
      if (!a || a.status !== 'aktiv' || !a.depTime) continue;
      const diff = parseBerlin(a.depTime).getTime() - now;
      if (diff > 25 * 3600e3 || diff < 23 * 3600e3) continue;
      const flag = mdb.ref('reminders/' + key + '/' + a.depTime.replace(/\D/g, ''));
      if ((await flag.get()).exists()) continue;
      await flag.set(true);
      (uidsByClient[key] || []).forEach(u => jobs.push(mSend(u, 'Terminerinnerung',
        'Dein Termin: ' + fmtBerlin(a.depTime) + (a.location ? ' · ' + a.location : ''))));
    }
  }

  // 4) Test-Pushes aus Kundenmenü und Adminbereich
  for (const [id, r] of Object.entries(reqSnap.val() || {})) {
    if (r && r.toUid) jobs.push(mSend(r.toUid, r.title || 'marc5us Massagen', r.body || 'Test erfolgreich.'));
    jobs.push(mdb.ref('push_requests/' + id).remove());
  }

  await Promise.all(jobs);
  await mdb.ref('pushState').set(state);
  console.log(first ? 'marc5us-massagen: Erster Lauf, Stand gespeichert.' : `marc5us-massagen: geprüft, ${jobs.length} Aktionen.`);
}

// =====================================================================
// =====================================================================
// DAUERBETRIEB: reagiert sofort auf Änderungen statt alle 5 Minuten zu prüfen
// =====================================================================
process.on('unhandledRejection', e => console.error('Unbehandelt:', e));

// Verhindert, dass dieselbe Prüfung parallel läuft; mehrere schnelle Änderungen werden gebündelt
const busy = {}, again = {}, timers = {};
function schedule(name, fn) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(async () => {
    if (busy[name]) { again[name] = true; return; }
    busy[name] = true;
    do {
      again[name] = false;
      try { await fn(); } catch (e) { console.error(name, 'Fehler:', e.message); }
    } while (again[name]);
    busy[name] = false;
  }, 300);
}

function listen(ref, name, fn) {
  ref.on('value', () => schedule(name, fn), e => console.error(name, 'Listener:', e.message));
}

// marc5us-75fcb
listen(db.ref('clients'), 'fis', runFis);
listen(db.ref('requests'), 'fis', runFis);
listen(db.ref('pushTests'), 'fis', runFis);

// marc5us-massagen
listen(mdb.ref('client_messages'), 'massagen', runMassagen);
listen(mdb.ref('massage_clients'), 'massagen', runMassagen);
listen(mdb.ref('client_uids'), 'massagen', runMassagen);
listen(mdb.ref('push_requests'), 'massagen', runMassagen);
// Terminerinnerungen brauchen eine zeitgesteuerte Prüfung, einmal pro Minute
setInterval(() => schedule('massagen', runMassagen), 60 * 1000);

console.log('marc5us Push-Dienst gestartet, wartet auf Änderungen.');
