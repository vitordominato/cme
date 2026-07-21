// Parsers dos exports do SoulMV (lidos no navegador via SheetJS/XLSX global):
//  - Censo de internação (Gerenciamento de Unidade de Internação)
//  - Altas hospitalares (Base Analítica ou export 7101 legado)
//  - Egressos do PS (relatório 6906)

const DAY = 86400000;

function clean(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.includes('img src')) return 'SIM'; // SoulMV exporta flags booleanas como <img>
  // <br> vira espaço antes de remover as demais tags: "Cód.<br>Paciente" → "Cód. Paciente"
  return s.replace(/<\/?br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function stripId(v) {
  return clean(v).replace(/\.0$/, '');
}

function sheetMatrix(wb) {
  const sh = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sh, { header: 1, raw: true, defval: '' });
}

// Localiza a linha de cabeçalho nas 10 primeiras linhas.
function findHeader(rows, pred) {
  const n = Math.min(10, rows.length);
  for (let r = 0; r < n; r++) {
    const vals = rows[r].map(v => clean(v));
    if (pred(vals)) return r;
  }
  return -1;
}

// Índice de coluna no cabeçalho: match exato primeiro (evita que "Paciente"
// case com "Cód. Paciente"), depois substring (case-insensitive).
function makeCol(hdr) {
  const low = hdr.map(h => clean(h).replace(/\n/g, ' ').toLowerCase());
  return name => {
    const q = name.toLowerCase();
    for (let i = 0; i < low.length; i++) if (low[i] === q) return i;
    for (let i = 0; i < low.length; i++) if (low[i].includes(q)) return i;
    return -1;
  };
}

// Datas: serial Excel, ISO yyyy-mm-dd ou dd/mm/yyyy (com hora opcional).
export function parseDateAny(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) {
    // serial Excel (epoch 1899-12-30)
    return new Date(Math.round((v - 25569) * DAY));
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  return null;
}

