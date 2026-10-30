<h1 align="center">MemRelay</h1>

<p align="center">
  <a href="README-en.md">English</a> ·
  <a href="README-de.md">Deutsch</a> ·
  <a href="README-es.md">Español</a> ·
  <a href="README-fr.md">Français</a> ·
  <a href="README-ja.md">日本語</a> ·
  <a href="README-ko.md">한국어</a> ·
  <a href="README-fa.md">فارسی</a> ·
  <strong>Português</strong> ·
  <a href="README-id.md">Bahasa Indonesia</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README-zh-Hant.md">繁體中文</a>
</p>

<p align="center">
  <strong>Revezamento de tarefas entre ferramentas de IA para código.</strong><br>
  Ficou na metade no Codex e a cota acabou? Troque para o Claude Code e diga simplesmente
  «continue a tarefa XX» — ele segue de onde você parou,
  sem você reexplicar requisitos ou progresso.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.15-339933?logo=nodedotjs&logoColor=white" alt="Node >= 22.15">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue" alt="macOS | Linux | Windows">
</p>

<p align="center">
  <a href="#instalação">Instalação</a> ·
  <a href="#início-rápido">Início rápido</a> ·
  <a href="#destaques">Destaques</a> ·
  <a href="#comandos">Comandos</a> ·
  <a href="#fontes-compatíveis">Fontes compatíveis</a> ·
  <a href="#limites-conhecidos">Limites conhecidos</a> ·
  <a href="#interface-web">Interface web</a> ·
  <a href="#desenvolvimento">Desenvolvimento</a>
</p>

## Por que o MemRelay

Trocar de ferramenta de IA não deveria custar o progresso.

Você está na metade no Codex quando a cota acaba. Quer continuar no Claude Code, mas ele não faz ideia do que acabou de acontecer. Então você reexplica os requisitos, redescreve o progresso — ou simplesmente desiste.

O MemRelay lê os registros de sessão que cada ferramenta mantém na sua máquina e, quando você diz «continue», destila o conteúdo de passagem na hora. **A ferramenta anterior não precisa fazer nada: sem documento de passagem, sem copiar e colar.**

## Destaques

- **Zero cooperação do agente anterior** — não exige nada da ferramenta anterior; lê o registro de sessão local e destila progresso, pendências e próximos passos.
- **Configure uma vez e fale normalmente** — após `memrelay setup` você nunca precisa mencionar o memrelay; em ferramentas com Skill ou dica de inicialização, «continue a tarefa XX» é acionado automaticamente.
- **O progresso acompanha** — com seu consentimento, ele se instala nos hooks das ferramentas; o progresso chega ao índice local em quase tempo real e a próxima ferramenta continua na hora.
- **Principais ferramentas cobertas** — lê sessões do Claude Code, Qoder, Codex, Cursor, CodeBuddy, WorkBuddy, OpenCode, ZCode, Trae e DeepSeek Harness (Trae e CodeBuddy nos formatos CLI e IDE).
- **Sem LLM** — a passagem é destilada localmente por regras; offline por padrão e sem chave de API; a busca semântica vetorial, os resumos de sessão e a organização de preferências são melhorias opcionais opt-in (veja abaixo).
- **Local primeiro e reversível** — os dados ficam em `~/.memrelay/`, sem telemetria; as outras ferramentas são somente leitura e toda gravação é registrada em um manifesto e pode ser desfeita.

## Instalação

Requer Node.js ≥ 22.15 (nvm / fnm / volta / mise funcionam — o lançador encontra um Node válido sozinho):

```bash
npm i -g memrelay    # instalação global com pnpm / yarn / bun também funciona
memrelay setup
```

O `setup` vai: **detectar** quais ferramentas estão instaladas → **listar** os arquivos que serão gravados (dicas de inicialização + indexação em tempo real) → **confirmar uma vez** → gravar → autotestar em cada terminal.

> [!NOTE]
> Quer testar sem deixar rastro? `memrelay setup --undo` desfaz tudo o que foi gravado (dados mantidos); adicione `--purge` para apagar também os dados.

## Início rápido

```bash
npm i -g memrelay && memrelay setup
```

Depois abra um projeto «deixado pela metade com outra ferramenta» e diga, em uma ferramenta integrada com Skill ou dica de inicialização:

> continue a tarefa XX

O agente executa `memrelay resume` automaticamente, recebe a passagem (qual ferramenta, onde parou, o que vem a seguir) e continua.

## Comandos

Executados automaticamente pelo agente (somente leitura, somente impressão):

| Comando | O que faz |
|---|---|
| `memrelay resume "palavra-chave"` | Encontra a tarefa interrompida e imprime a passagem; cadeias de revezamento entre ferramentas são incluídas |
| `memrelay resume` | Sem palavra-chave: pega a tarefa interrompida mais recente do projeto atual |
| `memrelay resume <id da sessão>` | Continua exatamente essa sessão após escolhê-la no menu; a saída leva o marcador de revezamento para a nova sessão entrar na cadeia |
| `memrelay search "palavra-chave"` | Busca nas sessões do projeto atual (texto CJK é pesquisável) |
| `memrelay show <id da sessão> --from N` | Folheia os registros brutos de uma sessão |

