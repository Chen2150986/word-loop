/* ==========================================================
   单词打卡 · 每日十词  —  程序逻辑
   ----------------------------------------------------------
   和之前那套错题本相比，最大的不同在于【调度】：
   不再是"答对就隔几天再见"的固定间隔，
   而是每个词都带一个 Beta 分布，用答对/答错去更新它，
   再用轮盘赌按权重抽下一轮要背的词。

   四件事照旧：
     1. 存数据        —— 记在浏览器里                【存储】
     2. 排顺序        —— 今天该背哪 10 个词          【调度】
     3. 出题目        —— 英→中 选择，中→英 拼写      【出题】
     4. 判对错        —— 更新分布、改频率            【判定】
   ========================================================== */


/* ==========================================================
   一、小工具
   ========================================================== */

// 把用户输入塞进网页之前先转义，防止输入里的 < > 被当成标签执行
function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 比对拼写时用：全部转小写，只留字母。这样 Journey / journey / journey. 都算对
function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z]/g,''); }

// 洗牌（随机打乱数组）
function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    const t=a[i]; a[i]=a[j]; a[j]=t;
  }
  return a;
}

// 今天的日期，形如 2026-11-26
function todayKey(){
  const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

let toastT;
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('on');
  clearTimeout(toastT);
  toastT=setTimeout(()=>el.classList.remove('on'),2400);
}


/* ==========================================================
   二、存储
   ----------------------------------------------------------
   一个词长这样：
     { id, w:单词, p:词性, cn:释义,
       a:答对数+1 (Beta 的 α), b:答错数+1 (Beta 的 β),
       t:最后一次答题的时间, seen:一共答过几次,
       right:答对次数, wrong:答错次数 }

   为什么用 a、b 而不是直接记等级：
   Beta(α,β) 能同时表示"猜它有多熟"和"我对这个猜测有多确定"。
   只答过 1 次就答对的词，和答过 10 次答对 10 次的词，
   两者的"熟"不是一个可信度——贝叶斯能分开它们，
   而一个 0~5 的等级数字做不到。
   ========================================================== */

const KEY='jun_vocab_beta_v1';
let DB, storageOK=true;

function newWord(w,p,cn){
  return {
    id:'w'+Math.random().toString(36).slice(2,8),
    w:w, p:p||'', cn:cn,
    a:1, b:1, t:0, seen:0, right:0, wrong:0, born:Date.now()
  };
}

function fresh(){
  return {
    words: SEED.map(s=>newWord(s[0],s[1],s[2])),
    day: todayKey(), todayN:0, todayR:0, best:0, total:0,
    round:10        // 一轮 10 个词，每个词问两遍 = 20 题
  };
}

function load(){
  try{
    const raw=localStorage.getItem(KEY);
    if(raw){
      const d=JSON.parse(raw);
      if(d && Array.isArray(d.words)) return d;
    }
  }catch(e){ storageOK=false; }
  return fresh();
}

function save(){
  if(!storageOK) return;
  try{ localStorage.setItem(KEY, JSON.stringify(DB)); }
  catch(e){ storageOK=false; toast('浏览器不让存了，这次的数据会丢'); }
}

function checkDay(){
  const k=todayKey();
  if(DB.day!==k){ DB.day=k; DB.todayN=0; DB.todayR=0; save(); }
}


/* ==========================================================
   三、调度：贝叶斯 + 轮盘赌
   ----------------------------------------------------------
   每个词有一个 Beta(α, β)：

     α = 1 + 答对次数        β = 1 + 答错次数
     p 从 Beta(α, β) 里随机采一次 = "这一刻我估计它有多熟"

   α 越大、β 越小，p 就越靠近 1（熟）；
   β 越大，p 就越靠近 0（生）。

   为什么"采样"而不是直接用 α/(α+β)：
   这就是 Thompson 采样。只答过一次就答对的词，分布很宽，
   采样结果可能很高也可能很低，于是它还会被抽到几次去验证；
   答过很多次的词分布很窄，采样结果稳定，就不会被反复打扰。
   —— 相当于让"还不确定"的词自己多拿一点出场机会。

   抽样权重 = (1 - p)² ：越生的词权重越大，但不是生词独占，
   熟词权重小也仍然有机会（轮盘赌的性质）。这就是"大数据式"
   的频次调节：用得越多、答得越准的记录越被信任。

   另外给 α、β 加时间衰减（半衰期 14 天）：
   两个月没碰过的词，不管当时答得多好，都会被当成"可能忘了"，
   权重重新涨回来。
   ========================================================== */

