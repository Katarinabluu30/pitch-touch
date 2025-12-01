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

/* ====== 曲ガイド（「かわいいだけじゃだめですか」） ====== */ // ★ 追加
// note: どの列か（C〜B）
// cents: 送ってもらった値（目安）
const KAWAII_GUIDE_POINTS = [ // ★ 追加
  { step: 1,  kana: "か",   note: "F",  cents:   0 },
  { step: 2,  kana: "わ",   note: "F#", cents:  11 },
  { step: 3,  kana: "いー", note: "A",  cents:  79 },
  { step: 4,  kana: "だ",   note: "F",  cents: -29 },
  { step: 5,  kana: "け",   note: "E",  cents:  26 },
  { step: 6,  kana: "じゃ", note: "C",  cents:  58 },
  { step: 7,  kana: "だ",   note: "D",  cents: -18 },
  { step: 8,  kana: "め",   note: "F",  cents: -19 },
  { step: 9,  kana: "です", note: "E",  cents:   0 },
  { step:10,  kana: "か",   note: "D",  cents: -97 },
  { step:11,  kana: "あ",   note: "F",  cents:  44 },
];

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

/* ★ 追加：曲ガイド用モード選択（ガイドなし / かわいい） */
const songModeEls   = document.querySelectorAll('input[name="songMode"]'); // HTML側に name="songMode" のラジオ/ボタンがある前提

/* ====== Audio 関係 ====== */
let audioCtx=null, masterGain=null, comp=null;
let useWorklet=false, recorderNode=null, scriptNode=null;

// 通常モード / 12TET 用： pointerId → {osc,gain,step,cents,colIndex}
const activePointers = new Map();

// コードモード用： step → {osc,gain,cents}
let chordVoices = new Map();

let octaveOffset = 0;

let isRecording=false, recLeft=null, recRight=null, recSR=48000, recCount=0;

const CENT_MIN=-100, CENT_MAX=100;
let kawaiiCurrentIndex = 0;
let kawaiiCellEl = null;
/* ====== cents -> 行インデックス変換 ====== */ // ★ 追加
// 5バンド（0〜4）にざっくり割り当て
function centToRow(c){ // ★ 追加
  if (c >= 60) return 0;      // +100付近（かなり高め）
  if (c >= 20) return 1;      // +50付近（ちょい高め）
  if (c >  -20) return 2;     // 0付近（真ん中）
  if (c >  -60) return 3;     // -50付近（ちょい低め）
  return 4;                   // -100付近（かなり低め）
}

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

/* ★ 曲ガイドモード取得（ガイドなし / kawaii / 将来: konayuki 等） */
function getSongMode(){ // ★ 追加
  if (!songModeEls || songModeEls.length === 0) return 'off';
  const r = Array.from(songModeEls).find(x=>x.checked);
  return r ? r.value : 'off';
}

function updatePanels(){
  const mode = getMainMode();
  // 12平均律モードではセン値ラベルを隠す
  centLabelsEl.hidden = (mode === 'tet12');
  stopNote();      // すべての指の音を止める
  stopAllChord();  // コードも止める
  hudHide();
}

/* ====== グリッド生成 ====== */
function buildGrid(){
  const {names} = getScaleDefs();
  gridEl.innerHTML = '';
  noteRowEl.innerHTML = '';
  names.forEach(name=>{
    const col = document.createElement('div');
    col.className = 'note-column';
    gridEl.appendChild(col);
    const label = document.createElement('div');
    label.className = 'note-name';
    label.textContent = name;
    noteRowEl.appendChild(label);
  });

  // ★ songMode を見て、必要ならガイドセルを作る／消す
  if (getSongMode() === 'kawaii'){
    buildKawaiiGuide();
  } else {
    const old = gridEl.querySelector('#kawaii-cell');
    if (old) old.remove();
  }

  refreshColumnActive();
}

/* ====== 曲ガイド表示（かわいいだけじゃだめですか） ====== */ // ★ 追加

function buildKawaiiGuide(){ // ★ 追加
  // モードが kawaii 以外なら何もしない
  if (getSongMode() !== 'kawaii') return;

  // 既存セルがあれば消す
  const old = gridEl.querySelector('#kawaii-cell');
  if (old) old.remove();
  kawaiiCellEl = null;

  const {names} = getScaleDefs();

  // 12音階以外（7音モードなど）のときはガイド非表示
  if (!names || names.length !== 12) return;

  // ガイド用セルを1個だけ作って、上に重ねる
  const cell = document.createElement('div');
  cell.id = 'kawaii-cell';
  cell.innerHTML = `
    <div class="kc-index"></div>
    <div class="kc-kana"></div>
  `;
  gridEl.appendChild(cell);
  kawaiiCellEl = cell;

  // 最初は1音目（step=1）のマスを光らせる
  highlightKawaiiStep(0);
}

