# Navegação Pós-Alta · CHN

App web multiusuário para a navegação de pacientes pós-alta (pronto-socorro e unidade de internação) do Complexo Hospitalar de Niterói. A recepção e os navegadores do centro médico analisam as altas, contatam os pacientes e agendam consultas no CME. Os dados são compartilhados em tempo real via **Firebase** (Auth + Firestore) e o site é publicado no **Netlify** direto deste repositório GitHub — sem etapa de build.

## Perfis de acesso

| Perfil | Acesso |
|---|---|
| **Administrador** | Todas as abas, incluindo o **Dashboard** (com performance por navegador), a aba **Equipe** e o botão de **distribuição de pacientes** entre os navegadores. |
| **Navegador** | Todas as abas **exceto** Dashboard e Equipe. Trabalha a fila de pacientes atribuídos a ele (chip "Meus pacientes"). |
| **Recepção** | Somente a aba **Cobrança · Recepção**. |

## Funcionalidades

- **Altas do Dia** — importa o arquivo de altas hospitalares (Base Analítica ou export 7101) e o censo SoulMV; cruza alta × censo para score completo, ou aplica o score parcial (DIH, emergência, CID de risco, idade). Exclusões automáticas: berçário, day clinic, Z38, O80.
- **Altas PS** — importa o relatório 6906 (egressos do PS); fila prioritária = sem agendamento futuro.
- **Distribuição** — o administrador seleciona pacientes (checkbox) e clica em "Distribuir selecionados entre os navegadores": divisão igualitária, ordenada por score (o risco também é distribuído por igual), começando pelo navegador com menor fila ativa.
- **Registro de contato** — modal com o fluxo Contato → Agendado → Motivo → Agenda; histórico completo por paciente com autor e data.
- **Acompanhamento** — consultas agendadas com desfecho (Compareceu / No-show / Aguardando) e exportação CSV de todos os contatos.
- **Dashboard (admin)** — KPIs por trilha (A/B/C), funil de navegação, performance por navegador, motivos de não agendamento, comparecimento e desfechos por segmento (operadora / faixa etária / sexo).
- **Cobrança · Recepção** — matriz de cobertura por operadora × especialidade (47 convênios, 99 especialidades), fluxo de decisão do valor, tabela de valores, exceções de subsídio, planos suspensos pós-alta e códigos oncológicos.

## Como colocar no ar

### 1. Firebase (console.firebase.google.com)

1. Crie um projeto (ex.: `navegacao-chn`). Google Analytics é opcional.
2. **Authentication → Sign-in method → E-mail/senha → Ativar.**
3. **Firestore Database → Criar banco de dados** (modo produção, região `southamerica-east1`).
4. Em **Firestore → Regras**, cole o conteúdo de [`firestore.rules`](firestore.rules) e publique.
5. Em **Configurações do projeto → Geral → Seus apps → ícone Web (`</>`)**, registre um app e copie o objeto `firebaseConfig`.
6. Cole os valores em [`js/firebase-config.js`](js/firebase-config.js) e faça commit.

### 2. Primeiro administrador (uma única vez)

1. Em **Authentication → Users → Adicionar usuário**, crie seu e-mail e senha.
2. Entre no site uma vez (ficará como "acesso pendente") — isso cria o documento do seu usuário.
3. Em **Firestore → coleção `users`**, abra o documento criado e mude o campo `role` para `admin`.
4. Recarregue o site: agora você vê todas as abas. Os demais usuários (navegadores e recepção) você cria pela aba **Equipe** do próprio app.

### 3. Netlify

1. Em [app.netlify.com](https://app.netlify.com): **Add new site → Import an existing project → GitHub** e escolha este repositório.
2. Build command: *(vazio)* · Publish directory: `.` (o `netlify.toml` já configura).
3. Publique. Depois, no Firebase, em **Authentication → Settings → Authorized domains**, adicione o domínio do Netlify (ex.: `seusite.netlify.app`).

## Metodologia de score (inalterada em relação ao protótipo)

- **Censo (score completo):** DIH (≥30d +4 · 15–29d +3 · 8–14d +1), Fugulin (intensivo +4 · semi-intensivo/alta dependência +3 · intermediário +1), desnutrição (grave +3 · moderada +1), NEWS (≥6 +3 · 4–5 +2), cuidados paliativos +2, CCIH +2, MRC (tetraplegia/fraqueza extrema +2, com alerta de no-show · moderada +1), dieta enteral exclusiva +1, Charlson ≥5 +3 (nunca estimado quando ausente).
- **Trilhas:** ALTO ≥7 · MÉDIO ≥4. Trilha **A** (alto risco, revisão em 7d), **B** (paliativo, plano de cuidado), **C** (médio, revisão em 14d).
- **Score parcial de alta** (sem cruzamento com o censo): DIH ≥15d +3 · 8–14d +2 · 4–7d +1; admissão via emergência +2; CID de risco (A41 sepse +3 · I50 IC +3 · N18 DRC +2 · J* respiratório +2 · C* neoplasia +2); idade >50 +2. Alto ≥5 · Médio 3–4.

## Estrutura

```
index.html            Interface (login + abas por perfil + modal de contato)
css/style.css         Estilos
js/main.js            App: auth, Firestore em tempo real, abas, distribuição, CSV
js/scoring.js         Motor de score e trilhas (censo + score parcial de alta)
js/parsers.js         Parsers dos exports SoulMV (censo, altas, PS 6906) via SheetJS
js/cobranca-data.js   Matriz de convênios × especialidades + guia de valores
js/firebase-config.js Chaves do projeto Firebase (preencher)
firestore.rules       Regras de segurança por perfil
netlify.toml          Publicação estática
```

## Modelo de dados (Firestore)

- `users/{uid}` — `{ email, nome, role: admin|navegador|recepcao|pendente }`
- `pacientes/{atend}` — dados clínicos importados + `score/trilha/tier/flags`, `origens {censo, alta, ps}`, `assignedTo/assignedToName` (navegador), `agenda {data, prestador, origem, resultado}`, contadores denormalizados (`nContatos`, `contatoSim`, `motivosCount`).
- `pacientes/{atend}/contatos/{id}` — cada registro de contato/desfecho, com autor (`porNome`) e data.

> **LGPD:** os dados de pacientes ficam apenas no Firestore do projeto (nunca neste repositório). Restrinja o acesso ao console do Firebase e crie contas nominais para auditoria pelo histórico de contatos.