const HALF_DAYS=14;     // 记忆半衰期：14 天不碰，旧记录的可信度减半

// 标准正态随机数（Box-Muller）
function gauss(){
  let u=0,v=0;
  while(!u) u=Math.random();
  while(!v) v=Math.random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}

// 按 Gamma(k,1) 采样（Marsaglia-Tsang 方法），Beta 采样要用它
function gammaRand(k){
  if(k<1) return gammaRand(k+1)*Math.pow(Math.random(),1/k);
  const d=k-1/3, c=1/Math.sqrt(9*d);
  while(true){
    let x,v;
    do{ x=gauss(); v=1+c*x; }while(v<=0);
    v=v*v*v;
    const u=Math.random();
    if(u<1-0.0331*x*x*x*x) return d*v;
    if(Math.log(u)<0.5*x*x+d*(1-v+Math.log(v))) return d*v;
  }
}

// 从 Beta(a,b) 里采一个值，落在 0~1，就是此刻对"这词有多熟"的估计
function betaRand(a,b){
  const x=gammaRand(a), y=gammaRand(b);
  return x/(x+y);
}

// 按时间衰减过的 α、β（只读，不写回；写回留到真答完题那一步）
function effAB(w){
  const now=Date.now();
  const days=Math.max(0, (now-(w.t||now))/86400000);
  const lam=Math.pow(0.5, days/HALF_DAYS);
  return [1+(w.a-1)*lam, 1+(w.b-1)*lam];
}

// 当前掌握度（用于显示）：α/(α+β)
function mastery(w){
  const [a,b]=effAB(w);
  return a/(a+b);
}

/*
  轮盘赌抽词：一次抽 n 个，不重复。
  每次抽之前对剩下的词重新采样一遍权重——这样同一轮里
  已经抽走的词不会影响后面，符合"独立地按概率挑"。
*/
function pickWords(){
  const arr=DB.words.slice();
  const n=Math.min(DB.round, arr.length);
  const out=[];
  while(out.length<n && arr.length){
    const wts=arr.map(w=>{
      const [a,b]=effAB(w);
      const p=betaRand(a,b);
      return Math.pow(1-p, 2)+1e-9;      // +1e-9 防止整轮权重都是 0
    });
    let s=0;
    for(let i=0;i<wts.length;i++) s+=wts[i];
    let r=Math.random()*s;
    let idx=arr.length-1;
    for(let i=0;i<arr.length;i++){
      r-=wts[i];
      if(r<=0){ idx=i; break; }
    }
    out.push(arr[idx]);
    arr.splice(idx,1);
  }
  return out;
}


/* ==========================================================
   四、一轮答题：队列
   ----------------------------------------------------------
   Q 是题目队列，每项是 {id, mode}。
   10 个词，每个词两条：一条英→中，一条中→英，共 20 题，
   整体打乱顺序，所以同一个词的两条不会连着出现。
   ========================================================== */

let Q=[], QI=0, CUR=null, STARTED=0, BATCH=[];
let RIGHT=0, WRONG=0, STREAK=0, NEXT_T=null;

function startRound(){
  clearTimeout(NEXT_T);
  const words=pickWords();
  BATCH=words.map(w=>({w:w.w, cn:w.cn}));
  Q=[];
  words.forEach(w=>{
    Q.push({id:w.id, mode:'e2c'});
    Q.push({id:w.id, mode:'c2e'});
  });
  Q=shuffle(Q);
  QI=0; RIGHT=0; WRONG=0; STREAK=0;
  STARTED=Q.length;
  if(!Q.length){ renderEmpty(); return; }
  nextQ();
}

function renderEmpty(){
  document.getElementById('qnum').textContent='—';
  document.getElementById('hud-n').textContent='—';
  document.getElementById('hud-left').textContent='还没有词';
  document.getElementById('hud-mode').textContent='';
  document.getElementById('plabel').textContent='词库是空的';
  const p=document.getElementById('prompt');
  p.textContent='先去词库加几个词';
  p.className='prompt is-cn';
  document.getElementById('answer').innerHTML=
    '<p class="vbody">点右上角「词库」，一个个加，或者用「批量导入」把一整列粘进去（每行：单词 + 空格 + 中文），回来就能背了。</p>';
  document.getElementById('verdict').hidden=true;
  document.getElementById('bar').style.width='0%';
  document.getElementById('foot-l').textContent='本轮 0 / 0';
  document.getElementById('foot-r').textContent='对 0 · 错 0';
}

