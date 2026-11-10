/* ==========================================================
   错题本 · 四级高频词  —  程序逻辑
   ----------------------------------------------------------
   这个文件回答“点一下会发生什么”。

   整体只有四件事在循环：
     1. 存数据        —— 把词和成绩记在浏览器里      【存储】
     2. 排顺序        —— 决定下一题问哪个词          【调度】
     3. 出题目        —— 做一个选择题或拼写题        【出题】
     4. 判对错        —— 改成绩、决定它多久后再来    【判定】

   建议阅读顺序：先看下面的【存储】，再看【调度】，
   因为“间隔重复”这个算法的全部秘密就在【调度】那二十行里。
   ========================================================== */


/* ==========================================================
   一、小工具
   ========================================================== */

// 把用户输入塞进网页之前先转义，防止输入里的 < > 被当成标签执行
function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 比对拼写时用：全部转小写，只留字母。这样 Abandon / abandon / abandon. 都算对
function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z]/g,''); }

// 洗牌（随机打乱数组）。用于：打乱选项顺序、打乱本轮出题顺序
function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    const t=a[i]; a[i]=a[j]; a[j]=t;
  }
  return a;
}

// 今天的日期，形如 2026-11-11。用来判断“今日已答”要不要清零
function todayKey(){
  const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// 底部那条黑底提示
let toastT;
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('on');
  clearTimeout(toastT);
  toastT=setTimeout(()=>el.classList.remove('on'),2400);
}


/* ==========================================================
   二、存储：数据存在哪
   ----------------------------------------------------------
   没有服务器，没有数据库。全部存在浏览器的 localStorage 里
   （一个键值仓库，只能存字符串，所以要 JSON.stringify）。

   一个词长这样：
     { id, w:单词, p:词性, cn:释义,
       level:熟练度0~5, due:下次该复习的时间戳,
       right:答对次数, wrong:答错次数, seen:一共见过几次 }
   ========================================================== */

const KEY='cet4_notebook_v1';      // 存数据用的钥匙名。想彻底重来，改这个名字也行
let DB, storageOK=true;

function newWord(w,p,cn){
  return {
    id:'w'+Math.random().toString(36).slice(2,8),   // 随机 id，避免重名
    w:w, p:p||'', cn:cn,
    level:0, due:0, right:0, wrong:0, seen:0, born:Date.now()
  };
}

// 第一次打开时用的初始数据
function fresh(){
  return {
    words: SEED.map(s=>newWord(s[0],s[1],s[2])),
    day: todayKey(), todayN:0, todayR:0, best:0, total:0, round:20
  };
}

function load(){
  try{
    const raw=localStorage.getItem(KEY);
    if(raw){
      const d=JSON.parse(raw);
      if(d && Array.isArray(d.words)) return d;     // 有旧数据就接着用
    }
  }catch(e){ storageOK=false; }                     // 浏览器不让读（比如隐私模式）
  return fresh();
}

function save(){
  if(!storageOK) return;
  try{ localStorage.setItem(KEY, JSON.stringify(DB)); }
  catch(e){ storageOK=false; toast('浏览器不让存了，这次的数据会丢'); }
}

// 跨天了就把“今日”计数清零
function checkDay(){
  const k=todayKey();
  if(DB.day!==k){ DB.day=k; DB.todayN=0; DB.todayR=0; save(); }
}


/* ==========================================================
   三、调度：这是整个软件的脑子
   ----------------------------------------------------------
   规则只有一句话：
       答对 → 熟练度 +1，下次间隔变长
       答错 → 熟练度 -1，下次间隔变短

   GAP 这张表就是“间隔多久再见它”：

     level  0     1     2     3     4     5
     间隔   10分钟  1天   2天   4天   8天   21天

   为什么这么设计：人忘东西是有规律的，刚记完忘得最快，
   每答对一次记忆就被加固一点，能撑住的时间就翻倍。
   在“快要忘”的那一刻再问一次，比天天重复问省力得多。
   （这个思路叫间隔重复，Anki、百词斩都是这一套。）
   ========================================================== */

const GAP=[0,1,2,4,8,21];   // 单位：天。level 0 的特殊，下面单独给 10 分钟

