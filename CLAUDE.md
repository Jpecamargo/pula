# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projeto

Extensão Chrome MV3 de uso pessoal que pula anúncios por manipulação de DOM em
vários streamings. Sem build step, sem dependências, sem testes, sem lint, sem
rede.

`core.js` é o motor genérico; `adapters/<site>.js` é um arquivo por streaming;
`popup.html`/`popup.js` são a UI de toggles e contador; `_locales/` guarda as
traduções (pt-BR e en).

`storage` é a única permissão do manifest, e existe só por causa do popup. Nada
de `webRequest`, `declarativeNetRequest` ou host permissions.

## Fluxo de desenvolvimento

Não há comando de build ou teste. O ciclo é manual via `chrome://extensions`
(Modo do desenvolvedor → Carregar sem compactação → pasta `pula/`):

| Editou | O que fazer |
|---|---|
| `core.js` / `adapters/*.js` | ⟳ no card da extensão **e** F5 na aba do streaming |
| `popup.html` / `popup.js` | Fechar e reabrir o popup (⟳ só se não pegar) |
| `manifest.json` / `_locales/` | ⟳ + F5; se o Chrome reclamar, remova e carregue de novo |
| `icons/` | ⟳ (pode precisar de hard-reload da página `chrome://extensions`) |

O ⟳ sozinho não basta: a aba continua com a cópia antiga do content script já
injetada.

Para depurar: ligar o toggle de logs no popup e filtrar o console por `[Pula:`.
O prefixo inclui o id do adapter (`[Pula:netflix]`), então dá pra saber qual
streaming está falando.

Sanidade rápida antes de commitar (não existe suíte de testes):

```
node --check core.js && for f in adapters/*.js; do node --check "$f" || break; done
node -e "JSON.parse(require('fs').readFileSync('manifest.json'))"
node -e "JSON.parse(require('fs').readFileSync('_locales/en/messages.json'))"
```

Os três PNGs em `icons/` são obrigatórios enquanto o `manifest.json` declarar o
bloco `icons` — o Chrome recusa carregar a extensão com referência a arquivo
inexistente. Vale o mesmo para `_locales`: com `default_locale` declarado, um
`__MSG_chave__` sem entrada no locale padrão impede a extensão inteira de
carregar.

## Arquitetura

**Princípio central**: fazer exatamente o que o usuário faria com o mouse
(clicar em skip, fechar overlay, mutar). Nada de `webRequest`,
`declarativeNetRequest` ou bloqueio de host — a página carrega o anúncio
normalmente, então o detector anti-adblock do site não tem sinal para disparar.
Qualquer mudança que introduza bloqueio ou interceptação de rede quebra esse
princípio. Isso vale especialmente para a Twitch, onde quase toda solução
conhecida passa por interceptar o manifesto HLS — o adapter de lá deliberadamente
não faz isso e só muta/esconde.

**core.js + adapters**: o adapter do site é injetado **antes** do `core.js` (ver
a ordem do `js` em cada entrada de `content_scripts`) e se anuncia atribuindo
`globalThis.__PULA_ADAPTER__`. Cada entrada do manifest casa um site e injeta só
o adapter dele. Sem adapter, o core não faz nada — é o que garante que uma
entrada errada no manifest falhe em silêncio em vez de quebrar a página.

O contrato completo (campos do objeto, helpers de `ctx`, chaves de `supports`)
está em **`adapters/README.md`**. Ler antes de mexer em qualquer adapter.

**O que é do core**: loop de detecção, clique no botão de skip, fallback por
texto, mute com posse, fast-forward, injeção de CSS, estatísticas, config
persistida, aviso de stall. **O que é do adapter**: seletores, `isAdShowing`, e
comportamento específico do site (diálogos, capítulos, pular abertura).

**YouTube é a exceção, não a regra**: lá o anúncio é um `<video>` **separado**,
com duração própria e classe `.ad-showing` no player — por isso dá pra clicar em
"Pular anúncio" e jogar o playhead pro fim. Nos outros streamings o anúncio é
**SSAI**, costurado no mesmo stream do conteúdo: não existe elemento de anúncio,
não existe botão de pular, e o player reverte `currentTime`. Lá os adapters
declaram `supports.clickSkipButton: false` / `supports.fastForwardUnskippable:
false` e o ganho real é mutar, esconder overlay e pular abertura/recap/próximo
episódio. Não aceitar adapter que prometa skip onde não existe skip.