export function toISO(d) {
  if (!d || isNaN(d)) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function toBR(d) {
  if (!d || isNaN(d)) return '';
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

// ---------------------------------------------------------------- censo
export function parseCenso(wb) {
  const rows = sheetMatrix(wb);
  const h = findHeader(rows, v => v.some(x => x.includes('Atend')) && v.some(x => x.includes('Paciente')));
  if (h < 0) throw new Error('Não encontrei a linha de cabeçalho no export do censo.');
  const col = makeCol(rows[h]);
  const idx = {};
  ['Atend', 'Dt.Atend', 'Leito', 'Paciente', 'D.N.', 'Médico', 'D.I.H.', 'NEWS', 'Risco',
   'Charlson', 'Fugulin', 'Dietas', 'CCIH', 'MRC', 'CP', 'Nutrição', 'Prev. Alta']
    .forEach(k => { idx[k] = col(k); });
  const cell = (r, k) => idx[k] >= 0 ? clean(rows[r][idx[k]]) : '';

  const out = [], seen = new Set();
  for (let r = h + 1; r < rows.length; r++) {
    const atend = stripId(rows[r][idx['Atend']]);
    const pac = cell(r, 'Paciente');
    if (!atend || !pac || seen.has(atend)) continue;
    seen.add(atend);
    out.push({
      atend, dt: cell(r, 'Dt.Atend'), leito: cell(r, 'Leito'), pac,
      dn: cell(r, 'D.N.'), med: cell(r, 'Médico'), dih: cell(r, 'D.I.H.'),
      news: cell(r, 'NEWS'), risco: cell(r, 'Risco'), charlson: cell(r, 'Charlson'),
      fugulin: cell(r, 'Fugulin'), dieta: cell(r, 'Dietas'), ccih: cell(r, 'CCIH'),
      mrc: cell(r, 'MRC'), cp: cell(r, 'CP'), nutri: cell(r, 'Nutrição'),
      prev_alta: cell(r, 'Prev. Alta'),
    });
  }
  return out;
}

// ---------------------------------------------------------------- altas
// Formato "Base Analítica" (cabeçalho CD_ATENDIMENTO).
function parseAltasBaseAnalitica(rows, h) {
  const col = makeCol(rows[h]);
  const c = {
    atend: col('CD_ATENDIMENTO'), codpac: col('CD_PACIENTE'), origem: col('ORIGEM'), pac: col('PACIENTE_ABREV'),
    dtAtend: col('DT_ATENDIMENTO'), dtAlta: col('DT_ALTA_MEDICA'), hrAlta: col('HR_ALTA_MEDICA'),
    conv: col('NM_CONVENIO'), idade: col('IDADE'), sexo: col('SEXO'),
    motivo: col('MOTIVO_ALTA'), unid: col('DS_UNID_INT'),
  };
  const items = [], seen = new Set();
  let excl = 0;
  for (let r = h + 1; r < rows.length; r++) {
    const atend = stripId(rows[r][c.atend]);
    const pac = clean(rows[r][c.pac]);
    if (!atend || !pac || seen.has(atend)) continue;
    seen.add(atend);
    const origem = clean(rows[r][c.origem]);
    const unidade = clean(rows[r][c.unid]);
    if (origem.toUpperCase().includes('DAY C') || unidade.toUpperCase().includes('BERCARIO')) { excl++; continue; }
    const dAdm = parseDateAny(rows[r][c.dtAtend]);
    const dAlta = parseDateAny(rows[r][c.dtAlta]);
    const dih = (dAdm && dAlta) ? Math.round((dAlta - dAdm) / DAY) : null;
    const anos = c.idade >= 0 ? parseInt(clean(rows[r][c.idade]), 10) : NaN;
    items.push({
      atend, codpac: c.codpac >= 0 ? stripId(rows[r][c.codpac]) : '',
      pac, anos: isNaN(anos) ? null : anos, idadeStr: clean(rows[r][c.idade]),
      sexo: clean(rows[r][c.sexo]).charAt(0).toUpperCase(), convenio: clean(rows[r][c.conv]),
      cid: '', dih, origemAdm: origem, unidade, motivo: clean(rows[r][c.motivo]),
      med: '', alta: toBR(dAlta), altaISO: toISO(dAlta),
    });
  }
  return { items, excl };
}

// Formato legado 7101 (cabeçalho Atend + Paciente).
function parseAltas7101(rows, h) {
  const col = makeCol(rows[h]);
  const c = {
    atend: col('Atend'), codpac: col('Cód. Paciente'), pac: col('Paciente'),
    idade: col('Idade'), leito: col('Leito'), conv: col('Convênio'), cid: col('CID'),
    hrAtend: col('Hr. Atendimento'), alta: col('Alta Médica'), origem: col('Origem'), med: col('Médico'),
  };
  const items = [], seen = new Set();
  let excl = 0;
  for (let r = h + 1; r < rows.length; r++) {
    const atend = stripId(rows[r][c.atend]);
    const pac = clean(rows[r][c.pac]);
    if (!atend || !pac || seen.has(atend)) continue;
    seen.add(atend);
    const cid = clean(rows[r][c.cid]).toUpperCase();
    const origem = clean(rows[r][c.origem]);
    if (cid.startsWith('Z38') || cid.startsWith('O80') || origem.toUpperCase().includes('DAY C')) { excl++; continue; }
    const dAdm = parseDateAny(rows[r][c.hrAtend]);
    const dAlta = parseDateAny(rows[r][c.alta]);
    const dih = (dAdm && dAlta) ? Math.round((dAlta - dAdm) / DAY) : null;
    const idadeStr = clean(rows[r][c.idade]);
    const mIdade = /(\d+)a/.exec(idadeStr);
    items.push({
      atend, codpac: stripId(rows[r][c.codpac]), pac,
      anos: mIdade ? parseInt(mIdade[1], 10) : null, idadeStr, sexo: '',
      convenio: clean(rows[r][c.conv]), cid: clean(rows[r][c.cid]), dih,
      origemAdm: origem, unidade: clean(rows[r][c.leito]), motivo: '',
      med: clean(rows[r][c.med]), alta: toBR(dAlta), altaISO: toISO(dAlta),
    });
  }
  return { items, excl };
}

export function parseAltas(wb) {
  const rows = sheetMatrix(wb);
  const hNova = findHeader(rows, v => v.some(x => x.toUpperCase().includes('CD_ATENDIMENTO')));
  if (hNova >= 0) return parseAltasBaseAnalitica(rows, hNova);
  const h7101 = findHeader(rows, v => v.some(x => x.includes('Atend')) && v.some(x => x.includes('Paciente')));
  if (h7101 >= 0) return parseAltas7101(rows, h7101);
  throw new Error('Formato de arquivo de altas não reconhecido (esperado Base Analítica ou export 7101).');
}

// ---------------------------------------------------------------- PS 6906
function limpaMed(s) {
  return clean(s)
    .replace(/^\d+\|\|/, '')
    .replace(/Retorno em dias:\s*\d*/gi, '')
    .replace(/Local:[^;·]*/gi, '')
    .replace(/^[\s\-–·]+|[\s\-–·]+$/g, '')
    .trim();
}

export function parsePS(wb) {
  const rows = sheetMatrix(wb);
  const h = findHeader(rows, v => v.some(x => x.includes('Paciente')) && v.some(x => x.includes('Agendamento')));
  if (h < 0) throw new Error('Não encontrei o cabeçalho do relatório 6906 (Paciente + Agendamento).');
  const col = makeCol(rows[h]);
  const c = {
    codpac: col('Cód. Paciente'), atend: col('Atendimento'), pac: col('Paciente'),
    conv: col('Convênio'), esp: col('Especialidade'), ag: col('Agendamento'),
    fech: col('Data Fechamento'), c797: col('797'), int: col('Internado'), aval: col('Avaliador'),
  };
  // as duas colunas "1363" (médico assistente / encaminhamento) são capturadas por índice
  const cols1363 = [];
  rows[h].forEach((v, i) => { if (clean(v).includes('1363')) cols1363.push(i); });

  const items = [], seen = new Set();
  for (let r = h + 1; r < rows.length; r++) {
    const atend = stripId(rows[r][c.atend]);
    const pac = clean(rows[r][c.pac]);
    if (!atend || !pac || seen.has(atend)) continue;
    seen.add(atend);
    const freeCols = [c.c797, ...cols1363].filter(i => i >= 0).map(i => String(rows[r][i] == null ? '' : rows[r][i]));
    let retorno = null;
    for (const t of freeCols) {
      const m = /Retorno em dias:\s*(\d+)/i.exec(t);
      if (m) { retorno = parseInt(m[1], 10); break; }
    }
    const med = freeCols.map(limpaMed).filter(Boolean).join(' · ');
    const fech = clean(rows[r][c.fech]).split(/\s+/)[0] || '';
    items.push({
      atend, codpac: stripId(rows[r][c.codpac]), pac,
      convenio: clean(rows[r][c.conv]), esp: clean(rows[r][c.esp]),
      agfut: clean(rows[r][c.ag]).toUpperCase() === 'SIM',
      retorno, fech, medEnc: med,
      int30: clean(rows[r][c.int]).toUpperCase() === 'SIM',
      aval: clean(rows[r][c.aval]),
    });
  }
  return items;
}