function schedule(w, ok){
  w.level = ok ? Math.min(5, w.level+1) : Math.max(0, w.level-1);
  const d=GAP[w.level];
  w.due = Date.now() + (d>0 ? d*86400000 : 6*60000);   // 86400000 = 一天的毫秒数
}

/*
  挑出这一轮要背哪些词。
  先收到期的（due 已过的）；到期的太少了，就补几个最弱的，
  这样你随便什么时候打开都有题做。
*/
function pool(){
  const now=Date.now();
  let due=DB.words.filter(w=>w.due<=now);
  due.sort((a,b)=> a.level-b.level || (b.wrong-a.wrong) || (a.seen-b.seen));
  if(due.length<8){
    const rest=DB.words.filter(w=>w.due>now)
      .sort((a,b)=> a.level-b.level || (b.wrong-a.wrong) || (a.seen-b.seen));
    due = due.concat(rest.slice(0, 8-due.length));
  }
  if(!due.length) due = DB.words.slice();
  return due;
}

/*
  定这一轮的具体名单。
  关键在“打散”两个字：如果每次都是同样的顺序，
  你会记住“第 7 题是 abandon”，那是假熟练。
  所以：只在最弱的一批词里挑（保证练到该练的），
        但顺序每次重新洗牌（保证不是背位置）。
*/
function pickRound(){
  const p=pool();
  const n=Math.min(DB.round, p.length);
  const head=p.slice(0, Math.min(p.length, n*2));
  const chosen=shuffle(head.slice()).slice(0, n);
  return shuffle(chosen).map(w=>w.id);
}


/* ==========================================================
   四、一轮答题：队列
   ----------------------------------------------------------
   Q 是排队名单（存的是词的 id），QI 是当前排到第几个。
   答错的时候把这个词塞回队尾 —— 这就是“循环”的来源：
   你在这一轮里会再碰到它一次。
   ========================================================== */

let Q=[], QI=0, CUR=null, STARTED=0;
let RIGHT=0, WRONG=0, STREAK=0, RETRY={}, NEXT_T=null;

function startRound(){
  clearTimeout(NEXT_T);
  Q=pickRound();
  QI=0; RIGHT=0; WRONG=0; STREAK=0; RETRY={};
  STARTED=Q.length;
  if(!Q.length){ renderEmpty(); return; }
  nextQ();
}

function renderEmpty(){
  document.getElementById('plabel').textContent='词库是空的';
  document.getElementById('prompt').textContent='先去加几个词';
  document.getElementById('prompt').className='prompt is-cn';
  document.getElementById('answer').innerHTML=
    '<p class="vbody">在「词库」里输入单词和释义，或者用批量导入粘一列进去，然后回来接着背。</p>';
  document.getElementById('verdict').hidden=true;
}

function nextQ(){
  if(QI>=Q.length){ endRound(); return; }
  const w=DB.words.find(x=>x.id===Q[QI]);
  if(!w){ QI++; nextQ(); return; }          // 这个词被删了，跳过
  const mode = QI%2===0 ? 'e2c' : 'c2e';    // 一题看英选中，一题看中写英，交替来
  CUR={ w:w, mode:mode, opts: mode==='e2c'? makeOpts(w) : null, done:false };
  renderQ();
}


/* ==========================================================
   五、出题：把数据变成屏幕上的东西
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
    // —— 题型一：看英文，从 4 个中文里选 ——
    elPlabel.textContent='选出正确的意思';
    elPrompt.textContent=w.w;
    elPrompt.className='prompt';
    elAnswer.innerHTML='<div class="opts">'+CUR.opts.map((c,i)=>
      '<button class="opt" data-i="'+i+'">'+esc(c)+'</button>').join('')+'</div>';
    elAnswer.querySelectorAll('.opt').forEach(b=>{
      b.addEventListener('click',()=>chooseOpt(+b.dataset.i));
    });
  } else {
    // —— 题型二：看中文，把英文拼出来 ——
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
    sp.focus();                              // 自动把光标放进去，少点一下
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

/*
  生成三个“假答案”（干扰项）。
  优先从词性相同、释义不同的词里取，这样四个选项才像一套题，
  而不是一眼就能排除三个。
*/
function makeOpts(w){
  let cand=DB.words.filter(x=>x.id!==w.id && x.p===w.p);
  if(cand.length<3) cand=DB.words.filter(x=>x.id!==w.id);
  const used={}; used[w.cn]=true;             // 防止干扰项和正确答案一模一样
  const picks=[]; const arr=cand.slice();
  while(picks.length<3 && arr.length){
    const i=Math.floor(Math.random()*arr.length);
    const c=arr.splice(i,1)[0].cn;
    if(!used[c]){ used[c]=true; picks.push(c); }
  }
  return shuffle([w.cn].concat(picks));
}


