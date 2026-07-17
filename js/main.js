// Navegação Pós-Alta CHN — app multiusuário (Firebase Auth + Firestore).
// Perfis: admin (todas as abas), navegador (todas exceto Dashboard/Equipe),
// recepcao (somente Cobrança · Recepção).

import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFirestore, collection, collectionGroup, doc, addDoc, setDoc, updateDoc, onSnapshot,
  writeBatch, increment, serverTimestamp, deleteField, getDocs, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';
import { COBRANCA } from './cobranca-data.js';
import { classificarCenso, classificarAltaParcial, flagCrit, faixaEtaria, FAIXAS } from './scoring.js';
import { parseCenso, parseAltas, parsePS } from './parsers.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MOTIVOS_NAO_CONTATO = ['Agendado no CME', 'Consulta extra-CME', 'Outros'];
const MOTIVOS_NAO_AGENDADO = ['Recusa', 'Consulta extra-CME', 'Outros'];
const ESP_ONCO_MATRIZ = ['ONCOLOGIA', 'HEMATOLOGIA', 'CIRURGIA ONCOLÓGICA', 'CARDIO-ONCOLOGIA'];

const state = {
  uid: null, nome: '', role: null,
  users: [],                 // somente admin recebe
  pacientes: new Map(),      // atend -> doc data
  selAltas: new Set(), selPS: new Set(),
  f: { q3: '', t3: 'ALL', meus3: false, conv: '', idmin: '', idmax: '', dtini: '', dtfim: '',
       q4: '', t4: 'ALL', meus4: false, q2: '', t2: 'ALL', meus2: false, seg: 'conv' },
  modalAtend: null,
  unsubs: [],
};

function all() { return [...state.pacientes.values()]; }
function navegaveis() {
  return all().filter(d => ['A', 'B', 'C'].includes(d.trilha) || (d.nContatos || 0) > 0 || (d.agenda && d.agenda.data));
}
function statusOf(d) {
  const ag = d.agenda;
  if (!ag || !ag.data) return 'pend';
  if (ag.resultado === 'ok') return 'ok';
  if (ag.resultado === 'noshow') return 'noshow';
  return 'agend';
}
function nowBR() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function brData(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '—');
}
function norm(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, '');
}

// ================================================================ AUTH
$('btn-login').onclick = async () => {
  $('login-err').textContent = '';
  try {
    await signInWithEmailAndPassword(auth, $('login-email').value.trim(), $('login-senha').value);
  } catch (e) {
    $('login-err').textContent = e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found'
      ? 'E-mail ou senha incorretos.' : 'Erro ao entrar: ' + (e.code || e.message);
  }
};
$('login-senha').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-login').click(); });
$('btn-sair').onclick = () => signOut(auth);
$('btn-sair-pend').onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  state.unsubs.forEach(u => u()); state.unsubs = [];
  state.pacientes.clear(); state.users = [];
  if (!user) {
    state.uid = null; state.role = null;
    show('login'); return;
  }
  state.uid = user.uid;
  // carrega (ou cria) o doc de perfil
  const meRef = doc(db, 'users', user.uid);
  const unsubMe = onSnapshot(meRef, snap => {
    if (!snap.exists()) {
      setDoc(meRef, { email: user.email, nome: user.email.split('@')[0], role: 'pendente', criadoEm: serverTimestamp() });
      show('pending'); return;
    }
    const me = snap.data();
    state.nome = me.nome || user.email;
    if (!me.role || me.role === 'pendente') { show('pending'); return; }
    if (state.role !== me.role) { state.role = me.role; enterApp(); }
  }, () => show('pending'));
  state.unsubs.push(unsubMe);
});

function show(which) {
  $('login-view').style.display = which === 'login' ? 'flex' : 'none';
  $('pending-view').style.display = which === 'pending' ? 'flex' : 'none';
  $('app-view').style.display = which === 'app' ? 'block' : 'none';
}

const ROLE_LABEL = { admin: 'Administrador', navegador: 'Navegador', recepcao: 'Recepção' };

function enterApp() {
  show('app');
  $('user-chip').innerHTML = `<b>${esc(state.nome)}</b> · ${ROLE_LABEL[state.role] || state.role}`;
  // abas por perfil
  let first = null;
  document.querySelectorAll('.tab').forEach(t => {
    const ok = t.dataset.roles.split(',').includes(state.role);
    t.classList.toggle('allowed', ok);
    if (ok && !first) first = t;
  });
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = state.role === 'admin' ? '' : 'none';
  });
  document.querySelectorAll('.chip.meus').forEach(ch => {
    ch.style.display = state.role === 'navegador' ? '' : 'none';
    if (state.role === 'navegador') ch.classList.add('on');
  });
  state.f.meus2 = state.f.meus3 = state.f.meus4 = (state.role === 'navegador');
  openTab(first.dataset.p);

  // assinaturas em tempo real
  if (state.role === 'admin' || state.role === 'navegador') {
    state.unsubs.push(onSnapshot(collection(db, 'pacientes'), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'removed') state.pacientes.delete(ch.doc.id);
        else state.pacientes.set(ch.doc.id, { atend: ch.doc.id, ...ch.doc.data() });
      });
      renderAll();
    }, e => console.error('pacientes:', e)));
  }
  if (state.role === 'admin') {
    state.unsubs.push(onSnapshot(collection(db, 'users'), snap => {
      state.users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      renderEquipe(); renderDash();
    }, e => console.error('users:', e)));
  }
  initCobranca();
}

// ================================================================ TABS
document.querySelectorAll('.tab').forEach(t => t.onclick = () => openTab(t.dataset.p));
function openTab(p) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.p === p));
  document.querySelectorAll('.panel').forEach(x => x.classList.toggle('on', x.id === 'p-' + p));
}

function renderAll() {
  renderDash(); renderAltas(); renderPS(); renderControle();
}

// ================================================================ DASHBOARD
function barRow(label, val, max, color) {
  const w = max ? Math.max(2, Math.round(val / max * 100)) : 0;
  return `<div class="brow"><div class="bl" title="${esc(label)}">${esc(label)}</div><div class="bt"><div class="bf" style="width:${w}%;background:${color}"></div></div><div class="bn">${val}</div></div>`;
}