function nextQ(){
  if(QI>=Q.length){ endRound(); return; }
  const item=Q[QI];
  const w=DB.words.find(x=>x.id===item.id);
  if(!w){ QI++; nextQ(); return; }
  CUR={ w:w, mode:item.mode, opts: item.mode==='e2c'? makeOpts(w) : null, done:false };
  renderQ();
}


/* ==========================================================
   五、出题
   ========================================================== */

const elPrompt=document.getElementById('prompt');
const elPlabel=document.getElementById('plabel');
const elAnswer=document.getElementById('answer');
const elVerdict=document.getElementById('verdict');
const elStamp=document.getElementById('stamp');
const elVhead=document.getElementById('vhead');
const elVbody=document.getElementById('vbody');
const elVextra=document.getElementById('vextra');

function renderQ(){
  const w=CUR.w;
  document.getElementById('qnum').textContent='Q'+String(QI+1).padStart(2,'0');
  document.getElementById('hud-n').textContent=String(QI+1).padStart(2,'0');
  document.getElementById('hud-left').textContent='本轮剩 '+Math.max(0, Q.length-QI);
  document.getElementById('hud-mode').textContent=CUR.mode==='e2c'?'英 → 中':'中 → 英';
  elVerdict.hidden=true;

  if(CUR.mode==='e2c'){
    elPlabel.textContent='选出正确的意思';
    elPrompt.textContent=w.w;
    elPrompt.className='prompt';
    elAnswer.innerHTML='<div class="opts">'+CUR.opts.map((c,i)=>
      '<button class="opt" data-i="'+i+'">'+esc(c)+'</button>').join('')+'</div>';
    elAnswer.querySelectorAll('.opt').forEach(b=>{
      b.addEventListener('click',()=>chooseOpt(+b.dataset.i));
    });
  } else {
    elPlabel.textContent='写出这个意思对应的英文';
    elPrompt.textContent=w.cn;
    elPrompt.className='prompt is-cn';
    elAnswer.innerHTML=
      '<div class="spell">'+
        '<input id="sp" placeholder="输入英文，回车确认" autocomplete="off" autocapitalize="off" spellcheck="false">'+
        '<button class="btn" id="go">确认</button>'+
      '</div>';
    const sp=document.getElementById('sp');
    const go=document.getElementById('go');
    sp.focus();
    go.addEventListener('click',submitSpell);
    sp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); submitSpell(); } });
  }
  updateFoot();
}

function updateFoot(){
  const pct=Math.min(100, STARTED? (QI/STARTED)*100 : 0);
  document.getElementById('bar').style.width=pct+'%';
  document.getElementById('foot-l').textContent='本轮 '+QI+' / '+STARTED;
  document.getElementById('foot-r').textContent='对 '+RIGHT+' · 错 '+WRONG;
}

// 生成三个干扰项：优先取词性相同、释义不同的词
function makeOpts(w){
  let cand=DB.words.filter(x=>x.id!==w.id && x.p===w.p);
  if(cand.length<3) cand=DB.words.filter(x=>x.id!==w.id);
  const used={}; used[w.cn]=true;
  const picks=[]; const arr=cand.slice();
  while(picks.length<3 && arr.length){
    const i=Math.floor(Math.random()*arr.length);
    const c=arr.splice(i,1)[0].cn;
    if(!used[c]){ used[c]=true; picks.push(c); }
  }
  return shuffle([w.cn].concat(picks));
}


/* ==========================================================
   六、判对错 + 贝叶斯更新
   ========================================================== */

function chooseOpt(i){
  if(CUR.done) return;
  const chosen=CUR.opts[i];
  const correct=(chosen===CUR.w.cn);
  const ci=CUR.opts.indexOf(CUR.w.cn);
  elAnswer.querySelectorAll('.opt').forEach((b,k)=>{
    b.disabled=true;
    if(k===ci) b.classList.add('is-right');
    else if(k===i) b.classList.add('is-wrong');
  });
  judge(correct);
}