/* ==========================================================
   六、判对错
   ========================================================== */

function chooseOpt(i){
  if(CUR.done) return;                        // 已经答过就不许再点
  const chosen=CUR.opts[i];
  const correct=(chosen===CUR.w.cn);
  const ci=CUR.opts.indexOf(CUR.w.cn);
  elAnswer.querySelectorAll('.opt').forEach((b,k)=>{
    b.disabled=true;
    if(k===ci) b.classList.add('is-right');   // 正确的那项永远标绿
    else if(k===i) b.classList.add('is-wrong');// 你点错的那项标红
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
    sp.value=sp.value.trim()+'  →  '+CUR.w.w;  // 把正确答案并排摆给你看
  }
  judge(ok);
}

function judge(ok){
  const w=CUR.w;
  CUR.done=true;
  checkDay();

  // 记账
  w.seen=(w.seen||0)+1;
  DB.total=(DB.total||0)+1;
  DB.todayN=(DB.todayN||0)+1;
  if(ok){ w.right++; RIGHT++; DB.todayR=(DB.todayR||0)+1; STREAK++; }
  else { w.wrong++; WRONG++; STREAK=0; }
  if(STREAK>DB.best) DB.best=STREAK;          // 记下最长连对

  schedule(w, ok);                            // 改熟练度 + 定下次时间
  if(!ok && (RETRY[w.id]||0)<1){              // 答错的塞回队尾，这一轮还能再碰一次
    RETRY[w.id]=(RETRY[w.id]||0)+1;
    Q.push(w.id);
  }
  save();
  showVerdict(ok, w);
  updateFoot();

  QI++;
  if(ok){
    NEXT_T=setTimeout(()=>{ nextQ(); }, 1100); // 答对：停 1.1 秒自动翻下一题
  } else {
    // 答错：停住，让你把释义看完再走
    const nextBtn=document.createElement('button');
    nextBtn.className='btn';
    nextBtn.textContent='看下一个';
    nextBtn.style.marginTop='2px';
    nextBtn.addEventListener('click',()=>{ clearTimeout(NEXT_T); nextQ(); });
    elAnswer.appendChild(nextBtn);
  }
}

// 画出那个红叉或青勾
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
    '错 '+w.wrong+' 次 · 对 '+w.right+' 次'+
    (ok ? ' · '+GAP[w.level]+' 天后再见' : ' · 这一轮还会再翻到它');
}