function highlightKawaiiStep(index){ // ★ 追加
  kawaiiCurrentIndex = index;
  if (!kawaiiCellEl) return;
  if (getSongMode() !== 'kawaii') {
    kawaiiCellEl.style.display = 'none';
    return;
  }

  const {names} = getScaleDefs();
  const p = KAWAII_GUIDE_POINTS[index];
  const colIndex = names.indexOf(p.note);

  // その音名が今のスケールに無いときは非表示
  if (colIndex < 0){
    kawaiiCellEl.style.display = 'none';
    return;
  }
  kawaiiCellEl.style.display = 'flex';

  // 横方向：12列のうち何列目か → ％指定
  const nCols = names.length;
  const colWidth = 100 / nCols;
  const left = colIndex * colWidth;
  kawaiiCellEl.style.left = `${left}%`;
  kawaiiCellEl.style.width = `${colWidth}%`;

  // 縦方向：cent → 5バンド（row） → ％指定
  const row = centToRow(p.cents);     // 0〜4
  const rowHeight = 100 / 5;
  const top = row * rowHeight;
  kawaiiCellEl.style.top = `${top}%`;
  kawaiiCellEl.style.height = `${rowHeight}%`;

  // 中の表示（番号＋かな）
  const idxEl  = kawaiiCellEl.querySelector('.kc-index');
  const kanaEl = kawaiiCellEl.querySelector('.kc-kana');
  if (idxEl)  idxEl.textContent  = p.step;
  if (kanaEl) kanaEl.textContent = p.kana;
}

// 将来、「正しい列を押したら次へ」などで使う用
function nextKawaiiStep(){ // ★ 追加（今はどこからも呼んでないので副作用なし）
  const next = (kawaiiCurrentIndex + 1) % KAWAII_GUIDE_POINTS.length;
  highlightKawaiiStep(next);
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

/* ====== グリッド操作（通常 / 12TET） ====== */
// 通常：押している間だけ発音 & 上下で ±100 ct
function gridPointerNormal(e, phase){
  const pointerId = e.pointerId;
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if(x<0||x>rect.width||y<0||y>rect.height){
    if(phase !== 'end') stopNote(pointerId);
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

  hudShow(`${name}  ${cents>=0?'+':''}${cents} ct`, x, y);

  const info = {name, step, cents, colIndex: idx};
  if(phase==='start')      startNote(info, pointerId);
  else if(phase==='move')  updateNote(info, pointerId);
  else if(phase==='end'){  stopNote(pointerId); hudHide(); }
}

// 12平均律：0 ct 固定
function gridPointerTet12(e, phase){
  const pointerId = e.pointerId;
  const rect = gridEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if(x<0||x>rect.width||y<0||y>rect.height){
    if(phase !== 'end') stopNote(pointerId);
    hudHide();
    return;
  }

  const {names, steps} = getScaleDefs();
  const colW = rect.width / names.length;
  const idx = Math.max(0, Math.min(names.length-1, Math.floor(x/colW)));
  const name = names[idx];
  const step = steps[idx];

  hudShow(`${name}`, x, y);

  const info = {name, step, cents:0, colIndex: idx};
  if(phase==='start')      startNote(info, pointerId);
  else if(phase==='move')  updateNote(info, pointerId);
  else if(phase==='end'){  stopNote(pointerId); hudHide(); }
}

// コードモード：タップで ON/OFF（縦位置がその列の cent）
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

  if (chordVoices.has(step)){
    const v = chordVoices.get(step);
    v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.06);
    v.osc.stop(audioCtx.currentTime + 0.07);
    chordVoices.delete(step);
  } else {
    startChordVoice(step, cents);
  }

  hudShow(`${name}  ${cents>=0?'+':''}${cents} ct`, x, y);
  refreshColumnActive();
}

