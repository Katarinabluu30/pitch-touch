// --- 注意：file:// 直開きは不可（Workletが読み込めないため） ---
if (location.protocol === "file:") {
  alert("file:// で開くと AudioWorklet が使えません。GitHub Pages 等 https(s) で開いてください。");
}

/* ========= スケール定義 ========= */
const NOTE_NAMES_7  = ["C","D","E","F","G","A","B"];
const NOTE_STEPS_7  = [0,2,4,5,7,9,11];
const NOTE_NAMES_12 = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const NOTE_STEPS_12 = [0,1,2,3,4,5,6,7,8,9,10,11];

/* ========= DOM ========= */
const mainModeEls   = document.querySelectorAll('input[name="mainMode"]');
const scaleModeEls  = document.querySelectorAll('input[name="scaleMode"]');
const soundSelectEl = document.getElementById("sound-select");
const octDownBtn    = document.getElementById("oct-down");
const octUpBtn      = document.getElementById("oct-up");
const octLabelEl    = document.getElementById("oct-label");
const recordBtn     = document.getElementById("record-btn");
const recordStatus  = document.getElementById("record-status");
const clearRecsBtn  = document.getElementById("clear-recs");
const fsBtn         = document.getElementById("fs-btn");

const gridPanel     = document.getElementById("grid-panel");
const tet12Panel    = document.getElementById("tet12-panel");
const codePanel     = document.getElementById("code-panel");

const gridEl        = document.getElementById("pitch-grid");
const noteRowEl     = document.getElementById("note-label-row");
const centLabelsEl  = document.getElementById("cent-labels");
const hudEl         = document.getElementById("touch-hud");

const codeColsEl    = document.getElementById("code-columns");
const codeCentRowEl = document.getElementById("code-cent-row");

/* ========= Audio ========= */
let audioCtx=null, masterGain=null, comp=null;
let useWorklet=false, recorderNode=null, scriptNode=null;
let osc=null, gainNode=null, currentNoteInfo=null;
let chordVoices = new Map(); // step -> {osc,gain,cents,step}
let octaveOffset = 0;
let isPointerDown=false;

let isRecording=false, recLeft=null, recRight=null, recSR=48000, recCount=0;

const CENT_MIN=-100, CENT_MAX=100;

