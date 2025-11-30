// Microtonal Touch Grid

const errEl = document.getElementById('err');
function showErr(msg){
  if (errEl) errEl.textContent = `⚠ ${msg}`;
  console.error(msg);
}

/* ====== 音階定義 ====== */
const NOTE_NAMES_7  = ["C","D","E","F","G","A","B"];
const NOTE_STEPS_7  = [0,2,4,5,7,9,11];
const NOTE_NAMES_12 = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const NOTE_STEPS_12 = [0,1,2,3,4,5,6,7,8,9,10,11];

/* ====== DOM ====== */
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

const gridEl        = document.getElementById("pitch-grid");
const noteRowEl     = document.getElementById("note-label-row");
const centLabelsEl  = document.getElementById("cent-labels");
const recordingsSec = document.getElementById("recordings");
const hudEl         = document.getElementById("touch-hud");

/* ====== Audio 関係 ====== */
let audioCtx=null, masterGain=null, comp=null;
let useWorklet=false, recorderNode=null, scriptNode=null;

/** 単音用（12平均律モードなど） */
let osc=null, gainNode=null, currentNoteInfo=null;

/** コードモード（ON/OFF）用 */
let chordVoices = new Map(); // step -> {osc,gain,cents}

/** 通常モードのマルチタッチ用
 *  pointerId -> { osc, gain, info:{name,step,cents}, colIndex }
 */
let activeTouches = new Map();
let colTouchCounts = []; // colIndex -> その列を押している指の数

let octaveOffset = 0;

let isRecording=false, recLeft=null, recRight=null, recSR=48000, recCount=0;

const CENT_MIN=-100, CENT_MAX=100;

/* ====== Worklet ソース作成 ====== */
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

/* ====== 初期化 ====== */
init();
function init(){
  if (!gridEl || !noteRowEl){
    showErr("pitch-grid か note-label-row が見つかりません。HTMLのIDを確認してください。");
    return;
  }
  buildGrid();
  attachEvents();
  updatePanels();
  updateOct();
  updateRecUI();

  // モバイル：最初のタッチで AudioContext 解錠
  window.addEventListener('touchstart', async function unlockOnce(){
    try{ await ensureAudio(); await audioCtx.resume(); }catch(e){ showErr(`Audio unlock失敗: ${e?.message||e}`); }
    window.removeEventListener('touchstart', unlockOnce, {passive:true});
  }, {passive:true});
}

/* ====== モード / スケール ====== */
function getMainMode(){
  const r = Array.from(mainModeEls).find(x=>x.checked);
  return r ? r.value : 'grid';
}
function getScaleDefs(){
  const r = Array.from(scaleModeEls).find(x=>x.checked);
  const mode = r ? r.value : '12';
  return mode === '7'
    ? { names: NOTE_NAMES_7,  steps: NOTE_STEPS_7  }
    : { names: NOTE_NAMES_12, steps: NOTE_STEPS_12 };
}
function updatePanels(){
  const mode = getMainMode();
  centLabelsEl.hidden = (mode === 'tet12'); // 12TETのときだけセン値目盛り隠す
  stopNote();
  stopAllChord();
  stopAllGridTouches();
  hudHide();
}

/* ====== グリッド生成 ====== */
function buildGrid(){
  const {names} = getScaleDefs();
  gridEl.innerHTML = '';
  noteRowEl.innerHTML = '';

  stopAllGridTouches();

  colTouchCounts = new Array(names.length).fill(0);

  names.forEach(name=>{
    const col = document.createElement('div');
    col.className = 'note-column';
    gridEl.appendChild(col);
    const label = document.createElement('div');
    label.className = 'note-name';
    label.textContent = name;
    noteRowEl.appendChild(label);
  });
}