function renderDash() {
  if (state.role !== 'admin') return;
  const A = all();
  const censo = A.filter(d => d.origens && d.origens.censo);
  $('d-tot').textContent = censo.length;
  $('d-a').textContent = censo.filter(d => d.trilha === 'A').length;
  $('d-b').textContent = censo.filter(d => d.trilha === 'B').length;
  $('d-c').textContent = censo.filter(d => d.trilha === 'C').length;
  $('d-baixo').textContent = censo.filter(d => d.trilha === '-').length;
  $('d-ns').textContent = censo.filter(d => d.alerta_noshow).length;

  const nav = navegaveis();
  const N = nav.length;
  const contatados = nav.filter(d => d.contatoSim);
  const agendados = nav.filter(d => d.agenda && d.agenda.data);
  const okc = nav.filter(d => statusOf(d) === 'ok');
  const nsc = nav.filter(d => statusOf(d) === 'noshow');

  // funil
  const steps = [
    ['Abordáveis', N, 'var(--navy)'],
    ['Contato realizado', contatados.length, 'var(--teal)'],
    ['Agendados', agendados.length, '#0a9a97'],
    ['Consulta realizada', okc.length, 'var(--green)'],
    ['No-show', nsc.length, 'var(--red)'],
  ];
  const totReg = nav.reduce((s, d) => s + (d.nContatos || 0), 0);
  const semSucesso = nav.filter(d => (d.nContatos || 0) > 0 && !d.contatoSim).length;
  const naoAgend = contatados.filter(d => !(d.agenda && d.agenda.data)).length;
  const cmePre = nav.filter(d => d.agenda && d.agenda.origem === 'CME (pré-existente)').length;
  $('funil').innerHTML = steps.map(([lb, v, c]) =>
    `<div class="frow2"><div class="lb">${lb}</div><div class="track"><div class="fill" style="width:${N ? Math.max(3, Math.round(v / N * 100)) : 0}%;background:${c}">${v}</div></div><div class="pct">${N ? Math.round(v / N * 100) : 0}%</div></div>`
  ).join('') + `<div class="sub" style="margin-top:10px">${totReg} registros de contato · ${semSucesso} contato sem sucesso · ${naoAgend} contatados e não agendados · ${cmePre} já agendados no CME (sem contato)</div>`;

  // performance por navegador
  const navs = state.users.filter(u => u.role === 'navegador');
  const rows = [...navs.map(u => ({ nome: u.nome || u.email, uid: u.uid })), { nome: 'Sem navegador', uid: null }];
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  $('perf-bd').innerHTML = rows.map(r => {
    // navegadores: tudo que lhes foi atribuído; "Sem navegador": só a fila navegável
    const meus = r.uid ? A.filter(d => d.assignedTo === r.uid) : nav.filter(d => !d.assignedTo);
    const ct = meus.filter(d => d.contatoSim).length;
    const ag = meus.filter(d => d.agenda && d.agenda.data).length;
    const ok = meus.filter(d => statusOf(d) === 'ok').length;
    const ns = meus.filter(d => statusOf(d) === 'noshow').length;
    return `<tr><td class="pac">${esc(r.nome)}</td><td style="text-align:center">${meus.length}</td><td style="text-align:center">${ct}</td><td style="text-align:center">${ag}</td><td style="text-align:center;color:var(--green);font-weight:700">${ok}</td><td style="text-align:center;color:var(--red);font-weight:700">${ns}</td><td style="text-align:center">${pct(ct, meus.length)}</td><td style="text-align:center">${pct(ag, ct)}</td><td style="text-align:center">${pct(ok, ok + ns)}</td></tr>`;
  }).join('') || '<tr><td colspan="9" class="sub">Nenhum navegador cadastrado — crie na aba Equipe.</td></tr>';

  // motivos
  const mot = {};
  nav.forEach(d => { Object.entries(d.motivosCount || {}).forEach(([k, v]) => { mot[k] = (mot[k] || 0) + v; }); });
  const motArr = Object.entries(mot).sort((a, b) => b[1] - a[1]);
  const mMax = motArr.length ? motArr[0][1] : 0;
  $('ct-tipo').innerHTML = motArr.map(([k, v]) => barRow(k, v, mMax, 'var(--amber)')).join('') || '<div class="sub">Sem registros ainda.</div>';

  // comparecimento
  const agN = agendados.length;
  $('ct-desf').innerHTML = agN ? [
    barRow('Compareceu', okc.length, agN, 'var(--green)'),
    barRow('No-show', nsc.length, agN, 'var(--red)'),
    barRow('Aguardando', agN - okc.length - nsc.length, agN, 'var(--amber)'),
  ].join('') : '<div class="sub">Nenhuma consulta agendada ainda.</div>';

  renderSeg(agendados);
}

function segKey(d) {
  if (state.f.seg === 'conv') return d.convenio || '—';
  if (state.f.seg === 'idade') return faixaEtaria(d.anos != null ? d.anos : d.idade);
  const s = String(d.sexo || '').charAt(0).toUpperCase();
  return s === 'F' ? 'Feminino' : (s === 'M' ? 'Masculino' : '—');
}
function renderSeg(agendados) {
  const title = { conv: 'Operadora', idade: 'Faixa etária', sexo: 'Sexo' }[state.f.seg];
  $('seg-title').textContent = title; $('seg-col').textContent = title;
  const g = {};
  agendados.forEach(d => {
    const k = segKey(d);
    g[k] = g[k] || { ag: 0, ok: 0, ns: 0 };
    g[k].ag++;
    if (statusOf(d) === 'ok') g[k].ok++;
    if (statusOf(d) === 'noshow') g[k].ns++;
  });
  let keys = Object.keys(g).sort((a, b) => g[b].ag - g[a].ag);
  if (state.f.seg === 'idade') keys = FAIXAS.filter(f => g[f]);
  const tot = { ag: 0, ok: 0, ns: 0 };
  const rows = keys.map(k => {
    const x = g[k]; tot.ag += x.ag; tot.ok += x.ok; tot.ns += x.ns;
    const p = (x.ok + x.ns) ? Math.round(x.ok / (x.ok + x.ns) * 100) + '%' : '—';
    return `<tr><td>${esc(k)}</td><td style="text-align:center">${x.ag}</td><td style="text-align:center">${x.ok}</td><td style="text-align:center">${x.ns}</td><td style="text-align:center">${p}</td></tr>`;
  });
  const pT = (tot.ok + tot.ns) ? Math.round(tot.ok / (tot.ok + tot.ns) * 100) + '%' : '—';
  rows.push(`<tr style="font-weight:700"><td>Total</td><td style="text-align:center">${tot.ag}</td><td style="text-align:center">${tot.ok}</td><td style="text-align:center">${tot.ns}</td><td style="text-align:center">${pT}</td></tr>`);
  $('seg-bd').innerHTML = rows.join('');
}
document.querySelectorAll('[data-seg]').forEach(ch => ch.onclick = () => {
  document.querySelectorAll('[data-seg]').forEach(x => x.classList.remove('on'));
  ch.classList.add('on'); state.f.seg = ch.dataset.seg; renderDash();
});