**ISOLATED world**: o content script roda no world padrão do MV3, onde a API
interna dos players (`#movie_player.mute()`, `.getPlayerState()`) **não** está
acessível — esses métodos só existem no MAIN world. Por isso o mute é feito em
`<video>.muted` direto. O trade-off e a alternativa (`"world": "MAIN"`) estão
documentados no bloco NOTA ao final do `core.js`.

**Loop de detecção**: tudo converge para `tick()`, que é idempotente e barato.
Ele é agendado por `scheduleTick()`, que coalesce mutações num único
`queueMicrotask` — microtask de propósito, porque `rAF` congela em aba de fundo
e timers são estrangulados pelo Chrome.

Três fontes disparam `scheduleTick()`:
1. `MutationObserver` em `document.documentElement` (mecanismo principal;
   `documentElement` porque `<body>` ainda não existe em `document_start`, e
   `attributeFilter` em `class`/`data-uia` é o que pega as transições de anúncio)
2. Eventos de navegação SPA (`popstate` + os que o adapter declarar em
   `navigationEvents`) e eventos de mídia do `<video>` — estes com
   `capture: true`, pois eventos de mídia não borbulham
3. `setInterval` de rede de segurança (`CONFIG.safetyNetIntervalMs`)

**Estado**: o objeto `state` guarda a transição de anúncio (`adActive`), a posse
do mute (`mutedByUs`), o `<video>` observado (reanexado quando o site troca o
elemento) e o `playbackRate` original. `adapterState` é um bag livre e exclusivo
do adapter — o core nunca lê de lá, o que evita colisão de chave entre adapters.
Duas invariantes importam:
- Só restauramos áudio/velocidade se fomos nós que alteramos. `onVolumeChange`
  cede o controle assim que o usuário mexe no volume durante o anúncio.
- `selfVolumeChangeUntil` é uma janela temporal (100ms), não um booleano, porque
  `volumechange` dispara em task separada e um flag síncrono não sobreviveria.

**Ordem no tick durante anúncio**: o `onAdTick` do adapter tem a primeira
palavra (alguns sites têm caminho próprio que o pipeline genérico não alcança);
retornar `true` encerra o assunto. Senão, tenta o skip (instantâneo e mais
limpo) e só se falhar é que `fastForwardAd()` joga o playhead para o fim, com
aceleração de playback como plano B se o seek for rejeitado. O ramo de anúncio
faz `return` — o `onTick` do adapter só roda fora de anúncio.

**Quem chama `countAd()`**: cada caminho de skip contabiliza o que ele mesmo
economizou, porque o valor depende do caminho — no clique e no seek o anúncio
inteiro é cortado, na aceleração ele ainda toca (economia é
`remaining * (1 - 1/fastForwardFallbackRate)`). O pré-roll do YouTube costuma
**rejeitar o seek**, então esquecer de contar o ramo da aceleração deixa o
contador zerado mesmo com o anúncio sumindo da tela. `remaining` é medido no
`tick()` antes de qualquer ação e passado adiante: depois do seek/clique o
`currentTime` já é o do vídeo real. `state.adCounted` garante uma contagem por
anúncio, então chamadas repetidas a cada tick são inofensivas.

**Resiliência a renomeação de classe** (o modo mais comum da extensão quebrar):
- O fallback por texto (`clickByText`) é o último item do pipeline de skip —
  varre `button`/`[role=button]` **dentro** dos `skipFallbackRoots` do adapter e
  escolhe por texto. Os roots são só containers de anúncio de propósito: varrer o
  player inteiro pegaria botões da barra de controle.
- `warnStalledAd()` dispara `console.warn` (não gated por `debug`) quando o
  anúncio passa de `CONFIG.stallWarnMs` sem que nada resolva, com dump dos
  candidatos a botão. É o alarme de manutenção — uma vez por anúncio. Nos
  streamings com login esse dump é a **única** forma prática de descobrir o
  seletor certo, já que não dá pra inspecionar o player de fora.