/* ====== Audio Graph 構築 ====== */
async function ensureAudio(){
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(!masterGain){
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.6;

    comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    recSR = audioCtx.sampleRate;

    try{
      if(audioCtx.audioWorklet){
        const url = createRecorderWorkletURL();
        await audioCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        recorderNode = new AudioWorkletNode(audioCtx, 'recorder-processor',
          { numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[2] });

        masterGain.connect(comp);
        comp.connect(recorderNode);
        recorderNode.connect(audioCtx.destination);

        recorderNode.port.onmessage = (e)=>{
          if(e.data?.type === 'dump'){
            const wav = encodeWav([e.data.left, e.data.right], recSR);
            pushRecording(wav);
          }
        };
        useWorklet = true;
      } else {
        throw new Error("AudioWorklet 未対応");
      }
    }catch(err){
      showErr(`Worklet未使用で録音にフォールバック: ${err?.message||err}`);
      scriptNode = audioCtx.createScriptProcessor(1024, 2, 2);
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
      masterGain.connect(comp);
      comp.connect(scriptNode);
      scriptNode.connect(audioCtx.destination);
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

/* ====== グリッド操作：通常モード（マルチタッチ対応） ====== */
function gridPointerNormal(e, phase){
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const pointerId = e.pointerId;

  const {names, steps} = getScaleDefs();
  const colW = rect.width / names.length;
  const cols = document.querySelectorAll('.note-column');

  // グリッド外
  if(x<0||x>rect.width||y<0||y>rect.height){
    if(phase === 'move' || phase === 'end'){
      stopGridVoice(pointerId);
    }
    if(phase === 'end') hudHide();
    return;
  }

  const idx = Math.max(0, Math.min(names.length-1, Math.floor(x/colW)));
  const name = names[idx];
  const step = steps[idx];

  const ratioY = y/rect.height;
  const cents = Math.round(CENT_MAX - (CENT_MAX - CENT_MIN)*ratioY);
  const info = {name, step, cents};

  hudShow(`${name}  ${cents>=0?'+':''}${cents} ct`, x, y);

  if(phase === 'start'){
    startGridVoice(pointerId, info, idx);
  } else if(phase === 'move'){
    if(activeTouches.has(pointerId)){
      updateGridVoice(pointerId, info, idx);
    } else {
      // まれに start が取れなかった時の保険
      startGridVoice(pointerId, info, idx);
    }
  } else if(phase === 'end'){
    stopGridVoice(pointerId);
    hudHide();
  }
}

/* ====== グリッド操作：12平均律モード（単音） ====== */
function gridPointerTet12(e, phase){
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const {names, steps} = getScaleDefs();
  const colW = rect.width / names.length;
  const cols = document.querySelectorAll('.note-column');

  if(x<0||x>rect.width||y<0||y>rect.height){
    if(phase !== 'end') stopNote();
    hudHide();
    cols.forEach(c=>c.classList.remove('active'));
    return;
  }

  const idx = Math.max(0, Math.min(names.length-1, Math.floor(x/colW)));
  const name = names[idx];
  const step = steps[idx];

  cols.forEach((c,i)=>c.classList.toggle('active', i===idx && phase!=='end'));
  hudShow(`${name}`, x, y);

  const info = {name, step, cents:0};
  if(phase==='start')      startNote(info);
  else if(phase==='move')  updateNote(info);
  else if(phase==='end'){  stopNote(); hudHide(); }
}

/* ====== グリッド操作：コードモード（タップON/OFF） ====== */
function gridChordTap(e){
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if(x<0||x>rect.width||y<0||y>rect.height){
    hudHide();
    return;
  }
  const {names, steps} = getScaleDefs();
  const colW = rect.width / names.length;
  const idx = Math.max(0, Math.min(names.length-1, Math.floor(x/colW)));
  const name = names[idx];
  const step = steps[idx];

  const ratioY = y/rect.height;
  const cents = Math.round(CENT_MAX - (CENT_MAX - CENT_MIN)*ratioY);

  const cols = document.querySelectorAll('.note-column');

  if (chordVoices.has(step)){
    const v = chordVoices.get(step);
    v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.06);
    v.osc.stop(audioCtx.currentTime + 0.07);
    chordVoices.delete(step);
    cols[idx].classList.remove('active');
  } else {
    startChordVoice(step, cents);
    cols[idx].classList.add('active');
  }
  hudShow(`${name}  ${cents>=0?'+':''}${cents} ct`, x, y);
}

/* ====== 単音（12TETなど） ====== */
async function startNote(info){
  try{
    await ensureAudio();
    await audioCtx.resume();
  }catch(e){
    showErr(`Audio開始失敗: ${e?.message||e}`);
    return;
  }
  stopNote();

  const t = audioCtx.currentTime;

  osc = audioCtx.createOscillator();
  gainNode = audioCtx.createGain();

  osc.type = soundSelectEl.value;
  osc.frequency.value = calcFreq(info.step, info.cents, octaveOffset);

  gainNode.gain.cancelScheduledValues(t);
  gainNode.gain.setValueAtTime(0, t);
  gainNode.gain.linearRampToValueAtTime(0.55, t + 0.005);

  osc.connect(gainNode).connect(masterGain);
  osc.start(t);

  currentNoteInfo = info;
}
function updateNote(info){
  if(!osc) return;
  const t = audioCtx.currentTime;
  const f = calcFreq(info.step, info.cents, octaveOffset);
  osc.frequency.cancelScheduledValues(t);
  osc.frequency.linearRampToValueAtTime(f, t + 0.02);
  currentNoteInfo = info;
}
function stopNote(){
  if(!osc) return;

  const t = audioCtx.currentTime;
  gainNode.gain.cancelScheduledValues(t);
  const current = gainNode.gain.value;
  gainNode.gain.setValueAtTime(current, t);
  gainNode.gain.linearRampToValueAtTime(0, t + 0.15);
  osc.stop(t + 0.16);

  osc=null;
  gainNode=null;
  currentNoteInfo=null;

  document.querySelectorAll('.note-column').forEach(c=>c.classList.remove('active'));
}

/* ====== 通常モード用：マルチタッチのボイス管理 ====== */
function startGridVoice(pointerId, info, colIndex){
  if(!audioCtx){
    return;
  }
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();

  o.type = soundSelectEl.value;
  o.frequency.value = calcFreq(info.step, info.cents, octaveOffset);

  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.55, t + 0.005);

  o.connect(g).connect(masterGain);
  o.start(t);

  activeTouches.set(pointerId, {osc:o, gain:g, info, colIndex});

  colTouchCounts[colIndex] = (colTouchCounts[colIndex]||0) + 1;
  const cols = document.querySelectorAll('.note-column');
  if(cols[colIndex]) cols[colIndex].classList.add('active');
}

function updateGridVoice(pointerId, info, newColIndex){
  const v = activeTouches.get(pointerId);
  if(!v) return;

  const t = audioCtx.currentTime;
  const f = calcFreq(info.step, info.cents, octaveOffset);
  v.osc.frequency.cancelScheduledValues(t);
  v.osc.frequency.linearRampToValueAtTime(f, t + 0.02);

  // 別の列に移動した場合はハイライトも移す
  if(typeof v.colIndex === 'number' && v.colIndex !== newColIndex){
    const cols = document.querySelectorAll('.note-column');

    colTouchCounts[v.colIndex] = Math.max(0, (colTouchCounts[v.colIndex]||0) - 1);
    if(colTouchCounts[v.colIndex] === 0 && cols[v.colIndex]){
      cols[v.colIndex].classList.remove('active');
    }

    colTouchCounts[newColIndex] = (colTouchCounts[newColIndex]||0) + 1;
    if(cols[newColIndex]) cols[newColIndex].classList.add('active');

    v.colIndex = newColIndex;
  }

  v.info = info;
}

function stopGridVoice(pointerId){
  const v = activeTouches.get(pointerId);
  if(!v) return;

  const t = audioCtx.currentTime;
  v.gain.gain.cancelScheduledValues(t);
  const current = v.gain.gain.value;
  v.gain.gain.setValueAtTime(current, t);
  v.gain.gain.linearRampToValueAtTime(0, t + 0.15);
  v.osc.stop(t + 0.16);

  const cols = document.querySelectorAll('.note-column');
  if(typeof v.colIndex === 'number'){
    colTouchCounts[v.colIndex] = Math.max(0, (colTouchCounts[v.colIndex]||0) - 1);
    if(colTouchCounts[v.colIndex] === 0 && cols[v.colIndex]){
      cols[v.colIndex].classList.remove('active');
    }
  }

  activeTouches.delete(pointerId);
}

function stopAllGridTouches(){
  const t = audioCtx ? audioCtx.currentTime : 0;
  for(const [, v] of activeTouches){
    if(!audioCtx) continue;
    v.gain.gain.cancelScheduledValues(t);
    const current = v.gain.gain.value;
    v.gain.gain.setValueAtTime(current, t);
    v.gain.gain.linearRampToValueAtTime(0, t + 0.15);
    v.osc.stop(t + 0.16);
  }
  activeTouches.clear();
  colTouchCounts = [];
  document.querySelectorAll('.note-column').forEach(c=>c.classList.remove('active'));
}

/* ★ 非常停止：全部まとめてミュート ★ */
function stopEverythingHard(){
  stopNote();
  stopAllGridTouches();
  stopAllChord();
}

/* ====== コード用 ====== */
function startChordVoice(step, cents){
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = soundSelectEl.value;
  o.frequency.value = calcFreq(step, cents, octaveOffset);
  g.gain.setValueAtTime(0, audioCtx.currentTime);
  g.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.03);
  o.connect(g).connect(masterGain);
  o.start();
  chordVoices.set(step, {osc:o, gain:g, cents});
}
function stopAllChord(){
  for(const [, v] of chordVoices){
    v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
    v.osc.stop(audioCtx.currentTime + 0.06);
  }
  chordVoices.clear();
  document.querySelectorAll('.note-column').forEach(c=>c.classList.remove('active'));
}
function retuneAllChordAfterOct(){
  for(const [step, v] of chordVoices){
    const f = calcFreq(step, v.cents, octaveOffset);
    v.osc.frequency.cancelScheduledValues(audioCtx.currentTime);
    v.osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
  }
}