function submitSpell(){
  if(CUR.done) return;
  const sp=document.getElementById('sp');
  const go=document.getElementById('go');
  const ok=norm(sp.value)===norm(CUR.w.w);
  sp.readOnly=true; go.disabled=true;
  if(!ok && sp.value.trim()){
    sp.value=sp.value.trim()+'  →  '+CUR.w.w;
  }
  judge(ok);
}

function judge(ok){
  const w=CUR.w;
  CUR.done=true;
  checkDay();

  // —— 贝叶斯更新：先按时间冲淡旧记录，再给这一笔记上一分 ——
  const [a,b]=effAB(w);
  if(ok){ w.a=a+1; w.b=b; } else { w.a=a; w.b=b+1; }
  w.t=Date.now();

  w.seen=(w.seen||0)+1;
  DB.total=(DB.total||0)+1;
  DB.todayN=(DB.todayN||0)+1;
  if(ok){ w.right++; RIGHT++; DB.todayR=(DB.todayR||0)+1; STREAK++; }
  else { w.wrong++; WRONG++; STREAK=0; }
  if(STREAK>DB.best) DB.best=STREAK;

  save();
  showVerdict(ok, w);
  updateFoot();

  QI++;
  if(ok){
    NEXT_T=setTimeout(()=>{ nextQ(); }, 1100);
  } else {
    const nextBtn=document.createElement('button');
    nextBtn.className='btn';
    nextBtn.textContent='看下一个';
    nextBtn.style.marginTop='2px';
    nextBtn.addEventListener('click',()=>{ clearTimeout(NEXT_T); nextQ(); });
    elAnswer.appendChild(nextBtn);
  }
}

function showVerdict(ok, w){
  elVerdict.hidden=false;
  elStamp.innerHTML = ok
    ? '<path d="M9 31 L22 45 L51 12" stroke="var(--green)"></path>'
    : '<path d="M13 13 L47 47" stroke="var(--red)"></path><path d="M47 13 L13 47" stroke="var(--red)"></path>';
  elVhead.textContent = ok ? '对' : '错';
  elVhead.style.color = ok ? 'var(--green)' : 'var(--red)';
  elVbody.innerHTML = '<b>'+esc(w.w)+'</b>'+
    (w.p? ' <em style="font-style:italic;color:#6C7069">'+esc(w.p)+'</em>':'')+
    ' '+esc(w.cn);
  elVextra.textContent =
    '错 '+w.wrong+' 次 · 对 '+w.right+' 次 · 掌握 '+Math.round(mastery(w)*100)+'%'+
    (ok ? '' : ' · 下轮更容易抽到它');
}


/* ==========================================================
   七、一轮结束
   ========================================================== */

function endRound(){
  clearTimeout(NEXT_T);
  const total=RIGHT+WRONG;
  const acc=total? Math.round(RIGHT/total*100) : 0;

  document.getElementById('qnum').textContent='—';
  document.getElementById('hud-n').textContent='—';
  document.getElementById('hud-left').textContent='本轮结束';
  document.getElementById('hud-mode').textContent='';
  elPlabel.textContent='这一轮';
  elPrompt.className='prompt is-cn';
  elPrompt.textContent=RIGHT+' 对 '+WRONG+' 错';
  elVerdict.hidden=true;

  // 本轮这 10 个词里现在最弱的 3 个
  const weak=BATCH.slice()
    .map(x=>{ const w=DB.words.find(y=>y.w===x.w); return w||{w:x.w, wrong:0, right:0}; })
    .sort((p,q)=> mastery(p)-mastery(q))
    .slice(0,3);

  let html='<p class="vbody">正确率 '+acc+'%，最长连对 '+DB.best+' 题。<br>'+
    '今天已答 '+(DB.todayN||0)+' 题。';
  if(WRONG>0 && weak.length){
    html+='<br>这轮最该盯住的：'+weak.map(w=>'<b>'+esc(w.w)+'</b>').join('、')+'。</p>';
  } else {
    html+='<br>这一轮全对，这些词的权重会明显降下来。</p>';
  }
  elAnswer.innerHTML=html+
    '<div class="tools" style="margin-top:4px"><button class="btn" id="again">再来一轮</button></div>';
  document.getElementById('again').addEventListener('click',()=>{ startRound(); });

  document.getElementById('bar').style.width='100%';
  document.getElementById('foot-l').textContent='本轮 '+STARTED+' / '+STARTED;
  document.getElementById('foot-r').textContent='对 '+RIGHT+' · 错 '+WRONG;
}


