# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projeto

Extensão Chrome MV3 de uso pessoal que pula anúncios do YouTube por manipulação de DOM. Sem build step, sem dependências, sem testes, sem lint, sem permissões no manifest, sem rede. Todo o código vive em `content.js`.

## Fluxo de desenvolvimento

Não há comando de build ou teste. O ciclo é manual via `chrome://extensions` (Modo do desenvolvedor → Carregar sem compactação → pasta `pula/`):

| Editou | O que fazer |
|---|---|
| `content.js` | ⟳ no card da extensão **e** F5 na aba do YouTube |
| `manifest.json` | ⟳ + F5; se o Chrome reclamar, remova e carregue de novo |
| `icons/` | ⟳ (pode precisar de hard-reload da página `chrome://extensions`) |

O ⟳ sozinho não basta: a aba do YouTube continua com a cópia antiga do content script já injetada.

Para depurar: setar `debug: true` no `CONFIG` e filtrar o console por `[Pula]`.

Os três PNGs em `icons/` são obrigatórios enquanto o `manifest.json` declarar o bloco `icons` — o Chrome recusa carregar a extensão com referência a arquivo inexistente.

## Arquitetura

**Princípio central**: fazer exatamente o que o usuário faria com o mouse (clicar em skip, fechar overlay). Nada de `webRequest`, `declarativeNetRequest` ou bloqueio de host — a página carrega o anúncio normalmente, então o detector anti-adblock do YouTube não tem sinal para disparar. Qualquer mudança que introduza bloqueio de rede quebra esse princípio.

**ISOLATED world**: o content script roda no world padrão do MV3, onde a API interna do player (`#movie_player.mute()`, `.getPlayerState()`) **não** está acessível — esses métodos só existem no MAIN world. Por isso o mute é feito em `<video>.muted` direto. O trade-off e a alternativa (`"world": "MAIN"`) estão documentados no bloco NOTA ao final do `content.js`.

**Loop de detecção**: tudo converge para `tick()`, que é idempotente e barato. Ele é agendado por `scheduleTick()`, que coalesce mutações num único `queueMicrotask` — microtask de propósito, porque `rAF` congela em aba de fundo e timers são estrangulados pelo Chrome.

Três fontes disparam `scheduleTick()`:
1. `MutationObserver` em `document.documentElement` (mecanismo principal; `documentElement` porque `<body>` ainda não existe em `document_start`, e `attributeFilter: ['class']` é o que pega a transição `.ad-showing`)
2. Eventos de navegação SPA do polymer (`yt-navigate-finish` e afins) e eventos de mídia do `<video>` — estes com `capture: true`, pois eventos de mídia não borbulham
3. `setInterval` de rede de segurança (`CONFIG.safetyNetIntervalMs`)

**Estado**: o objeto `state` guarda a transição de anúncio (`adActive`), a posse do mute (`mutedByUs`), o `<video>` observado (reanexado quando o YouTube troca o elemento) e o `playbackRate` original. Duas invariantes importam:
- Só restauramos áudio/velocidade se fomos nós que alteramos. `onVolumeChange` cede o controle assim que o usuário mexe no volume durante o anúncio.
- `selfVolumeChangeUntil` é uma janela temporal (100ms), não um booleano, porque `volumechange` dispara em task separada e um flag síncrono não sobreviveria.

**Ordem no tick durante anúncio**: tenta o skip primeiro (instantâneo e mais limpo); só se falhar é que `fastForwardAd()` joga o playhead para o fim, com aceleração de playback como plano B se o seek for rejeitado.

## Onde mexer

Os primeiros ~130 linhas do `content.js` concentram tudo que muda com frequência:

- `CONFIG` — flags booleanas independentes por comportamento
- `SKIP_BUTTON_SELECTORS` — a lista que quebra quando o YouTube renomeia classes; ordem importa (o primeiro que casar e estiver clicável vence). Para descobrir o seletor novo: durante um anúncio, inspecionar o botão, copiar a classe, adicionar no topo do array
- `OVERLAY_HIDE_SELECTORS` / `FEED_HIDE_SELECTORS` — o que some via CSS injetado

Toda query de seletor passa por `try/catch` (`queryFirst`, `clickSkipButton`) porque seletores modernos como `:has()` lançam em Chrome antigo, e um seletor ruim não pode derrubar o loop inteiro. Manter esse padrão ao adicionar seletores.

`isClickable()` existe porque o botão de skip está no DOM durante a contagem regressiva ("Pular em 5s") mas oculto — clicar nessa hora é no-op.

## Convenções

Código e comentários em português. Comentários explicam o *porquê* (por que microtask, por que `documentElement`, por que janela temporal), não o *o quê* — seguir esse padrão.