/* ==========================================================
   七、一轮结束的小结
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

  const weakest=DB.words.slice()
    .sort((a,b)=> (b.wrong-b.right)-(a.wrong-a.right))
    .slice(0,3);

  let html='<p class="vbody">正确率 '+acc+'%，最长连对 '+DB.best+' 个。';
  if(WRONG>0 && weakest.length){
    html+='<br>最该盯住的：'+weakest.map(w=>'<b>'+esc(w.w)+'</b>').join('、')+'。';
  } else {
    html+='<br>这一轮没出错，下一轮的词会隔得更久才回来。';
  }
  html+='</p>';
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

// 5 格熟练度小条。level<=1 显示红色，表示还是生词
function pips(lv){
  let s='<span class="pips">';
  for(let i=1;i<=5;i++){
    s+= (i<=lv) ? '<i class="on'+(lv<=1?' hard':'')+'"></i>' : '<i></i>';
  }
  return s+'</span>';
}

function renderLib(){
  const q=(document.getElementById('search').value||'').trim().toLowerCase();
  let list=DB.words.slice();
  if(q) list=list.filter(w=> w.w.toLowerCase().includes(q) || w.cn.indexOf(q)>-1);
  list.sort((a,b)=> a.w.toLowerCase().localeCompare(b.w.toLowerCase()));

  const box=document.getElementById('lib-list');
  document.getElementById('lib-count').textContent=list.length+' 个';

  if(!list.length){
    box.innerHTML='<div class="empty"><b>'+(q? '没搜到':'词库是空的')+'</b>'+
      (q? '换个词试试，或者检查有没有打错。':'把错过的词加进来，它就会自己找上门。')+'</div>';
    return;
  }

  box.innerHTML=list.map(w=>
    '<div class="lib-row">'+
      '<span class="lib-w">'+esc(w.w)+(w.p? ' <em>'+esc(w.p)+'</em>':'')+'</span>'+
      '<span class="lib-cn">'+esc(w.cn)+'</span>'+
      '<span class="lib-meta">'+pips(w.level)+
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
  把粘贴进来的一整段文字拆成一个个词。
  认这几种写法，都一样管用：
      abandon 放弃
      abandon,放弃
      abandon，放弃
      abandon<Tab>放弃
*/
function parseBulk(text){
  const out=[];
  String(text||'').split(/\r?\n/).forEach(line=>{
    const t=line.trim();
    if(!t) return;
    const m=t.match(/^([^\s,，\t]+)[\s,，\t]+(.+)$/);
    if(!m) return;
    const w=m[1].trim(), cn=m[2].trim();
    if(!/^[a-zA-Z][a-zA-Z\-'.]*$/.test(w)) return;   // 不是英文开头，跳过
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
    if(DB.words.some(x=>x.w.toLowerCase()===r[0].toLowerCase())){ dup++; return; }  // 已有的跳过
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
  const now=Date.now();
  document.getElementById('s-total').textContent=DB.words.length;
  document.getElementById('s-master').textContent=DB.words.filter(w=>w.level>=4).length;
  document.getElementById('s-due').textContent=DB.words.filter(w=>w.due<=now).length;
  document.getElementById('s-today').textContent=DB.todayN||0;

  let r=0, x=0;
  DB.words.forEach(w=>{ r+=w.right; x+=w.wrong; });
  document.getElementById('s-acc').textContent =
    (r+x)? '正确率 '+Math.round(r/(r+x)*100)+'%' : '正确率 —';

  // 熟练度分布：每个 level 有多少个词
  const labels=['刚认识','见过几次','有点印象','比较熟','很熟','条件反射'];
  const counts=[0,0,0,0,0,0];
  DB.words.forEach(w=>{ counts[Math.min(5, w.level||0)]++; });
  const maxc=Math.max(1, ...counts);

  document.getElementById('dist').innerHTML = labels.map((lab,i)=>{
    const pct=Math.round(counts[i]/maxc*100);
    return '<div class="drow"><span>L'+i+'</span>'+
      '<span class="dbar"><i class="'+(i<=1?'hard':'')+'" style="width:'+pct+'%"></i></span>'+
      '<span>'+counts[i]+'</span></div>';
  }).join('') +
  '<div style="font-size:11px;color:var(--muted);margin-top:2px">'+
    labels.map((l,i)=>'L'+i+' '+l).join(' · ')+'</div>';

  // 错得最多的 5 个
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
  a.download='单词错题本备份-'+todayKey()+'.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  toast('已导出到下载文件夹');
}

function resetData(){
  if(!confirm('清空所有记录，恢复到最初的 100 个词？这一步不能撤销。')) return;
  try{ localStorage.removeItem(KEY); }catch(e){}
  DB=fresh(); save();
  renderLib(); renderStats(); startRound();
  toast('已重置');
}


/* ==========================================================
   十一、切换视图（背 / 词库 / 进度）
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
  // 答题中途切走过，回来时自动翻到下一题，别停在已答完的题上
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

// 键盘 1/2/3/4 直接选选项，手不用来回摸鼠标
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
if(!DB.round) DB.round=20;      // 兼容早期没写这个字段的数据
checkDay();
if(!storageOK) toast('这个浏览器禁用了本地存储，记录不会保存');
startRound();