**Guarda de diálogo**: onde um adapter confirma diálogo sozinho ("continuar
assistindo", "ainda está aí?"), ele só clica depois de bater o texto por regex,
porque o botão de confirmação costuma ser compartilhado com diálogos destrutivos.
Nunca remover essa guarda. O `WeakSet` `handledDialogs` (compartilhado via `ctx`)
evita reclique em loop.

**Config e storage**: os valores em `CONFIG` (core) são os padrões globais; o
adapter sobrescreve o que não faz sentido no site dele via `configDefaults`, e
`chrome.storage.local.config` sobrescreve chaves conhecidas do mesmo tipo
(`applyStoredConfig`). `sites` é o único objeto do CONFIG e é mesclado em vez de
comparado por valor — é onde mora o liga/desliga por streaming, indexado por
`adapter.id`. **Gotcha**: editar `CONFIG` no arquivo não tem efeito se o popup já
gravou aquela chave. `chrome.storage.onChanged` aplica ao vivo e chama
`refreshCss()`, porque o CSS já foi injetado em `document_start`.

**`can(key)` em vez de `CONFIG[key]`**: `can()` combina o toggle do popup com o
`supports` do adapter. Ler `CONFIG` direto ignora o que o site declarou como
impossível — usar sempre `can()` dentro de core e adapters.

**Estatísticas**: `bumpStat()` acumula e grava em lote a cada 1s com
read-modify-write, não com total em memória, porque várias abas (e agora vários
sites) contam ao mesmo tempo. Todo acesso a `chrome.storage` é try/catch — o
contexto da extensão é invalidado ao recarregar o pacote com abas abertas.

**i18n**: `popup.js` resolve texto por `t(chave, fallback)` sobre
`chrome.i18n.getMessage`, e `popup.html` marca os estáticos com `data-i18n`. Sem
tradução carregada vale o fallback em português embutido no código, então uma
chave faltando falha em silêncio na UI — mas um `__MSG_` faltando no
`default_locale` derruba a extensão inteira.

## Onde mexer

- **Novo streaming**: criar `adapters/<id>.js` seguindo `adapters/README.md`,
  adicionar a entrada em `content_scripts` no `manifest.json` (adapter antes do
  `core.js`), e incluir o `id` no array `SITES` do `popup.js`. Os três precisam
  usar o mesmo `id`, senão o toggle grava numa chave que ninguém lê.
- **Seletor quebrado**: o topo de `adapters/<id>.js` concentra as listas. Para
  descobrir o seletor novo: durante um anúncio, ler o dump do `console.warn` de
  stall, ou inspecionar o botão e adicionar a classe no topo de
  `skipButtonSelectors`. Ordem importa (o primeiro que casar e estiver clicável
  vence).
- **Nova flag de comportamento**: adicionar em `CONFIG` no `core.js` e em
  `OPTIONS` no `popup.js`, mais as chaves nos dois `_locales/*/messages.json`.

Toda query de seletor passa por `try/catch` (`queryFirst`, `queryAll`,
`clickFirst`) porque seletores modernos como `:has()` lançam em Chrome antigo, e
um seletor ruim não pode derrubar o loop inteiro. Manter esse padrão ao
adicionar seletores.

`isClickable()` existe porque o botão de skip está no DOM durante a contagem
regressiva ("Pular em 5s") mas oculto — clicar nessa hora é no-op.

## Versionamento e commits

Toda mudança entregue termina em commit, sempre precedido de bump do campo
`version` no `manifest.json` — é ele que o Chrome usa para saber que a extensão
mudou, e sem bump fica impossível dizer qual build está carregada no navegador.

- patch (`1.1.0` → `1.1.1`): correção de seletor, ajuste de comportamento
  existente, docs
- minor (`1.1.0` → `1.2.0`): novo comportamento, nova flag no `CONFIG`/popup,
  novo adapter
- major: mudança que quebra a config já gravada em `chrome.storage`

Commit em português, no imperativo, seguindo o histórico (`Adiciona…`,
`Corrige…`). Bump e mudança vão no mesmo commit.

## Convenções

Código e comentários em português — inclusive nos adapters. A UI é traduzida via
`_locales`, o código não. Comentários explicam o *porquê* (por que microtask, por
que `documentElement`, por que janela temporal, por que este seletor e não
aquele), não o *o quê* — seguir esse padrão.