// ================================================================ ALTAS
function altasList() {
  const f = state.f;
  return all().filter(d => d.origens && d.origens.alta).filter(d => {
    if (f.t3 !== 'ALL' && d.tier !== f.t3) return false;
    if (f.meus3 && d.assignedTo !== state.uid) return false;
    if (f.conv && (d.convenio || '') !== f.conv) return false;
    const anos = d.anos != null ? d.anos : d.idade;
    if (f.idmin !== '' && (anos == null || anos < +f.idmin)) return false;
    if (f.idmax !== '' && (anos == null || anos > +f.idmax)) return false;
    if (f.dtini && (d.altaISO || '') < f.dtini) return false;
    if (f.dtfim && (d.altaISO || '') > f.dtfim) return false;
    if (f.q3) {
      const q = f.q3.toLowerCase();
      const blob = [d.pac, d.unidade, d.origemAdm, d.cid, d.atend].join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

function navTag(d) {
  return d.assignedToName
    ? `<span class="nav-tag">${esc(d.assignedToName)}</span>`
    : '<span class="nav-tag none">—</span>';
}

function renderAltas() {
  const altas = all().filter(d => d.origens && d.origens.alta);
  $('al-tot').textContent = altas.length;
  $('al-alto').textContent = altas.filter(d => d.tier === 'ALTO').length;
  $('al-medio').textContent = altas.filter(d => d.tier === 'MEDIO').length;
  $('al-cruz').textContent = altas.filter(d => d.fonte === 'completo').length;
  $('al-atrib').textContent = altas.filter(d => d.assignedTo).length;

  // popular select de operadoras
  const convs = [...new Set(altas.map(d => d.convenio).filter(Boolean))].sort();
  const sel = $('f-conv'), cur = sel.value;
  sel.innerHTML = '<option value="">Operadora: todas</option>' + convs.map(c => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');

  const list = altasList();
  const isAdmin = state.role === 'admin';
  $('distbar-altas').style.display = isAdmin ? 'flex' : 'none';
  $('bd3').innerHTML = list.map(d => {
    const flags = (d.flags || []).map(fl => `<span class="fl${flagCrit(fl) ? ' crit' : ''}">${esc(fl)}</span>`).join('');
    const chk = isAdmin ? `<td><input type="checkbox" data-sel3="${esc(d.atend)}"${state.selAltas.has(d.atend) ? ' checked' : ''}></td>` : '';
    return `<tr>${chk}
      <td><span class="score">${d.score ?? '—'}</span><br><span class="tier ${d.tier}">${d.tier || ''}</span></td>
      <td><span class="sub">${d.fonte === 'completo' ? 'censo · completo' : 'parcial'}</span></td>
      <td>${esc(d.atend)}</td>
      <td><span class="pac">${esc(d.pac)}</span>${d.cid ? `<div class="sub">CID ${esc(d.cid)}</div>` : ''}${d.med ? `<div class="sub">${esc(d.med)}</div>` : ''}<div class="flags">${flags}</div>${d.alerta_noshow ? '<span class="ns-badge">RISCO NO-SHOW</span>' : ''}</td>
      <td>${d.anos != null ? d.anos : (d.idade != null ? d.idade : '—')}</td>
      <td>${esc(d.sexo || '—')}</td>
      <td>${d.dih != null && d.dih !== '' ? esc(d.dih) : '—'}</td>
      <td>${esc(d.convenio || '—')}</td>
      <td>${esc(d.origemAdm || '—')}</td>
      <td>${esc(d.unidade || '—')}</td>
      <td>${esc(d.alta || '—')}</td>
      <td>${navTag(d)}</td>
      <td class="orient">${esc(d.orientacao || '')}</td>
      <td><button class="btn" data-open="${esc(d.atend)}">Abrir</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="15" class="sub" style="padding:18px">Nenhuma alta na base — carregue um arquivo de altas acima.</td></tr>`;
  $('sel-info-altas').textContent = state.selAltas.size + ' selecionados';
  wireRowEvents($('bd3'), 'sel3', state.selAltas, 'sel-info-altas');
}

// ================================================================ PS
function psList() {
  const f = state.f;
  return all().filter(d => d.origens && d.origens.ps).filter(d => {
    const p = d.ps || {};
    if (f.t4 === 'SEM' && p.agfut) return false;
    if (f.t4 === 'COM' && !p.agfut) return false;
    if (f.t4 === 'INT' && !p.int30) return false;
    if (f.meus4 && d.assignedTo !== state.uid) return false;
    if (f.q4) {
      const q = f.q4.toLowerCase();
      const blob = [d.pac, p.esp, d.convenio, p.aval, d.atend].join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    const pa = a.ps || {}, pb = b.ps || {};
    if (!!pa.agfut !== !!pb.agfut) return pa.agfut ? 1 : -1;
    return String(pb.fechISO || pb.fech || '').localeCompare(String(pa.fechISO || pa.fech || ''));
  });
}

function renderPS() {
  const ps = all().filter(d => d.origens && d.origens.ps);
  $('ps-tot').textContent = ps.length;
  $('ps-sem').textContent = ps.filter(d => !(d.ps && d.ps.agfut)).length;
  $('ps-com').textContent = ps.filter(d => d.ps && d.ps.agfut).length;
  $('ps-int30').textContent = ps.filter(d => d.ps && d.ps.int30).length;

  const list = psList();
  const isAdmin = state.role === 'admin';
  $('distbar-ps').style.display = isAdmin ? 'flex' : 'none';
  $('bd4').innerHTML = list.map(d => {
    const p = d.ps || {};
    const chk = isAdmin ? `<td><input type="checkbox" data-sel4="${esc(d.atend)}"${state.selPS.has(d.atend) ? ' checked' : ''}></td>` : '';
    return `<tr>${chk}
      <td>${esc(d.atend)}<div class="sub">${esc(p.codpac || '')}</div></td>
      <td><span class="pac">${esc(d.pac)}</span></td>
      <td>${esc(d.convenio || '—')}</td>
      <td>${esc(p.esp || '—')}</td>
      <td>${p.agfut ? '<span class="status ok">SIM</span>' : '<span class="status pend">NÃO</span>'}</td>
      <td style="text-align:center">${p.retorno != null ? p.retorno : '—'}</td>
      <td>${esc(p.fech || '—')}</td>
      <td class="orient">${esc(p.medEnc || '—')}</td>
      <td>${p.int30 ? '<span class="status pend">SIM</span>' : '—'}</td>
      <td>${esc(p.aval || '—')}</td>
      <td>${navTag(d)}</td>
      <td><button class="btn" data-open="${esc(d.atend)}">Abrir</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="13" class="sub" style="padding:18px">Nenhum egresso do PS na base — carregue o export 6906 acima.</td></tr>`;
  $('sel-info-ps').textContent = state.selPS.size + ' selecionados';
  wireRowEvents($('bd4'), 'sel4', state.selPS, 'sel-info-ps');
}

function wireRowEvents(tbody, selAttr, selSet, infoId) {
  tbody.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openModal(b.dataset.open));
  tbody.querySelectorAll(`[data-${selAttr}]`).forEach(cb => cb.onchange = () => {
    const k = cb.dataset[selAttr];
    if (cb.checked) selSet.add(k); else selSet.delete(k);
    $(infoId).textContent = selSet.size + ' selecionados';
  });
  tbody.querySelectorAll('[data-res]').forEach(b => b.onclick = () => setResultado(b.dataset.atend, b.dataset.res));
  tbody.querySelectorAll('[data-reopen]').forEach(b => b.onclick = () => reabrir(b.dataset.reopen));
}

// ================================================================ ACOMPANHAMENTO
function renderControle() {
  const f = state.f;
  const list = navegaveis().filter(d => d.agenda && d.agenda.data).filter(d => {
    const st = statusOf(d);
    if (f.t2 !== 'ALL' && st !== f.t2) return false;
    if (f.meus2 && d.assignedTo !== state.uid) return false;
    if (f.q2 && !String(d.pac || '').toLowerCase().includes(f.q2.toLowerCase())) return false;
    return true;
  }).sort((a, b) => String(a.agenda.data).localeCompare(String(b.agenda.data)));

  $('bd2').innerHTML = list.map(d => {
    const st = statusOf(d);
    const stHtml = st === 'ok' ? '<span class="status ok">Compareceu</span>'
      : st === 'noshow' ? '<span class="status pend">No-show</span>'
      : '<span class="status prog">Aguardando</span>';
    const acoes = st === 'agend'
      ? `<button class="btn ok" data-res="ok" data-atend="${esc(d.atend)}">&#10003; Compareceu</button> <button class="btn no" data-res="noshow" data-atend="${esc(d.atend)}">&#10007; No-show</button>`
      : `<button class="btn" data-reopen="${esc(d.atend)}">Reabrir</button>`;
    return `<tr>
      <td><span class="trilha ${['A','B','C','PS'].includes(d.trilha) ? d.trilha : '_'}">${esc(d.trilha || '-')}</span></td>
      <td><span class="pac">${esc(d.pac)}</span><div class="sub">Atend. ${esc(d.atend)}</div>${d.alerta_noshow ? '<span class="ns-badge">RISCO NO-SHOW</span>' : ''}</td>
      <td class="jan">${brData(d.agenda.data)}</td>
      <td>${esc(d.agenda.prestador || '—')}<div class="sub">${esc(d.agenda.origem || '')}</div></td>
      <td>${stHtml}</td>
      <td>${navTag(d)}</td>
      <td style="text-align:center">${d.nContatos || 0}</td>
      <td>${acoes} <button class="btn" data-open="${esc(d.atend)}">Abrir</button></td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="sub" style="padding:18px">Nenhum paciente com consulta agendada${f.t2 !== 'ALL' || f.meus2 ? ' nos filtros atuais' : ''}.</td></tr>`;
  wireRowEvents($('bd2'), 'selX', new Set(), 'sel-info-altas');
}

async function setResultado(atend, res) {
  const d = state.pacientes.get(atend);
  if (!d) return;
  await updateDoc(doc(db, 'pacientes', atend), { 'agenda.resultado': res, nContatos: increment(1) });
  await addDoc(collection(db, 'pacientes', atend, 'contatos'), {
    atend, pacNome: d.pac || '', evento: res === 'ok' ? 'Compareceu' : 'No-show',
    obs: res === 'ok' ? 'Consulta realizada.' : 'Não compareceu — reforçar contato e reagendar se indicado.',
    dataStr: nowBR(), ts: serverTimestamp(), porUid: state.uid, porNome: state.nome,
  });
}
async function reabrir(atend) {
  await updateDoc(doc(db, 'pacientes', atend), { 'agenda.resultado': deleteField() });
}

// ================================================================ FILTROS (wiring)
const bind = (id, key, ev = 'input') => { $(id).addEventListener(ev, () => { state.f[key] = $(id).value; renderAll(); }); };
bind('q3', 'q3'); bind('q4', 'q4'); bind('q2', 'q2');
bind('f-conv', 'conv', 'change'); bind('f-idmin', 'idmin'); bind('f-idmax', 'idmax');
bind('f-dtini', 'dtini', 'change'); bind('f-dtfim', 'dtfim', 'change');
$('btn-limpar-altas').onclick = () => {
  ['q3', 'f-conv', 'f-idmin', 'f-idmax', 'f-dtini', 'f-dtfim'].forEach(id => { $(id).value = ''; });
  Object.assign(state.f, { q3: '', conv: '', idmin: '', idmax: '', dtini: '', dtfim: '' });
  renderAll();
};
function chipGroup(attr, key) {
  document.querySelectorAll(`[data-${attr}]`).forEach(ch => ch.onclick = () => {
    document.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.remove('on'));
    ch.classList.add('on'); state.f[key] = ch.dataset[attr]; renderAll();
  });
}
chipGroup('t3', 't3'); chipGroup('t4', 't4'); chipGroup('t2', 't2');
document.querySelectorAll('.chip.meus').forEach(ch => ch.onclick = () => {
  ch.classList.toggle('on');
  const on = ch.classList.contains('on');
  if ('meus3' in ch.dataset) state.f.meus3 = on;
  if ('meus4' in ch.dataset) state.f.meus4 = on;
  if ('meus2' in ch.dataset) state.f.meus2 = on;
  renderAll();
});

$('sel-all-altas').onchange = e => {
  const list = altasList();
  if (e.target.checked) list.forEach(d => state.selAltas.add(d.atend));
  else list.forEach(d => state.selAltas.delete(d.atend));
  renderAltas();
};
$('sel-all-ps').onchange = e => {
  const list = psList();
  if (e.target.checked) list.forEach(d => state.selPS.add(d.atend));
  else list.forEach(d => state.selPS.delete(d.atend));
  renderPS();
};

// ================================================================ DISTRIBUIÇÃO
async function distribuir(selSet) {
  if (state.role !== 'admin') return;
  const navs = state.users.filter(u => u.role === 'navegador');
  if (!navs.length) { alert('Nenhum usuário com perfil Navegador — crie na aba Equipe.'); return; }
  const docs = [...selSet].map(a => state.pacientes.get(a)).filter(Boolean)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!docs.length) { alert('Nenhum paciente selecionado.'); return; }
  // começa pelo navegador com menor fila ativa, para equilibrar a carga total
  const load = uid => all().filter(d => d.assignedTo === uid && statusOf(d) !== 'ok' && statusOf(d) !== 'noshow').length;
  const ordered = [...navs].sort((a, b) => load(a.uid) - load(b.uid) || String(a.nome).localeCompare(String(b.nome)));
  const plano = new Map(ordered.map(u => [u.uid, []]));
  docs.forEach((d, i) => plano.get(ordered[i % ordered.length].uid).push(d));
  const resumo = ordered.map(u => `${u.nome || u.email}: ${plano.get(u.uid).length}`).join('\n');
  if (!confirm(`Distribuir ${docs.length} paciente(s) igualmente entre ${ordered.length} navegador(es)?\n\n${resumo}`)) return;

  let batch = writeBatch(db), n = 0;
  for (const u of ordered) {
    for (const d of plano.get(u.uid)) {
      batch.update(doc(db, 'pacientes', d.atend), { assignedTo: u.uid, assignedToName: u.nome || u.email });
      if (++n >= 400) { await batch.commit(); batch = writeBatch(db); n = 0; }
    }
  }
  if (n) await batch.commit();
  selSet.clear();
  $('sel-all-altas').checked = false; $('sel-all-ps').checked = false;
}
$('btn-dist-altas').onclick = () => distribuir(state.selAltas);
$('btn-dist-ps').onclick = () => distribuir(state.selPS);

// ================================================================ UPLOADS
function readWB(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { try { res(XLSX.read(new Uint8Array(r.result), { type: 'array' })); } catch (e) { rej(e); } };
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}

async function commitDocs(updates) {
  // updates: [{atend, data}] — grava em lotes de 400 com merge (preserva agenda/contatos)
  let batch = writeBatch(db), n = 0;
  for (const u of updates) {
    batch.set(doc(db, 'pacientes', u.atend), u.data, { merge: true });
    if (++n >= 400) { await batch.commit(); batch = writeBatch(db); n = 0; }
  }
  if (n) await batch.commit();
}

$('file-censo').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const rows = parseCenso(await readWB(file));
    const updates = rows.map(x => {
      const c = classificarCenso(x);
      return { atend: c.atend, data: {
        pac: c.pac, dt: c.dt, leito: c.leito, dn: c.dn, med: c.med || '', dih: c.dih,
        news: c.news, risco: c.risco, charlson: c.charlson, fugulin: c.fugulin,
        dieta: c.dieta, ccih: c.ccih, mrc: c.mrc, cp: c.cp, nutri: c.nutri, prev_alta: c.prev_alta,
        idade: c.idade, score: c.score, flags: c.flags, tier: c.tier, trilha: c.trilha,
        janela: c.janela, paliativo: c.paliativo, alerta_noshow: c.alerta_noshow,
        orientacao: c.orientacao, fonte: 'completo',
        origens: { censo: true }, censoEm: serverTimestamp(), atualizadoPor: state.nome,
      } };
    });
    await commitDocs(updates);
    $('altas-info').textContent = `Censo atualizado: ${updates.length} pacientes (${nowBR()}).`;
  } catch (err) { alert('Erro ao importar censo: ' + err.message); }
};

$('file-altas').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const { items, excl } = parseAltas(await readWB(file));
    const updates = items.map(item => {
      const existing = state.pacientes.get(item.atend);
      const base = {
        pac: item.pac, anos: item.anos, idadeStr: item.idadeStr || '', sexo: item.sexo || '',
        convenio: item.convenio || '', cid: item.cid || '', dih: item.dih,
        origemAdm: item.origemAdm || '', unidade: item.unidade || '', motivo: item.motivo || '',
        alta: item.alta || '', altaISO: item.altaISO || '',
        origens: { alta: true }, altaEm: serverTimestamp(), atualizadoPor: state.nome,
      };
      if (item.med) base.med = item.med;
      if (existing && existing.origens && existing.origens.censo && ['A', 'B', 'C'].includes(existing.trilha)) {
        // cruzou com o censo: mantém o score completo
        base.fonte = 'completo';
      } else {
        const c = classificarAltaParcial(item);
        Object.assign(base, {
          score: c.score, flags: c.flags, tier: c.tier, trilha: c.trilha, janela: c.janela,
          paliativo: false, alerta_noshow: existing?.alerta_noshow || false,
          orientacao: c.orientacao, fonte: 'parcial',
        });
      }
      return { atend: item.atend, data: base };
    });
    await commitDocs(updates);
    $('altas-info').textContent = `Altas importadas: ${updates.length} elegíveis · ${excl} excluídas (berçário/day clinic/Z38/O80) — ${nowBR()}.`;
  } catch (err) { alert('Erro ao importar altas: ' + err.message); }
};

$('file-ps').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const items = parsePS(await readWB(file));
    const updates = items.map(item => {
      const existing = state.pacientes.get(item.atend);
      const data = {
        pac: item.pac, convenio: item.convenio || '',
        ps: { codpac: item.codpac || '', esp: item.esp || '', agfut: item.agfut,
              retorno: item.retorno, fech: item.fech || '', medEnc: item.medEnc || '',
              int30: item.int30, aval: item.aval || '' },
        origens: { ps: true }, psEm: serverTimestamp(), atualizadoPor: state.nome,
      };
      if (!existing || !existing.trilha) {
        data.trilha = 'PS'; data.tier = '—';
        data.orientacao = 'Egresso do PS' + (item.agfut ? ' com agendamento futuro.' : ' SEM agendamento futuro: contatar e marcar retorno na especialidade recomendada' + (item.esp ? ' (' + item.esp + ')' : '') + (item.retorno != null ? ', retorno em ' + item.retorno + ' dias' : '') + '.');
      }
      return { atend: item.atend, data };
    });
    await commitDocs(updates);
    $('ps-info').textContent = `Egressos do PS importados: ${updates.length} — ${nowBR()}.`;
  } catch (err) { alert('Erro ao importar egressos do PS: ' + err.message); }
};

// ================================================================ MODAL
function openModal(atend) {
  const d = state.pacientes.get(atend);
  if (!d) return;
  state.modalAtend = atend;
  const trilhaLb = d.trilha === '-' ? 'Baixo risco' : (d.trilha === 'PS' ? 'Egresso PS' : 'Trilha ' + d.trilha);
  $('m-title').textContent = `${d.pac} · ${trilhaLb}`;
  const or = esc(d.orientacao || '');
  $('m-sub').innerHTML = or.replace('[NO-SHOW]', '<span class="nsflag">[NO-SHOW]</span>');
  ['m-contato', 'm-agendado', 'm-motivo'].forEach(id => { $(id).value = ''; });
  $('m-texto').value = ''; $('m-agdata').value = ''; $('m-agprest').value = ''; $('m-err').textContent = '';
  modalFlow();
  renderAgView(d);
  loadHist(atend);
  $('modal-bg').classList.add('on');
}
$('btn-fechar').onclick = () => $('modal-bg').classList.remove('on');
$('modal-bg').addEventListener('click', e => { if (e.target === $('modal-bg')) $('modal-bg').classList.remove('on'); });

function modalFlow() {
  const ct = $('m-contato').value, ag = $('m-agendado').value, mo = $('m-motivo').value;
  const showAgendado = ct === 'SIM';
  $('row-agendado').style.display = showAgendado ? '' : 'none';
  let motivos = null;
  if (ct === 'NAO') motivos = MOTIVOS_NAO_CONTATO;
  else if (ct === 'SIM' && ag === 'NAO') motivos = MOTIVOS_NAO_AGENDADO;
  $('row-motivo').style.display = motivos ? '' : 'none';
  if (motivos) {
    const cur = $('m-motivo').value;
    $('m-motivo').innerHTML = '<option value="">— selecione —</option>' + motivos.map(m => `<option${m === cur ? ' selected' : ''}>${m}</option>`).join('');
  }
  const showTexto = (ct === 'SIM' && ag === 'OUTROS') || (motivos && $('m-motivo').value === 'Outros');
  $('row-texto').style.display = showTexto ? '' : 'none';
  const agendaNav = ct === 'SIM' && ag === 'SIM';
  const agendaCME = ct === 'NAO' && $('m-motivo').value === 'Agendado no CME';
  $('row-agenda').style.display = (agendaNav || agendaCME) ? 'grid' : 'none';
  $('lb-agdata').textContent = agendaCME ? 'Consulta já marcada no CME · Data' : 'Consulta de revisão · Data';
}
['m-contato', 'm-agendado', 'm-motivo'].forEach(id => $(id).addEventListener('change', modalFlow));

function renderAgView(d) {
  const ag = d.agenda;
  if (!ag || !ag.data) { $('m-agview').innerHTML = ''; return; }
  const res = ag.resultado === 'ok' ? '<span class="res-ok">Compareceu</span>'
    : ag.resultado === 'noshow' ? '<span class="res-ns">No-show</span>' : 'Aguardando';
  $('m-agview').innerHTML = `<div class="msec ag"><h4>Consulta agendada</h4><b>${brData(ag.data)}</b> · ${esc(ag.prestador || 'prestador a definir')} · ${esc(ag.origem || '')} · ${res}</div>`;
}

async function loadHist(atend) {
  $('m-hist').innerHTML = '<div class="sub">Carregando histórico…</div>';
  try {
    const snap = await getDocs(query(collection(db, 'pacientes', atend, 'contatos'), orderBy('ts', 'desc')));
    const rows = snap.docs.map(x => {
      const r = x.data();
      let lb;
      if (r.evento) lb = `<b>${esc(r.evento)}</b> — ${esc(r.obs || '')}`;
      else if (r.contato === 'SIM' && r.agendado === 'SIM') lb = `<b>Contato + agendamento</b> — consulta ${brData(r.consulta)} ${r.prestador ? 'com ' + esc(r.prestador) : ''}`;
      else if (r.contato === 'SIM' && r.agendado === 'OUTROS') lb = `<b>Contato · outros</b> — ${esc(r.texto || '')}`;
      else if (r.contato === 'SIM') lb = `<b>Contato sem agendamento</b> — ${esc(r.motivo || '')}${r.texto ? ': ' + esc(r.texto) : ''}`;
      else lb = `<b>Sem contato</b> — ${esc(r.motivo || '')}${r.texto ? ': ' + esc(r.texto) : ''}${r.consulta ? ' · consulta ' + brData(r.consulta) : ''}`;
      return `<div class="h">${lb}<div class="sub">${esc(r.dataStr || '')} · ${esc(r.porNome || '')}</div></div>`;
    });
    $('m-hist').innerHTML = rows.length ? '<h4 style="font-size:11.5px;text-transform:uppercase;color:var(--navy);margin-bottom:6px">Histórico</h4>' + rows.join('') : '<div class="sub">Sem registros anteriores.</div>';
  } catch (e) {
    $('m-hist').innerHTML = '<div class="sub">Não foi possível carregar o histórico.</div>';
  }
}

$('btn-reg').onclick = async () => {
  const atend = state.modalAtend;
  const d = state.pacientes.get(atend);
  if (!d) return;
  const ct = $('m-contato').value, ag = $('m-agendado').value, mo = $('m-motivo').value;
  const texto = $('m-texto').value.trim(), agdata = $('m-agdata').value, agprest = $('m-agprest').value.trim();
  const err = m => { $('m-err').textContent = m; };
  err('');
  if (!ct) return err('Informe se o contato foi realizado.');
  if (ct === 'SIM' && !ag) return err('Informe se a consulta foi agendada.');
  const motivoVisivel = $('row-motivo').style.display !== 'none';
  if (motivoVisivel && !mo) return err('Selecione o motivo.');
  if ($('row-texto').style.display !== 'none' && !texto) return err('Descreva a situação.');
  const agendaVisivel = $('row-agenda').style.display !== 'none';
  if (agendaVisivel && !agdata) return err('Informe a data da consulta.');

  const cmePre = ct === 'NAO' && mo === 'Agendado no CME';
  const rec = {
    atend, pacNome: d.pac || '', contato: ct, agendado: ct === 'SIM' ? ag : '',
    motivo: motivoVisivel ? mo : '', texto, cme: cmePre,
    consulta: agendaVisivel ? agdata : '', prestador: agendaVisivel ? agprest : '',
    dataStr: nowBR(), ts: serverTimestamp(), porUid: state.uid, porNome: state.nome,
  };
  const upd = { nContatos: increment(1), atualizadoPor: state.nome };
  if (ct === 'SIM') upd.contatoSim = true;
  const motKey = ct === 'SIM' && ag === 'OUTROS' ? 'Outros (agendamento)' : (motivoVisivel && mo ? mo : null);
  if (motKey) upd['motivosCount.' + motKey] = increment(1);
  if (agendaVisivel) {
    upd.agenda = { data: agdata, prestador: agprest, origem: cmePre ? 'CME (pré-existente)' : 'Navegação' };
  }
  $('btn-reg').disabled = true;
  try {
    await addDoc(collection(db, 'pacientes', atend, 'contatos'), rec);
    await updateDoc(doc(db, 'pacientes', atend), upd);
    if (agendaVisivel) { $('modal-bg').classList.remove('on'); openTab('controle'); }
    else { openModal(atend); }
  } catch (e) {
    err('Erro ao salvar: ' + (e.code || e.message));
  } finally {
    $('btn-reg').disabled = false;
  }
};

// ================================================================ CSV
$('btn-csv').onclick = async () => {
  try {
    const snap = await getDocs(collectionGroup(db, 'contatos'));
    const byAtend = {};
    snap.docs.forEach(x => {
      const r = x.data();
      (byAtend[r.atend] = byAtend[r.atend] || []).push(r);
    });
    const head = ['Paciente', 'Atend', 'Leito', 'Trilha', 'Tier', 'Score', 'Alerta no-show', 'Consulta (data)', 'Prestador', 'Origem do agendamento', 'Desfecho consulta', 'Contato realizado', 'Agendado', 'Motivo', 'Texto', 'Registrado em', 'Registrado por', 'Navegador atribuído'];
    const lines = [head.join(';')];
    const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
    const desf = d => { const s = statusOf(d); return s === 'ok' ? 'Compareceu' : s === 'noshow' ? 'No-show' : s === 'agend' ? 'Aguardando' : ''; };
    navegaveis().forEach(d => {
      const ag = d.agenda || {};
      const base = [d.pac, d.atend, d.leito || '', d.trilha || '', d.tier || '', d.score ?? '', d.alerta_noshow ? 'SIM' : '', ag.data ? brData(ag.data) : '', ag.prestador || '', ag.origem || '', desf(d)];
      const regs = byAtend[d.atend] || [];
      if (!regs.length && ag.data) {
        lines.push([...base, '', '', '', '', '', '', d.assignedToName || ''].map(cell).join(';'));
      }
      regs.forEach(r => {
        lines.push([...base, r.evento ? '' : r.contato || '', r.agendado || '', r.motivo || (r.evento || ''), r.texto || r.obs || '', r.dataStr || '', r.porNome || '', d.assignedToName || ''].map(cell).join(';'));
      });
    });
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'contatos_navegacao_CHN.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { alert('Erro ao exportar: ' + (e.code || e.message)); }
};

// ================================================================ EQUIPE
function renderEquipe() {
  if (state.role !== 'admin') return;
  const roles = ['admin', 'navegador', 'recepcao', 'pendente'];
  $('eq-bd').innerHTML = state.users
    .sort((a, b) => String(a.nome || a.email).localeCompare(String(b.nome || b.email)))
    .map(u => {
      const nAtr = all().filter(d => d.assignedTo === u.uid).length;
      const opts = roles.map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${ROLE_LABEL[r] || 'Pendente'}</option>`).join('');
      return `<tr>
        <td class="pac">${esc(u.nome || '—')}</td>
        <td>${esc(u.email || '')}</td>
        <td><select data-role-uid="${esc(u.uid)}" ${u.uid === state.uid ? 'disabled title="Você não pode alterar o próprio perfil"' : ''}>${opts}</select></td>
        <td style="text-align:center">${u.role === 'navegador' ? nAtr : '—'}</td>
      </tr>`;
    }).join('');
  $('eq-bd').querySelectorAll('[data-role-uid]').forEach(sel => sel.onchange = async () => {
    await updateDoc(doc(db, 'users', sel.dataset.roleUid), { role: sel.value });
  });
}

$('btn-criar-user').onclick = async () => {
  const nome = $('eq-nome').value.trim(), email = $('eq-email').value.trim(),
        senha = $('eq-senha').value, role = $('eq-role').value;
  const msg = m => { $('eq-msg').textContent = m; };
  if (!nome || !email || senha.length < 6) { msg('Preencha nome, e-mail e senha com pelo menos 6 caracteres.'); return; }
  $('btn-criar-user').disabled = true;
  msg('Criando usuário…');
  // app secundário: cria a conta sem derrubar a sessão do admin
  const sec = initializeApp(firebaseConfig, 'sec-' + Date.now());
  try {
    const cred = await createUserWithEmailAndPassword(getAuth(sec), email, senha);
    await setDoc(doc(db, 'users', cred.user.uid), { email, nome, role, criadoEm: serverTimestamp() });
    await signOut(getAuth(sec));
    msg(`Usuário ${nome} (${ROLE_LABEL[role]}) criado. Informe a senha inicial pessoalmente.`);
    $('eq-nome').value = ''; $('eq-email').value = ''; $('eq-senha').value = '';
  } catch (e) {
    msg(e.code === 'auth/email-already-in-use' ? 'Este e-mail já tem conta.' : 'Erro: ' + (e.code || e.message));
  } finally {
    await deleteApp(sec).catch(() => {});
    $('btn-criar-user').disabled = false;
  }
};

// ================================================================ COBRANÇA
let cobrancaInit = false;
function initCobranca() {
  if (cobrancaInit) return;
  cobrancaInit = true;
  const ops = COBRANCA.convenios.map(c => c.nome);
  $('cob-op').innerHTML = '<option value="">— selecione —</option>' + ops.map(o => `<option>${esc(o)}</option>`).join('');
  $('cob-esp').innerHTML = '<option value="">— selecione —</option>' + COBRANCA.especialidades.map(e2 => `<option>${esc(e2)}</option>`).join('');
  $('cob-op').onchange = onCobChange; $('cob-esp').onchange = onCobChange;

  document.querySelector('#cob-valores tbody').innerHTML = COBRANCA.guia.valores.map(v =>
    `<tr><td class="pac">${esc(v.tipo)}</td><td>${esc(v.quando)}</td><td style="font-weight:700;color:var(--navy)">${esc(v.valor)}</td></tr>`).join('');
  $('cob-exc').innerHTML = COBRANCA.guia.excecoes_subsidio.map(x => `<span class="chip">${esc(x)}</span>`).join('');
  $('cob-susp').innerHTML = COBRANCA.guia.suspensos_posalta.map(x => `<span class="chip">${esc(x)}</span>`).join('');
  $('cob-cod').innerHTML = Object.entries(COBRANCA.guia.onco_codigos).map(([k, v]) =>
    `<div class="brow"><div class="bl" style="width:auto;min-width:260px">${esc(k)}</div><div style="font-weight:700;color:var(--navy)">${esc(v)}</div></div>`).join('');
  renderFluxo();
}

function convByName(nome) { return COBRANCA.convenios.find(c => c.nome === nome) || null; }
function inLista(convNome, lista) {
  const n = norm(convNome);
  return lista.some(x => { const m = norm(x); return n.includes(m) || m.includes(n); });
}
function badge(v, simTxt, naoTxt) {
  if (v === true) return `<span class="cob-badge sim">${simTxt}</span>`;
  if (v === false) return `<span class="cob-badge nao">${naoTxt}</span>`;
  return '<span class="cob-badge info">sem informação</span>';
}

let fluxoAns = { plano: null, amb: null, hosp: null, regra: null };

function onCobChange() {
  const opNome = $('cob-op').value, esp = $('cob-esp').value;
  const conv = convByName(opNome);
  let html = '';
  let ambCobre = null;
  if (conv && esp) {
    if (ESP_ONCO_MATRIZ.includes(esp)) {
      const c = esp === 'HEMATOLOGIA' ? conv.hem_c : conv.onco_c;
      const t = esp === 'HEMATOLOGIA' ? conv.hem_t : conv.onco_t;
      ambCobre = c === true;
      html += `<div style="margin-top:12px"><b>${esc(esp)}</b> (matriz onco/hemato): Consulta ${badge(c, 'coberta', 'não coberta')} · Tratamento/Infusão ${badge(t, 'coberto', 'não coberto')}</div>`;
      if (c === false) html += `<div class="sub" style="margin-top:6px">Consulta não coberta → aplicar tabela oncológica (Particular Oncológico R$ 500,00 ou código do sistema).</div>`;
    } else {
      const mark = conv.esps ? conv.esps[esp] : undefined;
      ambCobre = !!mark;
      html += `<div style="margin-top:12px"><b>${esc(esp)}</b>: ` + (mark
        ? `<span class="cob-badge sim">ambulatório cobre${String(mark).includes('ADULTO') ? ' (somente adulto)' : ''}</span>`
        : '<span class="cob-badge nao">ambulatório NÃO cobre</span>') + '</div>';
    }
    if (inLista(opNome, COBRANCA.guia.excecoes_subsidio)) html += `<div style="margin-top:8px"><span class="cob-badge warn">&#9888; ${esc(opNome)}: NÃO dar subsídio (lista de exceções)</span></div>`;
    if (inLista(opNome, COBRANCA.guia.suspensos_posalta)) html += `<div style="margin-top:8px"><span class="cob-badge warn">&#9888; ${esc(opNome)}: plano SUSPENSO para pós-alta — falar com a Navegação</span></div>`;
  } else {
    html = '<div class="sub" style="margin-top:10px">Selecione operadora e especialidade para ver a cobertura.</div>';
  }
  $('cob-res').innerHTML = html;
  fluxoAns = { plano: conv ? 'SIM' : fluxoAns.plano, amb: ambCobre === null ? null : (ambCobre ? 'SIM' : 'NAO'), hosp: null, regra: null };
  renderFluxo();
}

function renderFluxo() {
  const a = fluxoAns;
  const step = (n, pergunta, key, opcoes, visivel) => {
    if (!visivel) return '';
    const btns = opcoes.map(([v, lb]) =>
      `<span class="fbtn${a[key] === v ? ' on' : ''}" data-fx="${key}" data-v="${v}">${lb}</span>`).join('');
    return `<div class="fstep${a[key] ? ' done' : ''}"><div class="fq">${n}. ${pergunta}</div><div class="fbtns">${btns}</div></div>`;
  };
  let resultado = '';
  const excecao = $('cob-op').value && inLista($('cob-op').value, COBRANCA.guia.excecoes_subsidio);
  if (a.plano === 'NAO') resultado = 'Particular Integral · R$ 300,00';
  else if (a.plano === 'SIM' && a.amb === 'SIM') resultado = 'Pelo plano · Sem cobrança adicional';
  else if (a.amb === 'NAO' && a.hosp === 'NAO') resultado = 'Particular Integral · R$ 300,00';
  else if (a.amb === 'NAO' && a.hosp === 'SIM' && a.regra === 'NAO') resultado = 'Condição Especial (102) · R$ 200,00';
  else if (a.amb === 'NAO' && a.hosp === 'SIM' && a.regra === 'SIM') resultado = 'Subsídio CHN · Conforme regra' + (excecao ? ' — ATENÇÃO: operadora na lista de exceções, NÃO dar subsídio!' : '');

  $('cob-fluxo').innerHTML =
    step(1, 'O paciente tem plano de saúde?', 'plano', [['SIM', 'Tem plano'], ['NAO', 'Não tem plano']], true) +
    step(2, 'O ambulatório aceita o plano para esta especialidade? (pré-respondido pela matriz acima)', 'amb', [['SIM', 'Sim'], ['NAO', 'Não']], a.plano === 'SIM') +
    step(3, 'O plano é aceito pelo HOSPITAL CHN?', 'hosp', [['SIM', 'Sim'], ['NAO', 'Não']], a.plano === 'SIM' && a.amb === 'NAO') +
    step(4, 'Encaixa em regra especial de subsídio? (cirurgia, especialidade estratégica, pós-alta, tratamento onco, Bradesco em certas áreas)', 'regra', [['SIM', 'Sim'], ['NAO', 'Não']], a.plano === 'SIM' && a.amb === 'NAO' && a.hosp === 'SIM') +
    (resultado ? `<div class="fresult${resultado.includes('R$') ? ' pay' : ''}">${esc(resultado)}</div>` : '<div class="sub" style="margin-top:8px">Responda as perguntas para chegar ao valor.</div>');

  $('cob-fluxo').querySelectorAll('[data-fx]').forEach(b => b.onclick = () => {
    fluxoAns[b.dataset.fx] = b.dataset.v;
    // limpa respostas das etapas seguintes
    const ordem = ['plano', 'amb', 'hosp', 'regra'];
    ordem.slice(ordem.indexOf(b.dataset.fx) + 1).forEach(k => { fluxoAns[k] = null; });
    renderFluxo();
  });
}
