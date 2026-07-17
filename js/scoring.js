// Motor de score e classificação de trilhas — Navegação Pós-Alta CHN.
// Regra metodológica: exibir apenas dados reais auditados. Charlson, quando
// ausente, NÃO é estimado — só agrega ao score quando presente.

export const IMOBILIDADE = ['TETRAPLEGIA', 'FRAQUEZA EXTREMA'];

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : n;
}

export function idadeFromDN(dn) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(dn || '').trim());
  if (!m) return null;
  const b = new Date(+m[3], +m[2] - 1, +m[1]);
  if (isNaN(b)) return null;
  return Math.floor((Date.now() - b.getTime()) / 86400000 / 365.25);
}

// Score do censo de internação (dados completos do SoulMV).
export function scorePaciente(x) {
  let s = 0;
  const flags = [];
  const dih = num(x.dih);
  if (dih !== null) {
    if (dih >= 30)      { s += 4; flags.push('LP ' + Math.trunc(dih) + 'd'); }
    else if (dih >= 15) { s += 3; flags.push('permanencia ' + Math.trunc(dih) + 'd'); }
    else if (dih >= 8)  { s += 1; }
  }
  const f = String(x.fugulin || '').toUpperCase();
  if (f.includes('INTENSIVO') && !f.includes('SEMI')) { s += 4; flags.push('Fugulin intensivo'); }
  else if (f.includes('SEMI-INTENSIVO'))              { s += 3; flags.push('semi-intensivo'); }
  else if (f.includes('ALTA DEPEND'))                 { s += 3; flags.push('alta dependencia'); }
  else if (f.includes('INTERMED'))                    { s += 1; }

  const nu = String(x.nutri || '').toUpperCase();
  if (nu.includes('GRAVEMENTE'))        { s += 3; flags.push('desnutricao grave'); }
  else if (nu.includes('MODERADAMENTE')) { s += 1; flags.push('desnutricao moderada'); }

  const nw = num(x.news);
  if (nw !== null) {
    if (nw >= 6)      { s += 3; flags.push('NEWS ' + x.news); }
    else if (nw >= 4) { s += 2; flags.push('NEWS ' + x.news); }
  }
  if (String(x.cp || '').toUpperCase() === 'SIM')   { s += 2; flags.push('paliativos'); }
  if (String(x.ccih || '').toUpperCase() === 'SIM') { s += 2; flags.push('CCIH/infeccao'); }

  const mrc = String(x.mrc || '').toUpperCase();
  const imob = IMOBILIDADE.includes(mrc);
  if (imob)                        { s += 2; flags.push('imobilidade/fraqueza grave'); }
  else if (mrc.includes('MODERADA')) { s += 1; }

  if (x.dieta && String(x.dieta).toUpperCase().includes('EXCLU')) {
    s += 1; flags.push('nutricao enteral exclusiva');
  }
  const ch = num(x.charlson);
  if (ch !== null && ch >= 5) { s += 3; flags.push('Charlson ' + Math.trunc(ch)); }

  return { s, flags, imob };
}

export function orientacao(trilha, noshow) {
  let base;
  if (trilha === 'A') {
    base = 'Contato telefonico em 48h pos-alta: sintomas, medicacoes e duvidas. Revisao presencial em 7 dias.';
  } else if (trilha === 'B') {
    base = 'Trilha paliativa: contato conforme plano de cuidado. Foco em conforto, dor e suporte ao cuidador. Sem consulta padrao.';
  } else if (trilha === 'C') {
    base = 'Contato telefonico em ~7 dias: adesao e sinais de alarme. Revisao presencial em 14 dias.';
  } else {
    base = 'Baixo risco: orientacao de alta padrao. Sem navegacao ativa.';
  }
  if (noshow && ['A', 'B', 'C'].includes(trilha)) {
    base += ' [NO-SHOW] Imobilidade: perguntar transporte/locomocao ANTES da alta e definir modalidade (transporte, domiciliar ou teleconsulta).';
  }
  return base;
}