Executados por você:

| Comando | O que faz |
|---|---|
| `memrelay doctor` | Autoverificação + criação/atualização incremental do índice de sessões (`~/.memrelay/memrelay.db`) |
| `memrelay ui` | Interface web local (veja abaixo) |
| `memrelay embed [--status]` | Preenchimento vetorial: embute o texto e grava no armazenamento local (ative antes a busca semântica nos Ajustes); `--status` mostra o progresso |
| `memrelay summarize [--status]` | Resumos de sessão: comprime o final de cada sessão em um resumo de progresso de 2–4 frases pelo endpoint de resumo; `--status` mostra o progresso |
| `memrelay tidy [--status\|--apply\|--undo]` | Organização de preferências entre ferramentas: importa a memória/regras globais de cada ferramenta, mescla e grava um bloco marcador do MemRelay |
| `memrelay setup --undo` | Desfaz a integração (dados mantidos); adicione `--purge` para apagar os dados também |

## Fontes compatíveis

As sessões são lidas diretamente — a ferramenta de origem não precisa fazer nada:

| Ferramenta | Onde ficam suas sessões |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` |
| Qoder | `~/.qoder/projects/<encoded-path>/*.jsonl` (inclui o formato transcript do IDE) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` (metadados de `state_*.sqlite` somente leitura) |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` (KV em texto puro, somente leitura) |
| CodeBuddy | CLI: `~/.codebuddy/projects/…/*.jsonl`; IDE: `%LOCALAPPDATA%/CodeBuddyExtension/Data/…/CodeBuddyIDE/…/history/<md5 do workspace>/<sessão>` (um JSON por mensagem) |
| WorkBuddy | `~/.workbuddy/projects/…/*.jsonl` + metadados do `workbuddy.db` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| ZCode | `~/.zcode/cli/db/db.sqlite` |
| Trae / Trae CN | A CLI usa um formato compatível com Codex; o armazenamento de sessões do IDE é criptografado e reconstruído a partir de eventos de hook |
| DeepSeek Harness | `~/.dsh/sessions/<encoded-project-dir>/session-<id>/session.v4.jsonl.zstd` (zstd multiframe, somente leitura) |

> [!NOTE]
> Os caminhos seguem o diretório de dados padrão de cada plataforma: as linhas Cursor / CodeBuddy acima são caminhos do Windows; no macOS são `~/Library/Application Support/…` e no Linux `~/.config/…`. O OpenCode usa `~/.local/share/opencode` em todas as plataformas, e `~` é o diretório pessoal do usuário atual.

A integração tem duas camadas, tudo registrado em manifesto e reversível: **Skill** (ensina uma ferramenta a chamar o memrelay quando você diz «continue») é instalado nos diretórios de skills do Claude Code / Qoder / Codex / Cursor / CodeBuddy / WorkBuddy / Trae / Trae CN / DeepSeek Harness; **indexação em tempo real** (o progresso entra no índice em segundos) roda no Claude Code / Qoder / Codex / CodeBuddy / WorkBuddy / ZCode / Trae CN (o trio de hooks; a CLI e o IDE do CodeBuddy compartilham as mesmas configurações de usuário) e no OpenCode / DeepSeek Harness pelos mecanismos oficiais de plugin — o dsh usa um plugin em processo para a indexação em tempo real (evita as restrições de processo do seu sandbox) e instala ainda uma ponte oficial de compatibilidade de hooks para dicas de inicialização e compatibilidade.

## Limites conhecidos

- **A ativação automática depende de um Skill ou de uma dica de inicialização**: o OpenCode atualmente tem apenas o plugin de indexação em tempo real, sem dica de inicialização, então é preciso executar `memrelay resume` manualmente.
- **O armazenamento de sessões do IDE do Trae é criptografado**: ele só é reconstruído a partir de eventos de hook quando a indexação em tempo real está ativada; com apenas o Skill e sem indexação em tempo real, as sessões antigas não podem ser lidas.
- **Somente sessões locais**: sem sincronização entre máquinas; ferramentas não suportadas, ou sessões criptografadas sem fluxo de eventos, não podem ser lidas.

## Interface web

```bash
memrelay ui
```

Abre uma interface local que escuta apenas em `127.0.0.1` (token de uso único; os dados não saem da sua máquina). Usa a porta fixa `4823` por padrão (aleatória se estiver ocupada); tema e idioma ficam no localStorage do navegador e são restaurados na próxima execução.

- **Painel**: visão geral do status, tarefas prontas para continuar, tarefas recentes, atividade dos últimos 14 dias e distribuição por ferramenta/pasta
- **Lista de tarefas**: cadeias de revezamento entre ferramentas viram uma única tarefa; agrupadas por pasta e ordenadas pela atividade recente, com status em tempo real
- **Detalhe da tarefa**: trilho de revezamento vertical + prévia da passagem + cópia do prompt de passagem com um clique
- **Três skins**: minimalista / quadrinhos / pixel × claro / escuro / sistema; tema e idioma são lembrados
- **11 idiomas de interface**: chinês simplificado / English / chinês tradicional / 日本語 / 한국어 / Español / Français / Deutsch / فارسی / português (BR) / bahasa indonésio
- **Navegação e busca de sessões**: busca de texto completo (incluindo CJK), salto até a ocorrência destacada
- **Integrações / exclusões de privacidade / lixeira / correções manuais** (renomear, marcar como concluída, dividir e mesclar cadeias)

## Melhorias opcionais

A busca semântica, os resumos de sessão e a organização de preferências vêm desativados por padrão. Cada recurso tem suas próprias configurações de endpoint em `memrelay ui` (são independentes e podem apontar para upstreams diferentes). As chaves são mascaradas antes do envio; se a busca semântica ou os resumos falharem, voltam à destilação por regras existente; se a organização falhar, nada é gravado de volta.

- **Busca semântica**: adiciona um canal semântico, então buscar «página de login» também encontra sessões que dizem "auth page". Apenas o texto de user/assistant é embutido, e apenas `/embeddings` remotos compatíveis com OpenAI são suportados. Referência de escala: ~250 sessões ≈ 2 M de caracteres ≈ US$ 0,03. Conteúdo inalterado é ignorado por conciliação de hash; ao trocar de modelo/host, há uma reconstrução com um clique. [Design](docs/vector-search.md)
- **Resumos de sessão**: gera um resumo de progresso de 2–4 frases por sessão, exibido na saída do revezamento (`## 任务摘要（AI 生成）`), na lista e no detalhe de tarefas e na navegação de sessões. O material se limita ao título, aos sinais de status e às últimas ~20 mensagens do final da sessão (≤8 KB); raciocínio e saída de ferramentas não são enviados. ~1 M de tokens para 250 sessões. Material inalterado é ignorado; ao trocar de modelo/host, há uma reconstrução com um clique. [Design](docs/llm-summary.md)
- **Organização de preferências**: importa em modo somente leitura a memória/regras globais de cada ferramenta, mescla duplicatas e contradições e grava de volta um bloco marcador do MemRelay. Ela só toca nos blocos marcadores, faz backup antes de gravar, é reversível e exibe conflitos em vez de resolvê-los automaticamente; mudanças nas fontes são verificadas automaticamente enquanto `memrelay ui` estiver rodando. [Design](docs/tidy.md)

Manutenção: `memrelay embed` / `memrelay summarize` / `memrelay tidy` para preenchimento completo (interruptível e retomável); `memrelay ui` preenche/verifica em segundo plano enquanto roda.

## Privacidade e segurança

- Os dados ficam apenas em `~/.memrelay/` na sua máquina; sem telemetria; sem serviços de nuvem por padrão.
- Os arquivos de outras ferramentas são somente leitura; as gravações se limitam a configurações de skill/hooks e `~/.memrelay/`, todas registradas em manifesto e reversíveis.
- Chaves (chaves de API, tokens, chaves privadas, strings de conexão) são detectadas e mascaradas antes da indexação e da exibição.
- Se você ativar busca semântica, resumos de sessão ou organização de preferências, os textos/memórias correspondentes (com chaves mascaradas) são enviados aos hosts que você configurar (cada recurso tem seu próprio endpoint); os três vêm desativados por padrão.
- O servidor da interface escuta apenas em `127.0.0.1`, exige token de acesso e valida o cabeçalho Host; requisições de escrita ainda rejeitam origens cruzadas.
- Os hooks do IDE do Trae rodam no sandbox do próprio Trae e só conseguem depositar eventos brutos no `hooks_env` do Trae; chaves comuns (`sk-`, tokens do GitHub, chaves da AWS, campos `password/token`) são mascaradas primeiro dentro do sandbox, mas conteúdo fora dessas regras pode permanecer nessa cópia. Desfazer a integração remove esses arquivos. Se isso for uma preocupação, ative apenas o Skill do Trae e dispense a indexação em tempo real.

## Desenvolvimento

O repositório é um workspace pnpm: `packages/cli` é o pacote principal da CLI (o artefato publicado) e `packages/ui` é a interface web (o build é integrado em `dist/ui` da CLI).

```bash
pnpm install
pnpm typecheck     # tsc --noEmit para os dois pacotes
pnpm test          # testes unitários + de integração com vitest (os e2e são separados, veja abaixo)
pnpm build         # primeiro tsdown → packages/cli/dist/cli.mjs, depois a interface em packages/cli/dist/ui
cd packages/cli && npm link   # opcional: colocar o memrelay no PATH (equivale a npm i -g memrelay)
node packages/cli/test/e2e/bootstrap.mjs   # ponta a ponta do lançador
```

Design e planos de iteração: [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE)