/* ==========================================================
   八、词库视图
   ========================================================== */

function renderLib(){
  const q=(document.getElementById('search').value||'').trim().toLowerCase();
  let list=DB.words.slice();
  if(q) list=list.filter(w=> w.w.toLowerCase().includes(q) || w.cn.indexOf(q)>-1);
  list.sort((a,b)=> a.w.toLowerCase().localeCompare(b.w.toLowerCase()));

  const box=document.getElementById('lib-list');
  document.getElementById('lib-count').textContent=list.length+' 个';

  if(!list.length){
    box.innerHTML='<div class="empty"><b>'+(q? '没搜到':'词库是空的')+'</b>'+
      (q? '换个词试试，或者检查有没有打错。':'把学生这阵子学的词加进来，每个词后面跟中文意思。')+'</div>';
    return;
  }

  box.innerHTML=list.map(w=>
    '<div class="lib-row">'+
      '<span class="lib-w">'+esc(w.w)+(w.p? ' <em>'+esc(w.p)+'</em>':'')+'</span>'+
      '<span class="lib-cn">'+esc(w.cn)+'</span>'+
      '<span class="lib-meta">'+
        '<span>掌握 '+Math.round(mastery(w)*100)+'%</span>'+
        '<span>错'+w.wrong+'</span>'+
        '<button class="del" data-del="'+w.id+'" aria-label="删除">'+
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">'+
            '<path d="M6 6 L18 18 M18 6 L6 18"></path>'+
          '</svg>'+
        '</button>'+
      '</span>'+
    '</div>'
  ).join('');

  box.querySelectorAll('[data-del]').forEach(b=>{
    b.addEventListener('click',()=>{
      const id=b.dataset.del;
      const w=DB.words.find(x=>x.id===id);
      if(!w) return;
      if(!confirm('把 "'+w.w+'" 从词库删掉？它的对错记录也会一起消失。')) return;
      DB.words=DB.words.filter(x=>x.id!==id);
      save(); renderLib(); toast('已删除');
    });
  });
}

