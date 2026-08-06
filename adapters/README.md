# Contrato dos adapters

Um arquivo por streaming. O adapter é injetado **antes** do `core.js` (ver ordem
do `js` em cada entrada de `content_scripts` no `manifest.json`) e se anuncia
atribuindo `globalThis.__PULA_ADAPTER__`. O core lê esse objeto e conduz o loop.

Um adapter **não** importa nada, **não** faz rede e **não** mexe em nenhum outro
arquivo. Se o objeto não tiver `isAdShowing`, o core ignora a página inteira em
silêncio — é o que faz uma entrada errada no manifest não quebrar o site.

## O objeto

```js
globalThis.__PULA_ADAPTER__ = {
  id: 'netflix',              // igual ao id no SITES do popup.js e ao nome do arquivo
  label: 'Netflix',

  playerSelectors: [],        // container do player
  videoSelectors: [],         // o <video> principal (o core cai em `video` genérico)
  skipButtonSelectors: [],    // ordem importa: o primeiro clicável vence
  skipFallbackRoots: [],      // onde varrer por texto quando nenhum seletor casa
  overlayHideSelectors: [],   // some via CSS se hideAdOverlays
  feedHideSelectors: [],      // some via CSS se hideFeedAds

  skipTextRe: /pular|skip/i,  // opcional; sobrescreve o padrão pt/en/es do core
  navigationEvents: [],       // opcional; eventos de SPA escutados no document
  configDefaults: {},         // opcional; sobrescreve os padrões do CONFIG
  supports: {},               // `false` no que é IMPOSSÍVEL neste site

  isAdShowing(ctx) {},                        // OBRIGATÓRIO → boolean
  onAdTick(ctx, { video, remaining }) {},     // opcional; `true` = eu resolvi, não insista
  onTick(ctx, video) {},                      // opcional; roda FORA de anúncio
  onAdStart(ctx, video) {},                   // opcional
  onAdEnd(ctx, video) {},                     // opcional
  onNavigate(ctx) {},                         // opcional; limpe cache de estado aqui
  extraCss(CONFIG) {},                        // opcional → string de CSS
};
```

## `ctx` — a única superfície disponível

`CONFIG`, `can(key)`, `state`, `adapterState`, `handledDialogs`, `log`,
`queryFirst(sels, root)`, `queryAll(sels, root)`, `clickFirst(sels, root)`,
`clickByText(roots, regex)`, `isClickable(el)`, `clickTargetFor(el)`,
`describe(el)`, `getPlayer()`, `getVideo()`, `remainingSeconds(video)`,
`bumpStat(key, n)`, `countAd(remaining)`.

- `can('x')` já combina o toggle do popup com o `supports` — use sempre ele, nunca
  `CONFIG.x` direto.
- `adapterState` é um objeto livre e exclusivo do adapter. Guarde cache aí; o core
  nunca lê de lá.
- `handledDialogs` é um `WeakSet` compartilhado: marque um diálogo antes de clicar
  nele pra não entrar em loop de reclique.

## Chaves de `supports`

`clickSkipButton`, `fastForwardUnskippable`, `muteDuringAds`,
`restoreAudioAfterAd`, `hideAdOverlays`, `hideFeedAds`, `skipIntros`,
`skipContinueWatching`, `dismissAdblockDialog`, `skipSponsorChapters`.

Ausente = suportado. Declare `false` só no que é **impossível** naquele site, não
no que é apenas indesejado — o que é indesejado o usuário desliga no popup.

## SSAI: o que dá e o que não dá

O YouTube é a exceção: lá o anúncio é um `<video>` **separado**, com duração
própria, e por isso dá pra clicar em "Pular anúncio" e jogar o playhead pro fim.

Quase todo o resto usa **SSAI** — o anúncio vem costurado no mesmo stream do
conteúdo. Não existe elemento de anúncio, não existe botão de pular, e `currentTime`
é revertido pelo player se você tentar avançar. Nesses casos:

- `supports.clickSkipButton: false`, `supports.fastForwardUnskippable: false`
- o que **funciona** é mutar durante o bloco, esconder o overlay/contador e clicar
  em "Pular abertura" / "Pular recapitulação" / "Próximo episódio"
- `isAdShowing` costuma se apoiar no marcador de anúncio da UI (contador, badge,
  container próprio), não em estado do `<video>`

Não invente um caminho que não existe: um adapter honesto que só muta e esconde
vale mais que um que promete skip e trava num loop de clique.

## Manutenção

Não dá pra verificar de fora o DOM de player que exige login. Por isso o alarme de
stall do core (`console.warn` depois de `stallWarnMs`, com dump dos botões
candidatos dentro de `skipFallbackRoots` + `playerSelectors`) é a ferramenta real:
durante um anúncio travado, o console lista os botões que existem e o seletor
certo sai dali pro topo de `skipButtonSelectors`.

Todo acesso a seletor passa por `queryFirst`/`queryAll`/`clickFirst`, que já
tratam `try/catch` — seletores modernos como `:has()` lançam em Chrome antigo, e
um seletor ruim não pode derrubar o loop inteiro.

## Convenções

Código e comentários em português. Comentários explicam o **porquê** (por que
este seletor, por que esta guarda), não o **o quê**.
