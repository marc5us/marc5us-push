// marc5us Push-Abfrage: läuft alle 5 Minuten über GitHub Actions und speichert den letzten Stand in der Datenbank
const admin=require('firebase-admin');
admin.initializeApp({credential:admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT_JSON)),
  databaseURL:'https://marc5us-75fcb-default-rtdb.europe-west1.firebasedatabase.app'});
const db=admin.database();
const ADMIN_UIDS=['IATfMFsAh6QIpNR6KmyuqCABmI53','RuuPV3CgKrT46TuxFybCvGvkwbv2'];
const ADMIN_NAME='Marc Chmelnizki';

async function send(uid,title,body){
  try{
    const snap=await db.ref('pushTokens/'+uid).get();
    const tokens=Object.keys(snap.val()||{});
    if(!tokens.length)return;
    const res=await admin.messaging().sendEachForMulticast({tokens,notification:{title,body},
      webpush:{notification:{icon:'/icons/icon-192.png',badge:'/icons/icon-192.png'},fcmOptions:{link:'/'}}});
    await Promise.all(res.responses.map((r,i)=>(!r.success&&/registration-token-not-registered|invalid-registration-token/.test(r.error?.code||''))
      ?db.ref(`pushTokens/${uid}/${tokens[i]}`).remove():null));
  }catch(e){console.error('Push-Fehler',uid,e.message)}
}

const pick=t=>({s:t.tripStatus||'',d:String(t.delayMinutes??0)});

async function main(){
  const [clientsSnap,reqSnap,testSnap,stateSnap]=await Promise.all([
    db.ref('clients').get(),db.ref('requests').get(),db.ref('pushTests').get(),db.ref('serverState').get()]);
  const clients=clientsSnap.val()||{},requests=reqSnap.val()||{},tests=testSnap.val()||{};
  const old=stateSnap.val(),first=!old;
  const oldTrips=(old&&old.trips)||{},oldReq=(old&&old.requests)||{};
  const st={trips:{},requests:{}},jobs=[];

  // Fahrten
  for(const [uid,c] of Object.entries(clients)){
    for(const [key,t] of Object.entries(c.trips||{})){
      const now=pick(t);
      (st.trips[uid]=st.trips[uid]||{})[key]=now;
      const prev=(oldTrips[uid]||{})[key];
      if(first||!prev)continue;
      if(prev.s===now.s&&prev.d===now.d)continue;
      if(now.s==='cancelled'){
        if(prev.s!=='cancelled'){
          jobs.push(send(uid,'Fahrt abgesagt',`Storniert um ${t.cancelledAtFormatted||''} von ${t.cancelledBy||ADMIN_NAME}`));
          if(t.cancelledBy!==ADMIN_NAME)ADMIN_UIDS.forEach(a=>jobs.push(send(a,'Fahrt storniert',`${uid} hat storniert`)));
        }
        continue;
      }
      if(now.s!=='active')continue;
      const d=parseInt(t.delayMinutes)||0;
      jobs.push(send(uid,'marc5us – Fahrtupdate',d>0?`Leichte Verspätung: +${d} Min.`:d<0?`${d} Min. früher`:'Pünktlich'));
    }
  }

  // Fahrtanfragen
  for(const [id,r] of Object.entries(requests)){
    st.requests[id]=r.status||'';
    if(first)continue;
    if(!(id in oldReq)){ADMIN_UIDS.forEach(a=>jobs.push(send(a,'Neue Fahrtanfrage',`${r.clientName||'Kunde'}: ${r.destAddr||''}`)));continue}
    if(oldReq[id]!==r.status&&r.status!=='pending'&&r.code)
      jobs.push(send(r.code,'Fahrtanfrage',r.status==='accepted'?'Deine Fahrt wurde angenommen.':'Deine Anfrage wurde abgelehnt.'));
  }

  // Test-Button (Einträge älter als 1 Stunde werden verworfen)
  for(const [uid,entries] of Object.entries(tests)){
    for(const [id,v] of Object.entries(entries||{})){
      if((v&&v.ts||0)>Date.now()-3600000)jobs.push(send(uid,'marc5us – Server-Test','Push-Benachrichtigungen funktionieren.'));
      jobs.push(db.ref(`pushTests/${uid}/${id}`).remove());
    }
  }

  await Promise.all(jobs);
  await db.ref('serverState').set(st);
  console.log(first?'Erster Lauf: Stand gespeichert, keine Nachrichten.':`Geprüft, ${jobs.length} Aktionen.`);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1)});