/* ====== Util ====== */
function calcFreq(step, cents, oct){
  const C4 = 261.63;
  const semi = step + oct*12 + cents/100;
  return C4 * Math.pow(2, semi/12);
}
function hudShow(text,x,y){
  hudEl.textContent=text;
  hudEl.hidden=false;
  hudEl.style.transform=`translate(${x+12}px,${y-24}px)`;
}
function hudHide(){
  hudEl.hidden=true;
  hudEl.style.transform='translate(-9999px,-9999px)';
}
function updateOct(){ octLabelEl.textContent = String(octaveOffset); }
function updateRecUI(){
  recordBtn.classList.toggle('recording', isRecording);
  recordStatus.textContent = isRecording ? '録音中…' : '待機中';
}

/* ====== WAV + 録音 ====== */
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
  let off=44;
  for(let i=0;i<inter.length;i++,off+=2){
    let s=Math.max(-1,Math.min(1,inter[i]));
    v.setInt16(off, s<0?s*0x8000:s*0x7fff, true);
  }
  return new Blob([v],{type:'audio/wav'});
  function w(s,o){ for(let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); }
}
function pushRecording(wav){
  const url = URL.createObjectURL(wav);
  const list = document.getElementById('recordings-list');
  if (!list) return;

  recordingsSec.hidden = false;

  const item = document.createElement('div');
  item.className='item';
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}`;
  const name = `recording_${(++recCount).toString().padStart(2,'0')}_${stamp}.wav`;

  const audio = document.createElement('audio');
  audio.controls=true;
  audio.src=url;

  const a = document.createElement('a');
  a.href=url;
  a.download=name;
  a.textContent=`📥 ${name}`;

  const open = document.createElement('a');
  open.href=url;
  open.target='_blank';
  open.rel='noopener';
  open.textContent='⤴︎ 新しいタブで開く';

  const del = document.createElement('button');
  del.textContent='削除';
  del.addEventListener('click',()=>{
    URL.revokeObjectURL(url);
    item.remove();
  });

  const meta = document.createElement('span');
  meta.style.fontSize='12px';
  meta.style.color='#666';
  meta.textContent=` (${Math.round(wav.size/1024)} KB)`;

  item.appendChild(audio);
  item.appendChild(a);
  item.appendChild(open);
  item.appendChild(del);
  item.appendChild(meta);
  list.prepend(item);
}
function clearAll(){
  const list=document.getElementById('recordings-list');
  if(!list) return;
  list.querySelectorAll("a[href^='blob:']").forEach(a=>URL.revokeObjectURL(a.href));
  list.innerHTML='';
  recordingsSec.hidden = true;
}

/* ====== イベント ====== */
function attachEvents(){
  mainModeEls.forEach(r=>r.addEventListener('change', updatePanels));
  scaleModeEls.forEach(r=>r.addEventListener('change', ()=>{
    stopNote();
    stopAllChord();
    stopAllGridTouches();
    buildGrid();
  }));

  octDownBtn.addEventListener('click', ()=>{
    octaveOffset--;
    updateOct();
    retuneAllChordAfterOct();
    for(const [, v] of activeTouches){
      const info = v.info;
      const f = calcFreq(info.step, info.cents, octaveOffset);
      v.osc.frequency.cancelScheduledValues(audioCtx.currentTime);
      v.osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
    }
  });
  octUpBtn.addEventListener('click', ()=>{
    octaveOffset++;
    updateOct();
    retuneAllChordAfterOct();
    for(const [, v] of activeTouches){
      const info = v.info;
      const f = calcFreq(info.step, info.cents, octaveOffset);
      v.osc.frequency.cancelScheduledValues(audioCtx.currentTime);
      v.osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
    }
  });

  recordBtn.addEventListener('click', async ()=>{
    try{
      await ensureAudio();
      await audioCtx.resume();
      isRecording=!isRecording;
      if(isRecording){
        if(useWorklet) recorderNode.port.postMessage('rec-start');
        else { recLeft=new Float32Array(0); recRight=new Float32Array(0); }
      }else{
        if(useWorklet) recorderNode.port.postMessage('rec-stop');
        else {
          const wav = encodeWav(
            [recLeft||new Float32Array(0), recRight||new Float32Array(0)],
            recSR
          );
          pushRecording(wav);
        }
      }
      updateRecUI();
    }catch(e){
      showErr(`録音切替失敗: ${e?.message||e}`);
    }
  });
  clearRecsBtn.addEventListener('click', clearAll);

  // グリッド操作（pointerIdごとに処理）
  gridEl.addEventListener('pointerdown', async e=>{
    const mode = getMainMode();
    e.preventDefault();
    gridEl.setPointerCapture(e.pointerId);
    await ensureAudio();
    await audioCtx.resume();
    if (mode === 'grid'){
      gridPointerNormal(e,'start');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'start');
    } else {
      gridChordTap(e);
    }
  }, {passive:false});

  gridEl.addEventListener('pointermove', e=>{
    const mode = getMainMode();
    if (mode === 'grid'){
      gridPointerNormal(e,'move');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'move');
    }
  });

  gridEl.addEventListener('pointerup', e=>{
    const mode = getMainMode();
    if (mode === 'grid'){
      gridPointerNormal(e,'end');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'end');
    } else {
      hudHide();
    }
  });

  gridEl.addEventListener('pointercancel', e=>{
    const mode = getMainMode();
    if (mode === 'grid'){
      gridPointerNormal(e,'end');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'end');
    } else {
      hudHide();
    }
  });

  // ★ グローバルでも pointerup / cancel を拾う保険
  window.addEventListener('pointerup', e=>{
    const mode = getMainMode();
    if (mode === 'grid'){
      gridPointerNormal(e,'end');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'end');
    } else {
      hudHide();
    }
  });

  window.addEventListener('pointercancel', e=>{
    const mode = getMainMode();
    if (mode === 'grid'){
      gridPointerNormal(e,'end');
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'end');
    } else {
      hudHide();
    }
  });

  // ★ タブが非アクティブになったら全部止める
  document.addEventListener('visibilitychange', ()=>{
    if (document.hidden){
      stopEverythingHard();
    }
  });

  fsBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFSUI);
  document.addEventListener('webkitfullscreenchange', updateFSUI);
  document.addEventListener('msfullscreenchange', updateFSUI);
}

/* ====== 全画面 ====== */
function fullscreenSupported(){
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
}
async function toggleFullscreen(){
  try{
    await ensureAudio();
    await audioCtx?.resume();
  }catch(e){}
  if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen)?.call(document);
    document.body.classList.remove('fullscreen');
  } else {
    if (fullscreenSupported()){
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen)?.call(el);
      document.body.classList.add('fullscreen');
    }
  }
}
function updateFSUI(){
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  fsBtn.classList.toggle('active', on);
  fsBtn.textContent = on ? '⛶ 終了' : '⛶ 全画面';
  document.body.classList.toggle('fullscreen', on);
}