function addOne(){
  const wi=document.getElementById('nw');
  const ci=document.getElementById('nc');
  const w=wi.value.trim(), cn=ci.value.trim();
  if(!w || !cn){ toast('单词和释义都要填'); return; }
  if(!/^[a-zA-Z][a-zA-Z\-'. ]*$/.test(w)){ toast('单词只能填英文字母'); return; }
  if(DB.words.some(x=>x.w.toLowerCase()===w.toLowerCase())){
    toast('「'+w+'」已经在词库里了'); wi.value=''; return;
  }
  DB.words.push(newWord(w,'',cn));
  save(); wi.value=''; ci.value=''; wi.focus();
  renderLib(); toast('已加入「'+w+'」');
}

/*
  批量导入认这几种写法：
      journey 旅行
      journey,旅行
      journey，旅行
      journey<Tab>旅行
*/
function parseBulk(text){
  const out=[];
  String(text||'').split(/\r?\n/).forEach(line=>{
    const t=line.trim();
    if(!t) return;
    const m=t.match(/^([^\s,，\t]+)[\s,，\t]+(.+)$/);
    if(!m) return;
    const w=m[1].trim(), cn=m[2].trim();
    if(!/^[a-zA-Z][a-zA-Z\-'.]*$/.test(w)) return;
    if(!cn) return;
    out.push([w,cn]);
  });
  return out;
}

function bulkAdd(){
  const rows=parseBulk(document.getElementById('bulk').value);
  if(!rows.length){ toast('一行都没认出来，检查格式'); return; }
  let added=0, dup=0;
  rows.forEach(r=>{
    if(DB.words.some(x=>x.w.toLowerCase()===r[0].toLowerCase())){ dup++; return; }
    DB.words.push(newWord(r[0],'',r[1])); added++;
  });
  save();
  document.getElementById('note-tip').textContent='加入 '+added+(dup? '，跳过重复 '+dup : '');
  renderLib();
  toast('加入 '+added+' 个词');
}


/* ==========================================================
   九、进度视图
   ========================================================== */

function renderStats(){
  document.getElementById('s-total').textContent=DB.words.length;
  document.getElementById('s-master').textContent=DB.words.filter(w=> mastery(w)>=0.85 && w.seen>=3).length;
  document.getElementById('s-due').textContent=DB.words.filter(w=> mastery(w)<0.5).length;
  document.getElementById('s-today').textContent=DB.todayN||0;

  let r=0, x=0;
  DB.words.forEach(w=>{ r+=w.right; x+=w.wrong; });
  document.getElementById('s-acc').textContent =
    (r+x)? '正确率 '+Math.round(r/(r+x)*100)+'%' : '正确率 —';

  // 掌握度分布：五档
  const labels=['0–20%','20–40%','40–60%','60–80%','80–100%'];
  const counts=[0,0,0,0,0];
  DB.words.forEach(w=>{
    const p=mastery(w);
    counts[Math.min(4, Math.floor(p*5))]++;
  });
  const maxc=Math.max(1, ...counts);

  document.getElementById('dist').innerHTML = labels.map((lab,i)=>{
    const pct=Math.round(counts[i]/maxc*100);
    return '<div class="drow"><span>'+lab+'</span>'+
      '<span class="dbar"><i class="'+(i<=1?'hard':'')+'" style="width:'+pct+'%"></i></span>'+
      '<span>'+counts[i]+'</span></div>';
  }).join('');

  const hard=DB.words.slice()
    .filter(w=>w.wrong>0)
    .sort((a,b)=> b.wrong-a.wrong || (a.right-b.right))
    .slice(0,5);

  document.getElementById('hardlist').innerHTML = hard.length
    ? hard.map(w=>'<div class="hardrow"><span class="w">'+esc(w.w)+'</span>'+
        '<span class="c">'+esc(w.cn)+'</span>'+
        '<span class="n">错 '+w.wrong+'</span></div>').join('')
    : '<div class="empty" style="padding:18px 0">还没有错过的词。或者——还没开始背。</div>';
}


/* ==========================================================
   十、导出与重置
   ========================================================== */

function exportData(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='单词打卡备份-'+todayKey()+'.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  toast('已导出到下载文件夹');
}

function resetData(){
  if(!confirm('清空所有记录和词库，回到初始状态？这一步不能撤销。')) return;
  try{ localStorage.removeItem(KEY); }catch(e){}
  DB=fresh(); save();
  renderLib(); renderStats(); startRound();
  toast('已重置');
}


/* ==========================================================
   十一、切换视图
   ========================================================== */

function switchView(name){
  ['review','library','stats'].forEach(v=>{
    document.getElementById('view-'+v).hidden = (v!==name);
  });
  document.querySelectorAll('.tab').forEach(t=>{
    t.setAttribute('aria-selected', t.dataset.view===name ? 'true':'false');
  });
  clearTimeout(NEXT_T);
  if(name==='library') renderLib();
  else if(name==='stats') renderStats();
  else if(CUR && CUR.done && QI<Q.length) nextQ();
}


/* ==========================================================
   十二、把按钮和键盘接上
   ========================================================== */

document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click',()=>switchView(t.dataset.view));
});

document.getElementById('search').addEventListener('input', renderLib);

document.getElementById('btn-add').addEventListener('click', addOne);
document.getElementById('nw').addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('nc').focus(); });
document.getElementById('nc').addEventListener('keydown',e=>{ if(e.key==='Enter') addOne(); });

document.getElementById('btn-import').addEventListener('click',()=>{
  const p=document.getElementById('panel');
  p.hidden=!p.hidden;
  if(!p.hidden) document.getElementById('bulk').focus();
});
document.getElementById('btn-bulk-close').addEventListener('click',()=>{
  document.getElementById('panel').hidden=true;
});
document.getElementById('btn-bulk-add').addEventListener('click', bulkAdd);
document.getElementById('btn-export').addEventListener('click', exportData);
document.getElementById('btn-reset').addEventListener('click', resetData);

// 键盘 1/2/3/4 直接选选项
document.addEventListener('keydown',e=>{
  if(document.getElementById('view-review').hidden) return;
  if(!CUR || CUR.done || CUR.mode!=='e2c') return;
  if(e.key>='1' && e.key<='4'){
    const b=elAnswer.querySelector('.opt[data-i="'+(e.key-1)+'"]');
    if(b) chooseOpt(+b.dataset.i);
  }
});


/* ==========================================================
   十三、开机
   ========================================================== */

DB=load();
if(!DB.round) DB.round=10;
checkDay();
if(!storageOK) toast('这个浏览器禁用了本地存储，记录不会保存');
startRound();