/* ========= Worklet内蔵 文字列→Blob ========= */
function createRecorderWorkletURL() {
  const code = `
    class RecorderProcessor extends AudioWorkletProcessor {
      constructor(){
        super();
        this.isRecording = false;
        this._L = new Float32Array(0);
        this._R = new Float32Array(0);
        this.port.onmessage = (e)=>{
          if(e.data === 'rec-start'){
            this.isRecording = true;
            this._L = new Float32Array(0);
            this._R = new Float32Array(0);
          } else if(e.data === 'rec-stop'){
            this.isRecording = false;
            this.port.postMessage(
              { type:'dump', left:this._L, right:this._R },
              [this._L.buffer, this._R.buffer]
            );
            this._L = new Float32Array(0);
            this._R = new Float32Array(0);
          }
        };
      }
      _append(dst, src){
        const out = new Float32Array(dst.length + src.length);
        out.set(dst, 0); out.set(src, dst.length);
        return out;
      }
      process(inputs, outputs){
        const input = inputs[0], output = outputs[0];
        for (let ch=0; ch<output.length; ch++){
          if (input[ch]) output[ch].set(input[ch]);
        }
        if (this.isRecording && input[0]){
          const L = input[0], R = input[1] || input[0];
          this._L = this._append(this._L, L);
          this._R = this._append(this._R, R);
        }
        return true;
      }
    }
    registerProcessor('recorder-processor', RecorderProcessor);
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

/* ========= 初期化 ========= */
init();
function init(){
  buildGrid();
  buildCodeColumns();
  attachEvents();
  updatePanels();
  updateOct();
  updateRecUI();

  // モバイル初回タッチでContext解錠
  window.addEventListener('touchstart', async function unlockOnce(){
    try{ await ensureAudio(); await audioCtx.resume(); }catch{}
    window.removeEventListener('touchstart', unlockOnce, {passive:true});
  }, {passive:true});
}

/* ========= Audio Graph ========= */
async function ensureAudio(){
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(!masterGain){
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.7;
    comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 24; comp.ratio.value = 8;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    recSR = audioCtx.sampleRate;

    try{
      if(audioCtx.audioWorklet){
        const workletURL = createRecorderWorkletURL();
        await audioCtx.audioWorklet.addModule(workletURL);
        recorderNode = new AudioWorkletNode(audioCtx, 'recorder-processor',
          { numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[2] });
        URL.revokeObjectURL(workletURL);

        masterGain.connect(comp); comp.connect(recorderNode); recorderNode.connect(audioCtx.destination);
        useWorklet = true;
        recorderNode.port.onmessage = (e)=>{
          if(e.data?.type === 'dump'){
            const wav = encodeWav([e.data.left, e.data.right], recSR);
            pushRecording(wav);
          }
        };
      } else { throw new Error('no worklet'); }
    }catch(err){
      console.warn('AudioWorklet未対応 → ScriptProcessorにフォールバック', err);
      scriptNode = audioCtx.createScriptProcessor(4096, 2, 2);
      scriptNode.onaudioprocess = (ev)=>{
        const inL = ev.inputBuffer.getChannelData(0);
        const inR = ev.inputBuffer.numberOfChannels>1 ? ev.inputBuffer.getChannelData(1) : inL;
        ev.outputBuffer.getChannelData(0).set(inL);
        ev.outputBuffer.getChannelData(1).set(inR);
        if(isRecording){
          recLeft  = appendF32(recLeft,  inL);
          recRight = appendF32(recRight, inR);
        }
      };
      masterGain.connect(comp); comp.connect(scriptNode); scriptNode.connect(audioCtx.destination);
      useWorklet=false;
    }
  }
}
function appendF32(dst, src){
  if(!dst || dst.length===0) return new Float32Array(src);
  const out = new Float32Array(dst.length + src.length);
  out.set(dst,0); out.set(src,dst.length);
  return out;
}

/* ========= モード切替 ========= */
function getMainMode(){ return Array.from(mainModeEls).find(r=>r.checked)?.value || 'grid'; }
function getScaleDefs(){
  const m = Array.from(scaleModeEls).find(r=>r.checked)?.value || '12';
  return (m==='7') ? {names:NOTE_NAMES_7, steps:NOTE_STEPS_7} : {names:NOTE_NAMES_12, steps:NOTE_STEPS_12};
}
function updatePanels(){
  const mode = getMainMode();
  [gridPanel, tet12Panel, codePanel].forEach(p=>p.classList.remove('show'));
  if (mode==='grid')  gridPanel.classList.add('show');
  if (mode==='tet12') tet12Panel.classList.add('show');
  if (mode==='code')  codePanel.classList.add('show');
  centLabelsEl.hidden = (mode!=='grid');
  stopNote(); stopAllCode(); hudHide();
  if (mode==='tet12') setupTet12Buttons();
}

/* ========= 通常（グリッド） ========= */
function buildGrid(){
  const {names} = getScaleDefs();
  gridEl.innerHTML=''; noteRowEl.innerHTML='';
  names.forEach(n=>{
    const col = document.createElement('div'); col.className='note-column'; gridEl.appendChild(col);
    const lab = document.createElement('div'); lab.className='note-name'; lab.textContent=n; noteRowEl.appendChild(lab);
  });
}
function gridPointer(e, phase){
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  if(x<0||x>rect.width||y<0||y>rect.height){ if(phase!=='end') stopNote(); hudHide(); return; }

  const {names, steps} = getScaleDefs();
  const colW = rect.width / names.length;
  const idx = Math.max(0, Math.min(names.length-1, Math.floor(x/colW)));
  const name = names[idx], step = steps[idx];

  // 上=+100ct, 下=-100ct
  const ratioY = y/rect.height;
  const cents = Math.round(CENT_MAX - (CENT_MAX - CENT_MIN)*ratioY);

  document.querySelectorAll('.note-column').forEach((c,i)=>c.classList.toggle('active', i===idx && isPointerDown));
  hudShow(`${name}  ${cents>=0?'+':''}${cents} ct`, x, y);

  const info = {name, step, cents};
  if(phase==='start') startNote(info);
  else if(phase==='move') updateNote(info);
  else if(phase==='end'){ stopNote(); hudHide(); }
}

/* ========= 12TET（押している間だけ） ========= */
function setupTet12Buttons(){
  document.querySelectorAll('#tet12-panel .note-btn').forEach(b=>{
    if (b._wired) return;
    b._wired = true;
    const start = async ()=>{
      await ensureAudio(); await audioCtx.resume();
      b.classList.add('active');
      startNote({name:'12TET', step:parseInt(b.dataset.step,10), cents:0});
    };
    const end = ()=>{
      stopNote();
      b.classList.remove('active');
    };
    b.addEventListener('pointerdown', e=>{ e.preventDefault(); start(); });
    b.addEventListener('pointerup', end);
    b.addEventListener('pointerleave', end);
    b.addEventListener('pointercancel', end);
  });
}

/* ========= コード（12列レール） ========= */
function buildCodeColumns(){
  codeColsEl.innerHTML=''; codeCentRowEl.innerHTML='';
  NOTE_NAMES_12.forEach((name, step)=>{
    const col = document.createElement('div'); col.className='code-col'; col.dataset.step=step;

    const rail = document.createElement('div'); rail.className='code-rail';
    const thumb = document.createElement('div'); thumb.className='code-thumb'; thumb.textContent=name;
    placeThumb(rail, thumb, 0);

    // トグル（有効/無効）
    thumb.addEventListener('pointerdown', async ev=>{
      ev.preventDefault(); await ensureAudio(); await audioCtx.resume();
      if(chordVoices.has(step)) stopCodeVoice(step, thumb);
      else startCodeVoice(step, 0, thumb);
    });

    // レールでcent変更
    const moveOnRail = (ev)=>{
      const r = rail.getBoundingClientRect();
      const y = Math.max(0, Math.min(r.height, ev.clientY - r.top));
      const ratio = 1 - (y / r.height); // 上=1 下=0
      const cents = Math.round(CENT_MIN + (CENT_MAX - CENT_MIN)*(ratio*0.5 + 0.5));
      placeThumb(rail, thumb, cents);
      codeCentRowEl.children[step].textContent = `${cents} ct`;
      if(chordVoices.has(step)) retuneCodeVoice(step, cents);
      else thumb.classList.toggle('alt', cents!==0);
    };
    rail.addEventListener('pointerdown', ev=>{ ev.preventDefault(); rail.setPointerCapture(ev.pointerId); moveOnRail(ev); });
    rail.addEventListener('pointermove', ev=>{ if(ev.pressure===0) return; moveOnRail(ev); });

    col.appendChild(rail);
    col.appendChild(thumb);
    const nameEl = document.createElement('div'); nameEl.className='code-name'; nameEl.textContent=name; col.appendChild(nameEl);
    const centEl = document.createElement('div'); centEl.className='code-cent'; centEl.textContent='0 ct'; col.appendChild(centEl);
    codeColsEl.appendChild(col);

    const cr = document.createElement('div'); cr.textContent='0 ct'; codeCentRowEl.appendChild(cr);
  });
}
function placeThumb(rail, thumb, cents){
  const r = rail.getBoundingClientRect();
  const y = (1 - (cents - CENT_MIN)/(CENT_MAX - CENT_MIN)) * r.height; // +100→上
  thumb.style.top = `${y}px`;
}
function startCodeVoice(step, cents, thumbEl){
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = soundSelectEl.value;
  o.frequency.value = calcFreq(step, cents, octaveOffset);
  g.gain.setValueAtTime(0, audioCtx.currentTime);
  g.gain.linearRampToValueAtTime(0.35, audioCtx.currentTime + 0.03);
  o.connect(g).connect(masterGain);
  o.start();
  chordVoices.set(step, {osc:o, gain:g, cents, step});
  thumbEl.classList.add('alt');
}
function stopCodeVoice(step, thumbEl){
  const v = chordVoices.get(step); if(!v) return;
  v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.06);
  v.osc.stop(audioCtx.currentTime + 0.07);
  chordVoices.delete(step);
  thumbEl.classList.remove('alt');
}
function retuneCodeVoice(step, cents){
  const v = chordVoices.get(step); if(!v) return;
  v.cents = cents;
  const f = calcFreq(step, cents, octaveOffset);
  v.osc.frequency.cancelScheduledValues(audioCtx.currentTime);
  v.osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
}
function stopAllCode(){
  for(const [, v] of chordVoices){
    v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
    v.osc.stop(audioCtx.currentTime + 0.06);
  }
  chordVoices.clear();
  document.querySelectorAll('.code-thumb').forEach(t=>t.classList.remove('alt'));
}

/* ========= 単音（グリッド/12TET共通） ========= */
async function startNote(info){
  await ensureAudio(); await audioCtx.resume();
  stopNote();
  osc = audioCtx.createOscillator();
  gainNode = audioCtx.createGain();
  osc.type = soundSelectEl.value;
  osc.frequency.value = calcFreq(info.step, info.cents, octaveOffset);
  gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
  gainNode.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.02);
  osc.connect(gainNode).connect(masterGain);
  osc.start();
  currentNoteInfo = info;
}
function updateNote(info){
  if(!osc) return;
  const f = calcFreq(info.step, info.cents, octaveOffset);
  osc.frequency.cancelScheduledValues(audioCtx.currentTime);
  osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
  currentNoteInfo = info;
}
function stopNote(){
  if(!osc) return;
  gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.06);
  osc.stop(audioCtx.currentTime + 0.07);
  osc=null; gainNode=null; currentNoteInfo=null;
  document.querySelectorAll('.note-column').forEach(c=>c.classList.remove('active'));
}

/* ========= Util ========= */
function calcFreq(step, cents, oct){
  const C4 = 261.63;           // 基準C4
  const semi = step + oct*12 + cents/100;
  return C4 * Math.pow(2, semi/12);
}
function hudShow(text,x,y){ hudEl.textContent=text; hudEl.hidden=false; hudEl.style.transform=`translate(${x+12}px,${y-24}px)`; }
function hudHide(){ hudEl.hidden=true; hudEl.style.transform='translate(-9999px,-9999px)'; }
function updateOct(){ octLabelEl.textContent = String(octaveOffset); }
function updateRecUI(){ recordBtn.classList.toggle('recording', isRecording); recordStatus.textContent = isRecording ? '録音中…' : '待機中'; }

// WAVエンコード & 表示
function encodeWav(chs, sr){
  const N = chs[0].length, C = chs.length;
  const inter = new Float32Array(N*C);
  for(let i=0;i<N;i++) for(let c=0;c<C;c++) inter[i*C+c] = chs[c][i]||0;
  const buf = new ArrayBuffer(44 + inter.length*2);
  const v = new DataView(buf);
  w('RIFF',0); v.setUint32(4,36+inter.length*2,true); w('WAVE',8); w('fmt ',12);
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,C,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*C*2,true); v.setUint16(32,C*2,true); v.setUint16(34,16,true);
  w('data',36); v.setUint32(40,inter.length*2,true);
  let off=44; for(let i=0;i<inter.length;i++,off+=2){ let s=Math.max(-1,Math.min(1,inter[i])); v.setInt16(off, s<0?s*0x8000:s*0x7fff, true); }
  return new Blob([v],{type:'audio/wav'});
  function w(s,o){ for(let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); }
}
function pushRecording(wav){
  const url = URL.createObjectURL(wav);
  const list = document.getElementById('recordings-list');
  const item = document.createElement('div'); item.className='item';
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
  const name = `recording_${(++recCount).toString().padStart(2,'0')}_${stamp}.wav`;
  const audio = document.createElement('audio'); audio.controls=true; audio.src=url;
  const a = document.createElement('a'); a.href=url; a.download=name; a.textContent=`📥 ${name}`;
  const open = document.createElement('a'); open.href=url; open.target='_blank'; open.rel='noopener'; open.textContent='⤴︎ 新しいタブで開く';
  const del = document.createElement('button'); del.textContent='削除'; del.addEventListener('click',()=>{ URL.revokeObjectURL(url); item.remove(); });
  const meta = document.createElement('span'); meta.style.fontSize='12px'; meta.style.color='#666'; meta.textContent=` (${Math.round(wav.size/1024)} KB)`;
  item.appendChild(audio); item.appendChild(a); item.appendChild(open); item.appendChild(del); item.appendChild(meta);
  list.prepend(item);
}
function clearAll(){
  const list=document.getElementById('recordings-list');
  list.querySelectorAll("a[href^='blob:']").forEach(a=>URL.revokeObjectURL(a.href));
  list.innerHTML='';
}

/* ========= イベント ========= */
function attachEvents(){
  mainModeEls.forEach(r=>r.addEventListener('change', updatePanels));
  scaleModeEls.forEach(r=>r.addEventListener('change', buildGrid));
  octDownBtn.addEventListener('click', ()=>{ octaveOffset--; updateOct(); retuneAllCodeAfterOct(); });
  octUpBtn.addEventListener('click', ()=>{ octaveOffset++; updateOct(); retuneAllCodeAfterOct(); });

  recordBtn.addEventListener('click', async ()=>{
    await ensureAudio(); await audioCtx.resume();
    isRecording=!isRecording;
    if(isRecording){
      if(useWorklet) recorderNode.port.postMessage('rec-start');
      else { recLeft=new Float32Array(0); recRight=new Float32Array(0); }
    }else{
      if(useWorklet) recorderNode.port.postMessage('rec-stop');
      else { const wav = encodeWav([recLeft||new Float32Array(0), recRight||new Float32Array(0)], recSR); pushRecording(wav); }
    }
    updateRecUI();
  });
  clearRecsBtn.addEventListener('click', clearAll);

  // 通常グリッド（押している間だけ発音）
  gridEl.addEventListener('pointerdown', async e=>{
    if(getMainMode()!=='grid') return;
    e.preventDefault(); gridEl.setPointerCapture(e.pointerId); isPointerDown=true;
    await ensureAudio(); await audioCtx.resume(); gridPointer(e,'start');
  });
  gridEl.addEventListener('pointermove', e=>{ if(getMainMode()!=='grid' || !isPointerDown) return; gridPointer(e,'move'); });
  gridEl.addEventListener('pointerup',   e=>{ if(getMainMode()!=='grid') return; isPointerDown=false; gridPointer(e,'end'); });
  gridEl.addEventListener('pointercancel',e=>{ if(getMainMode()!=='grid') return; isPointerDown=false; gridPointer(e,'end'); });

  // 全画面
  fsBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFSUI);
  document.addEventListener('webkitfullscreenchange', updateFSUI);
  document.addEventListener('msfullscreenchange', updateFSUI);
}
function retuneAllCodeAfterOct(){
  for(const [step, v] of chordVoices){
    const f = calcFreq(step, v.cents, octaveOffset);
    v.osc.frequency.cancelScheduledValues(audioCtx.currentTime);
    v.osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
  }
}

/* ========= 全画面 ========= */
function fullscreenSupported(){
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
}
async function toggleFullscreen(){
  try{ await ensureAudio(); await audioCtx?.resume(); }catch{}
  if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen)?.call(document);
    document.body.classList.remove('fullscreen');
  } else {
    if (fullscreenSupported()) {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen)?.call(el);
      document.body.classList.add('fullscreen');
    } else {
      document.body.classList.toggle('pseudo-full');
      fsBtn.classList.toggle('active', document.body.classList.contains('pseudo-full'));
      fsBtn.textContent = document.body.classList.contains('pseudo-full') ? '⛶ 終了' : '⛶ 全画面';
    }
  }
}
function updateFSUI(){
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  fsBtn.classList.toggle('active', on);
  fsBtn.textContent = on ? '⛶ 終了' : '⛶ 全画面';
  document.body.classList.toggle('fullscreen', on);
}
