import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FilesetResolver, GestureRecognizer, PoseLandmarker } from '@mediapipe/tasks-vision';
import { Camera, Pill, ShieldAlert, Trash2, UserRound } from 'lucide-react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './Neo.css'
/* ---------- config ---------- */
const BACKEND = 'http://localhost:5000';      // server.js (sends the real email / call)
const ALERT_SECONDS = 10;
const MED_AUDIO = '/medicine.mpeg';            // file inside your public folder (change the name if needed)
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const GESTURE_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const today = () => new Date().toLocaleDateString('en-CA');
const hhmm = () => new Date().toTimeString().slice(0, 5);

export default function App() {
  const [status, setStatus] = useState('idle'); // idle | loading | running | error
  const [gesture, setGesture] = useState('None');
  const [posture, setPosture] = useState('Not monitoring');
  const [alert, setAlert] = useState(null);     // { reason, remaining }
  const [due, setDue] = useState([]);           // medicines currently ringing
  const [meds, setMeds] = useState(() => load('meds', []));
  const [caregiver, setCaregiver] = useState(() => load('caregiver', { name: '', email: '', phone: '' }));
  const [form, setForm] = useState({ name: '', dosage: '', time: '08:00', mode: 'daily', date: today() });
  const [logs, setLogs] = useState([]);
  const [fallback, setFallback] = useState(null);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const gestureModel = useRef(null);
  const poseModel = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(null);
  const runningRef = useRef(false);
  const lastRunRef = useRef(0);
  const alertRef = useRef(null);
  const alertTimerRef = useRef(null);
  const dueRef = useRef([]);
  const medsRef = useRef(meds);
  const caregiverRef = useRef(caregiver);
  const gestureNameRef = useRef('None');
  const thumbFrames = useRef(0);
  const palmFrames = useRef(0);
  const fall = useRef({ hist: [], dropAt: 0, horizSince: 0, uprightAt: 0 });
  const wakeRef = useRef(null);
  const medAudio = useRef(null);

  useEffect(() => { medsRef.current = meds; localStorage.setItem('meds', JSON.stringify(meds)); }, [meds]);
  useEffect(() => { caregiverRef.current = caregiver; localStorage.setItem('caregiver', JSON.stringify(caregiver)); }, [caregiver]);

  const log = (msg, level = 'secondary') =>
    setLogs(l => [{ id: Date.now() + Math.random(), t: new Date().toLocaleTimeString(), msg, level }, ...l].slice(0, 40));

  /* ---------- sound + speech ---------- */
  const tone = (freq, dur = 0.25, type = 'sine', vol = 0.25, delay = 0) => {
    const ctx = audioRef.current;
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t); o.stop(t + dur);
  };
  const alarmSound = () => { tone(900, 0.3, 'sawtooth', 0.35); tone(600, 0.3, 'sawtooth', 0.35, 0.35); };
  const chime = () => { tone(660, 0.25); tone(880, 0.25, 'sine', 0.25, 0.28); tone(1100, 0.4, 'sine', 0.25, 0.56); };
  const speak = msg => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(msg));
  };

  /* ---------- contact caregiver (real) ---------- */
  const contactCaregiver = async reason => {
    const c = caregiverRef.current;
    if (!c.email && !c.phone) { log('No caregiver contact saved. Nobody was notified.', 'danger'); return; }
    log(`Contacting caregiver (${reason})…`, 'danger');
    try {
      const r = await fetch(`${BACKEND}/api/alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, time: new Date().toLocaleString(), caregiver: c })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Server error');
      (d.results || []).forEach(x => log(`${x.channel}: ${x.ok ? 'sent' : 'failed - ' + x.error}`, x.ok ? 'success' : 'danger'));
      if ((d.results || []).some(x => !x.ok)) throw new Error('partial failure');
    } catch (e) {
      log(`Server unreachable or failed (${e.message}). Use the manual buttons.`, 'danger');
      const body = `EMERGENCY: ${reason} at ${new Date().toLocaleString()}. Please check on them now.`;
      setFallback({
        tel: c.phone ? `tel:${c.phone}` : null,
        sms: c.phone ? `sms:${c.phone}?body=${encodeURIComponent(body)}` : null,
        mail: c.email ? `mailto:${c.email}?subject=${encodeURIComponent('EMERGENCY alert')}&body=${encodeURIComponent(body)}` : null
      });
    }
  };

  /* ---------- 10 second danger countdown ---------- */
  const startAlert = reason => {
    if (alertRef.current) return;
    alertRef.current = { reason, remaining: ALERT_SECONDS };
    setAlert({ ...alertRef.current });
    setFallback(null);
    log(`DANGER: ${reason}. Show thumbs up within ${ALERT_SECONDS}s to cancel.`, 'danger');
    speak(`Danger detected. ${reason}. Show a thumbs up to cancel.`);
    alarmSound();
    alertTimerRef.current = setInterval(() => {
      const a = alertRef.current;
      if (!a) return;
      a.remaining -= 1;
      setAlert({ ...a });
      if (a.remaining > 0) { alarmSound(); return; }
      clearInterval(alertTimerRef.current);
      alertRef.current = null;
      setAlert(null);
      speak('No response. Contacting your caregiver.');
      contactCaregiver(a.reason);
    }, 1000);
  };

  const cancelAlert = by => {
    if (!alertRef.current) return;
    clearInterval(alertTimerRef.current);
    alertRef.current = null;
    setAlert(null);
    fall.current = { hist: [], dropAt: 0, horizSince: 0, uprightAt: 0 };
    log(`Alert cancelled (${by}). Caregiver not contacted.`, 'success');
    speak('Alert cancelled.');
    chime();
  };

  /* ---------- medicines ---------- */
  const setDueBoth = list => { dueRef.current = list; setDue(list); };

  // thumbs up confirms every medicine that is currently ringing
  const confirmAll = () => {
    const ids = dueRef.current.map(d => d.id);
    if (!ids.length) return;
    const names = medsRef.current.filter(m => ids.includes(m.id)).map(m => m.name).join(', ');
    setDueBoth([]);
    setMeds(list => list.map(x => (ids.includes(x.id) ? { ...x, takenDate: today() } : x)));
    log(`Thumbs up: ${names} marked as taken.`, 'success');
  };

  const addMed = e => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const med = { id: Date.now(), name: form.name.trim(), dosage: form.dosage, time: form.time, mode: form.mode, date: form.mode === 'date' ? form.date : '', lastFired: '', takenDate: '' };
    setMeds(l => [...l, med]);
    log(`Scheduled ${med.name} at ${med.time} (${med.mode === 'daily' ? 'every day' : med.date}).`);
    setForm({ ...form, name: '', dosage: '' });
  };

  const medDueToday = m => m.mode === 'daily' || m.date === today();

  // check the clock every second
  useEffect(() => {
    const iv = setInterval(() => {
      const now = hhmm(), d = today();
      medsRef.current.forEach(m => {
        if (medDueToday(m) && m.time === now && m.lastFired !== d && !dueRef.current.some(x => x.id === m.id)) {
          setMeds(list => list.map(x => (x.id === m.id ? { ...x, lastFired: d } : x)));
          setDueBoth([...dueRef.current, { id: m.id, at: Date.now() }]);
          log(`Time to take ${m.name} (${m.dosage || 'dose'}). Show a thumbs up to stop the sound.`, 'warning');
        }
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // play the audio file on loop while a medicine is due; it stops only after a thumbs up
  // (it pauses during a danger alert so the alarm is heard, then resumes)
  useEffect(() => {
    const a = medAudio.current;
    if (!a) return;
    if (due.length && !alert) a.play().catch(e => log(`Could not play ${MED_AUDIO}: ${e.message}`, 'danger'));
    else a.pause();
    if (!due.length) a.currentTime = 0;
  }, [due.length, !!alert]);

  /* ---------- detection ---------- */
  const onThumbsUp = () => {
    if (alertRef.current) cancelAlert('thumbs up');
    else confirmAll();
  };

  const handleGesture = res => {
    const top = res.gestures?.[0]?.[0];
    const name = top && top.score > 0.6 ? top.categoryName : 'None';
    if (name !== gestureNameRef.current) { gestureNameRef.current = name; setGesture(name); }

    thumbFrames.current = name === 'Thumb_Up' ? thumbFrames.current + 1 : 0;
    if (thumbFrames.current === 3) onThumbsUp();                 // ~0.3 s hold

    palmFrames.current = name === 'Open_Palm' ? palmFrames.current + 1 : 0;
    if (palmFrames.current === 20) startAlert('Help signal: open palm held');   // ~2 s hold
  };

  const handlePose = (res, now, v) => {
    const lm = res.landmarks?.[0];
    const f = fall.current;
    if (!lm) { setPosture('No person in view'); f.horizSince = 0; return; }
    const ok = i => (lm[i].visibility ?? 1) > 0.3;
    if (!(ok(11) && ok(12) && ok(23) && ok(24))) { setPosture('Body partly out of view'); return; }

    const W = v.videoWidth, H = v.videoHeight;
    const sh = { x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2 };
    const hip = { x: (lm[23].x + lm[24].x) / 2, y: (lm[23].y + lm[24].y) / 2 };
    const torso = Math.hypot((sh.x - hip.x) * W, (sh.y - hip.y) * H) || 1;
    const angle = (Math.atan2(Math.abs(sh.x - hip.x) * W, Math.abs(sh.y - hip.y) * H) * 180) / Math.PI; // 0 = upright, 90 = flat
    const xs = lm.map(p => p.x * W), ys = lm.map(p => p.y * H);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    const horizontal = angle > 55 || bw > bh * 1.25;

    // remember the last moment the person was clearly upright
    if (angle < 35 && bh > bw) f.uprightAt = now;

    // sudden drop of the hips within ~1 s
    f.hist.push({ t: now, y: hip.y });
    f.hist = f.hist.filter(h => now - h.t < 1000);
    if (hip.y - f.hist[0].y > 0.12) f.dropAt = now;

    if (horizontal) {
      if (!f.horizSince) f.horizSince = now;
      const lyingFor = now - f.horizSince;
      const sudden = now - f.dropAt < 4000 || now - f.uprightAt < 3000;   // was standing a moment ago
      if ((lyingFor > 1500 && sudden) || lyingFor > 8000) {               // sudden fall, or lying for 8 s
        setPosture('FALLEN');
        startAlert(sudden ? 'Fall detected' : 'Person has been lying down and not getting up');
        return;
      }
      setPosture('Lying down');
    } else {
      f.horizSince = 0;
      const knee = ok(25) && ok(26) ? (lm[25].y + lm[26].y) / 2 : null;
      const sitting = knee !== null && (knee - hip.y) * H < torso * 0.6;
      setPosture(sitting ? 'Sitting (OK)' : 'Standing (OK)');
    }
  };

  const draw = (pose, v) => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const lm = pose.landmarks?.[0];
    if (!lm) return;
    ctx.fillStyle = alertRef.current ? '#ff4d4f' : '#3ddc97';
    lm.forEach(p => { ctx.beginPath(); ctx.arc(p.x * c.width, p.y * c.height, 4, 0, 7); ctx.fill(); });
  };

  const loop = () => {
    if (!runningRef.current) return;
    const v = videoRef.current, now = performance.now();
    if (v && v.readyState >= 2 && now - lastRunRef.current > 100) {   // ~10 fps
      lastRunRef.current = now;
      try {
        handleGesture(gestureModel.current.recognizeForVideo(v, now));
        const pose = poseModel.current.detectForVideo(v, now);
        handlePose(pose, now, v);
        draw(pose, v);
      } catch (e) { console.warn(e); }
    }
    rafRef.current = requestAnimationFrame(loop);
  };

  const makeModels = async delegate => {
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    gestureModel.current = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: GESTURE_MODEL, delegate }, runningMode: 'VIDEO', numHands: 1
    });
    poseModel.current = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate }, runningMode: 'VIDEO', numPoses: 1
    });
  };

  const start = async () => {
    setStatus('loading');
    try {
      // must happen inside the click so the browser allows sound
      audioRef.current = audioRef.current || new (window.AudioContext || window.webkitAudioContext)();
      await audioRef.current.resume();
      speak('Monitoring started.');
      medAudio.current = new Audio(MED_AUDIO);
      medAudio.current.loop = true;
      await medAudio.current.play().then(() => { medAudio.current.pause(); medAudio.current.currentTime = 0; }).catch(() => log(`Could not load ${MED_AUDIO}. Check that it is in your public folder.`, 'danger'));

      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 540, facingMode: 'user' }, audio: false });
      videoRef.current.srcObject = streamRef.current;
      await videoRef.current.play();

      try { await makeModels('GPU'); } catch { await makeModels('CPU'); }

      try { wakeRef.current = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
      runningRef.current = true;
      setStatus('running');
      log('Monitoring started.', 'success');
      loop();
    } catch (e) {
      console.error(e);
      setStatus('error');
      log(`Could not start: ${e.message}`, 'danger');
    }
  };

  const stop = useCallback(() => {
    runningRef.current = false;
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    wakeRef.current?.release?.();
    medAudio.current?.pause();
    setStatus('idle'); setPosture('Not monitoring'); setGesture('None');
  }, []);

  useEffect(() => () => { stop(); clearInterval(alertTimerRef.current); window.speechSynthesis?.cancel(); }, [stop]);

  /* ---------- UI ---------- */
  const pct = alert ? (alert.remaining / ALERT_SECONDS) * 100 : 0;
  const gestureLabel = { Thumb_Up: 'Thumbs up', Open_Palm: 'Open palm', None: 'None' }[gesture] || gesture;

  return (
    <div data-bs-theme="dark" className="min-vh-100 bg-body">
      <div className="container-xl py-4">
        <div className="d-flex align-items-center gap-2 mb-4">
          <ShieldAlert size={26} className="text-success" />
          <h1 className="h4 mb-0">ElderCare Sentinel</h1>
          <span className={`badge ms-auto ${status === 'running' ? 'text-bg-success' : 'text-bg-secondary'}`}>
            {status === 'running' ? 'Monitoring' : status === 'loading' ? 'Loading models…' : 'Stopped'}
          </span>
        </div>

        <div className="row g-4">
          {/* camera column */}
          <div className="col-lg-7">
            <div className="position-relative rounded overflow-hidden bg-black" style={{ aspectRatio: '16/9' }}>
              <video ref={videoRef} playsInline muted className="w-100 h-100" style={{ transform: 'scaleX(-1)', objectFit: 'cover' }} />
              <canvas ref={canvasRef} className="position-absolute top-0 start-0 w-100 h-100" style={{ transform: 'scaleX(-1)', pointerEvents: 'none' }} />
              {status !== 'running' && (
                <div className="position-absolute top-0 start-0 w-100 h-100 d-flex flex-column align-items-center justify-content-center gap-2 text-center p-3">
                  <Camera size={40} />
                  <div>Camera and sound need your permission once.</div>
                  <button className="btn btn-success" disabled={status === 'loading'} onClick={start}>
                    {status === 'loading' ? 'Loading…' : 'Start monitoring'}
                  </button>
                </div>
              )}
              {alert && (
                <div className="position-absolute top-0 start-0 w-100 h-100 d-flex flex-column align-items-center justify-content-center text-center p-3"
                     style={{ background: 'rgba(160,0,0,.88)' }}>
                  <h2 className="display-6 fw-bold">{alert.reason}</h2>
                  <div style={{ fontSize: '6rem', lineHeight: 1 }} className="fw-bold">{alert.remaining}</div>
                  <p className="fs-5 my-3">Show a thumbs up to cancel. Otherwise your caregiver will be contacted.</p>
                  <div className="progress w-50 mb-3" style={{ height: 8 }}><div className="progress-bar bg-light" style={{ width: `${pct}%`, transition: 'width 1s linear' }} /></div>
                  <button className="btn btn-light" onClick={() => cancelAlert('button')}>I'm OK - cancel</button>
                </div>
              )}
              {!alert && due.length > 0 && (
                <div className="position-absolute bottom-0 start-0 w-100 p-3 d-flex align-items-center gap-3" style={{ background: 'rgba(0,0,0,.85)' }}>
                  <Pill className="text-warning" />
                  <div>
                    <strong>{due.map(d => meds.find(m => m.id === d.id)?.name).join(', ')}</strong>
                    <div className="small">Time for your medicine. Show a thumbs up to stop the sound.</div>
                  </div>
                </div>
              )}
            </div>

            <div className="row g-2 mt-2">
              <div className="col-6"><div className="border rounded p-2 small"><span className="text-secondary">Posture</span><div className="fw-semibold">{posture}</div></div></div>
              <div className="col-6"><div className="border rounded p-2 small"><span className="text-secondary">Gesture</span><div className="fw-semibold">{gestureLabel}</div></div></div>
            </div>

            <div className="d-flex flex-wrap gap-2 mt-3">
              {status === 'running' && <button className="btn btn-outline-secondary btn-sm" onClick={stop}>Stop monitoring</button>}
              <button className="btn btn-outline-danger btn-sm" onClick={() => startAlert('Test alert')} disabled={status !== 'running'}>Test the 10-second alert</button>
            </div>

            {fallback && (
              <div className="alert alert-danger mt-3 mb-0">
                <strong>The alert server could not be reached.</strong> Contact the caregiver now:
                <div className="d-flex flex-wrap gap-2 mt-2">
                  {fallback.tel && <a className="btn btn-light btn-sm" href={fallback.tel}>Call</a>}
                  {fallback.sms && <a className="btn btn-light btn-sm" href={fallback.sms}>Text</a>}
                  {fallback.mail && <a className="btn btn-light btn-sm" href={fallback.mail}>Email</a>}
                </div>
              </div>
            )}

            <div className="mt-4">
              <h2 className="h6">Event log</h2>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                {logs.length === 0 && <div className="text-secondary small">Nothing yet. Start monitoring to begin.</div>}
                {logs.map(l => (
                  <div key={l.id} className={`small py-1 border-bottom border-${l.level === 'secondary' ? 'secondary' : l.level}-subtle`}>
                    <span className="text-secondary me-2">{l.t}</span>{l.msg}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* settings column */}
          <div className="col-lg-5 d-flex flex-column gap-4">
            <section className="border rounded p-3">
              <h2 className="h6 d-flex align-items-center gap-2"><Pill size={18} /> Medicine schedule</h2>
              <form onSubmit={addMed} className="row g-2 mb-3">
                <div className="col-12"><input className="form-control" placeholder="Medicine name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></div>
                <div className="col-7"><input className="form-control" placeholder="Dosage (e.g. 1 tablet)" value={form.dosage} onChange={e => setForm({ ...form, dosage: e.target.value })} /></div>
                <div className="col-5"><input type="time" className="form-control" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} required /></div>
                <div className="col-12 d-flex align-items-center gap-3 flex-wrap">
                  <div className="form-check mb-0"><input className="form-check-input" type="radio" id="m-daily" checked={form.mode === 'daily'} onChange={() => setForm({ ...form, mode: 'daily' })} /><label className="form-check-label" htmlFor="m-daily">Every day</label></div>
                  <div className="form-check mb-0"><input className="form-check-input" type="radio" id="m-date" checked={form.mode === 'date'} onChange={() => setForm({ ...form, mode: 'date' })} /><label className="form-check-label" htmlFor="m-date">One date</label></div>
                  {form.mode === 'date' && <input type="date" className="form-control form-control-sm w-auto" value={form.date} min={today()} onChange={e => setForm({ ...form, date: e.target.value })} required />}
                </div>
                <div className="col-12"><button className="btn btn-success w-100">Add to schedule</button></div>
              </form>
              {meds.length === 0 && <div className="text-secondary small">No medicines scheduled. Add one above.</div>}
              {[...meds].sort((a, b) => a.time.localeCompare(b.time)).map(m => (
                <div key={m.id} className="d-flex align-items-center gap-2 py-2 border-top">
                  <div className="flex-grow-1">
                    <div className="fw-semibold">{m.name}</div>
                    <div className="small text-secondary">{m.dosage || 'No dosage'} - {m.mode === 'daily' ? 'every day' : m.date} at {m.time}</div>
                  </div>
                  <span className={`badge ${m.takenDate === today() ? 'text-bg-success' : 'text-bg-secondary'}`}>{m.takenDate === today() ? 'Taken today' : medDueToday(m) ? 'Not yet' : m.date < today() ? 'Past' : 'Upcoming'}</span>
                  <button className="btn btn-sm btn-outline-secondary" aria-label={`Delete ${m.name}`} onClick={() => setMeds(l => l.filter(x => x.id !== m.id))}><Trash2 size={14} /></button>
                </div>
              ))}
            </section>

            <section className="border rounded p-3">
              <h2 className="h6 d-flex align-items-center gap-2"><UserRound size={18} /> Caregiver to contact</h2>
              <div className="d-grid gap-2">
                <input className="form-control" placeholder="Name" value={caregiver.name} onChange={e => setCaregiver({ ...caregiver, name: e.target.value })} />
                <input type="email" className="form-control" placeholder="Email" value={caregiver.email} onChange={e => setCaregiver({ ...caregiver, email: e.target.value })} />
                <input type="tel" className="form-control" placeholder="Phone with country code, e.g. +919876543210" value={caregiver.phone} onChange={e => setCaregiver({ ...caregiver, phone: e.target.value })} />
              </div>
              <div className="small text-secondary mt-2">Saved on this device. If the danger timer ends with no thumbs up, the server emails and calls these contacts.</div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}