/* ====== 単音 / コード ====== */
async function startNote(info, pointerId){
  try{
    await ensureAudio();
    await audioCtx.resume();
  }catch(e){
    showErr(`Audio開始失敗: ${e?.message||e}`);
    return;
  }
  // すでにその pointerId の音があれば止める
  if (activePointers.has(pointerId)){
    stopNote(pointerId);
  }

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = soundSelectEl.value;
  osc.frequency.value = calcFreq(info.step, info.cents, octaveOffset);
  gain.gain.setValueAtTime(0, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.02);
  osc.connect(gain).connect(masterGain);
  osc.start();

  activePointers.set(pointerId, {
    osc,
    gain,
    step: info.step,
    cents: info.cents,
    colIndex: info.colIndex
  });

  refreshColumnActive();
}

function updateNote(info, pointerId){
  const v = activePointers.get(pointerId);
  if(!v) return;
  const f = calcFreq(info.step, info.cents, octaveOffset);
  v.osc.frequency.cancelScheduledValues(audioCtx.currentTime);
  v.osc.frequency.linearRampToValueAtTime(f, audioCtx.currentTime + 0.02);
  v.step = info.step;
  v.cents = info.cents;
  v.colIndex = info.colIndex;
  refreshColumnActive();
}

// pointerId 指定で1音だけ止める。引数なしなら全停止。
function stopNote(pointerId){
  if (pointerId == null){
    for (const [, v] of activePointers){
      v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.06);
      v.osc.stop(audioCtx.currentTime + 0.07);
    }
    activePointers.clear();
    refreshColumnActive();
    return;
  }
  const v = activePointers.get(pointerId);
  if(!v) return;
  v.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.06);
  v.osc.stop(audioCtx.currentTime + 0.07);
  activePointers.delete(pointerId);
  refreshColumnActive();
}

// コード用
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
  refreshColumnActive();
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

// アクティブ列のハイライト（通常モード＋コードモード両方込み）
function refreshColumnActive(){
  const cols = document.querySelectorAll('.note-column');
  const active = new Set();

  // pointer の列
  for (const [, v] of activePointers){
    if (typeof v.colIndex === 'number') active.add(v.colIndex);
  }

  // コードモードの列
  const {steps} = getScaleDefs();
  for (const [step] of chordVoices){
    const idx = steps.indexOf(step);
    if (idx >= 0) active.add(idx);
  }

  cols.forEach((c,i)=>{
    c.classList.toggle('active', active.has(i));
  });
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
    buildGrid();
  }));

  /* ★ 曲ガイドモードが変わったら、グリッド＋ガイドを作り直す */
  songModeEls.forEach(r=>r.addEventListener('change', ()=>{ // ★ 追加
    buildGrid();
  }));

  octDownBtn.addEventListener('click', ()=>{
    octaveOffset--;
    updateOct();
    retuneAllChordAfterOct();
  });
  octUpBtn.addEventListener('click', ()=>{
    octaveOffset++;
    updateOct();
    retuneAllChordAfterOct();
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

  // グリッド操作（マルチタッチ対応）
    gridEl.addEventListener('pointerdown', async e=>{
    const mode = getMainMode();
    const songMode = getSongMode();               // ★ 追加
    e.preventDefault();
    gridEl.setPointerCapture(e.pointerId);
    try{
      await ensureAudio();
      await audioCtx.resume();
    }catch(e2){ showErr(`Audio開始失敗: ${e2?.message||e2}`); }

    if (mode === 'grid'){
      gridPointerNormal(e,'start');
      // ★ かわいいモードのときは、タッチするたびに次のマスへ
      if (songMode === 'kawaii'){
        nextKawaiiStep();
      }
    } else if (mode === 'tet12'){
      gridPointerTet12(e,'start');
      if (songMode === 'kawaii'){
        nextKawaiiStep();
      }
    } else {
      // コードモード：タップでON/OFF（pointerdown一発）
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

  // pointer capture が外れたときも必ず音を止める
  gridEl.addEventListener('lostpointercapture', e=>{
    stopNote(e.pointerId);
    hudHide();
  });

  // 長押しでコンテキストメニューが出ると pointerup が来ないので禁止
  gridEl.addEventListener('contextmenu', e=>e.preventDefault());

  // ★ グリッドの外で pointerup / cancel されても必ず音を止める
  window.addEventListener('pointerup', e=>{
    if (activePointers.has(e.pointerId)){
      stopNote(e.pointerId);
      hudHide();
    }
  });
  window.addEventListener('pointercancel', e=>{
    if (activePointers.has(e.pointerId)){
      stopNote(e.pointerId);
      hudHide();
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