// Classificação completa de um paciente do censo.
export function classificarCenso(x) {
  const { s, flags, imob } = scorePaciente(x);
  const pal = String(x.cp || '').toUpperCase() === 'SIM';
  const tier = s >= 7 ? 'ALTO' : (s >= 4 ? 'MEDIO' : 'BAIXO');
  let trilha;
  if (tier === 'ALTO' && !pal) trilha = 'A';
  else if (pal)                trilha = 'B';
  else if (tier === 'MEDIO')   trilha = 'C';
  else                         trilha = '-';
  const janela = trilha === 'A' ? 7 : (trilha === 'C' ? 14 : null);
  return {
    ...x,
    idade: x.idade != null ? x.idade : idadeFromDN(x.dn),
    score: s, flags, tier, trilha, janela,
    paliativo: pal, imobilidade: imob, alerta_noshow: imob,
    orientacao: orientacao(trilha, imob),
    fonte: 'completo',
  };
}

// Score parcial para altas que não cruzam com o censo:
// DIH ≥15d +3 · 8–14d +2 · 4–7d +1; emergência +2; CID de risco; idade >50 +2.
export function scoreAlta(item) {
  let s = 0;
  const flags = [];
  const dih = num(item.dih);
  if (dih !== null) {
    if (dih >= 15)     { s += 3; flags.push('DIH ' + Math.trunc(dih) + 'd'); }
    else if (dih >= 8) { s += 2; flags.push('DIH ' + Math.trunc(dih) + 'd'); }
    else if (dih >= 4) { s += 1; }
  }
  if (String(item.origemAdm || '').toUpperCase().includes('EMERGENCIA')) {
    s += 2; flags.push('admissao via emergencia');
  }
  const cid = String(item.cid || '').toUpperCase();
  if (cid.startsWith('A41'))      { s += 3; flags.push('sepse'); }
  else if (cid.startsWith('I50')) { s += 3; flags.push('insuf. cardiaca'); }
  else if (cid.startsWith('N18')) { s += 2; flags.push('renal cronica'); }
  else if (cid.startsWith('J'))   { s += 2; flags.push('respiratorio'); }
  else if (cid.startsWith('C'))   { s += 2; flags.push('neoplasia'); }
  if (item.anos != null && item.anos > 50) { s += 2; flags.push('idade ' + item.anos + 'a'); }
  return { s, flags };
}

// Classificação de uma alta sem cruzamento com o censo (score parcial).
export function classificarAltaParcial(item) {
  const { s, flags } = scoreAlta(item);
  const tier = s >= 5 ? 'ALTO' : (s >= 3 ? 'MEDIO' : 'BAIXO');
  const trilha = tier === 'ALTO' ? 'A' : (tier === 'MEDIO' ? 'C' : '-');
  const janela = trilha === 'A' ? 7 : (trilha === 'C' ? 14 : null);
  return {
    ...item,
    score: s, flags, tier, trilha, janela,
    paliativo: false, imobilidade: false, alerta_noshow: false,
    orientacao: orientacao(trilha, false) + ' (score parcial)',
    fonte: 'parcial',
  };
}

// Flags exibidas em vermelho (críticas).
export const CRIT = ['paliativos', 'CCIH/infeccao', 'desnutricao grave', 'Fugulin intensivo', 'NEWS', 'Charlson', 'imobilidade'];

export function flagCrit(fl) {
  return CRIT.some(c => fl.includes(c));
}

export const FAIXAS = ['0–17', '18–49', '50–64', '65–79', '80+', 'sem idade'];

export function faixaEtaria(anos) {
  if (anos == null || isNaN(anos)) return 'sem idade';
  if (anos <= 17) return '0–17';
  if (anos <= 49) return '18–49';
  if (anos <= 64) return '50–64';
  if (anos <= 79) return '65–79';
  return '80+';
}
