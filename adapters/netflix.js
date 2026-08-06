/**
 * Adapter: Netflix.
 *
 * O plano com anúncios usa SSAI: o anúncio vem costurado no mesmo stream do
 * episódio. Não existe <video> separado, não existe botão de pular e o player
 * reverte qualquer avanço de `currentTime` dentro do bloco. Por isso
 * `clickSkipButton` e `fastForwardUnskippable` vêm desligados em `supports` —
 * prometer skip aqui só produziria um loop de clique inútil e um contador
 * mentindo sobre tempo economizado. O que sobra, e funciona, é mutar o bloco,
 * esconder o que é DOM (contador, cartão de anúncio na pausa) e clicar em
 * "Pular abertura" / "Pular recapitulação" / "Próximo episódio".
 *
 * Preferimos `data-uia` a classe em todo seletor: as classes do Netflix são
 * hashes do emotion (`.default-ltr-cache-mmvz9h`) e mudam a cada deploy.
 *
 * O player exige login, então NADA aqui foi verificado no DOM real. A divisão
 * honesta, pra quem for manter:
 *
 * CONFIRMADO — em uso por extensões/userscripts públicos e ativos (Streaming
 * Enhanced / Netflix-Prime-Auto-Skip, Netflix Auto Skip BTK):
 *   [data-uia="player-skip-intro"], [data-uia="player-skip-recap"],
 *   [data-uia="player-skip-preplay"], [data-uia="next-episode-seamless-button"],
 *   [data-uia="next-episode-seamless-button-draining"],
 *   [data-uia="interrupt-autoplay-continue"], [data-uia^="pause-ad"],
 *   .watch-video, .watch-video--skip-content-button,
 *   .watch-video--skip-preplay-button
 *
 * PALPITE — tudo que detecta o bloco de anúncio, e os itens marcados como tal
 * nas listas abaixo. Nenhuma fonte pública nomeia um `data-uia` estável pro
 * contador de anúncio; as extensões que fazem isso se apoiam na classe hasheada
 * (`span[class*="mmvz9h"]`), que segundo o changelog delas já quebrou mais de
 * uma vez. Daí a ordem: família de `data-uia` primeiro, hash por último.
 *
 * Manutenção: com `debug: true`, o log informa qual marcador casou. Se nenhum
 * casar, o bloco passa sem mute — inspecione o contador durante um anúncio,
 * copie o `data-uia` e ponha no topo de AD_MARKER_SELECTORS.
 *
 * Carregado ANTES do core.js; só se anuncia em globalThis.__PULA_ADAPTER__.
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // SELETORES
  // ───────────────────────────────────────────────────────────────────────────

  const PLAYER_SELECTORS = [
    '.watch-video',
    '[data-uia="player"]',       // palpite: wrapper novo do player
    '.nf-player-container',      // palpite: layout antigo
  ];

  /** O <video> vive dentro do player; o core cai em `video` genérico se falhar. */
  const VIDEO_SELECTORS = ['.watch-video video', '[data-uia="player"] video'];

  /**
   * Marcadores de "tem anúncio tocando agora". Ordem = confiança.
   * Presença basta, sem checar visibilidade: nosso próprio CSS esconde parte
   * disso com `display:none`, que tira da tela mas mantém o nó no DOM — checar
   * renderização aqui faria a extensão cegar a si mesma.
   */
  const AD_MARKER_SELECTORS = [
    '[data-uia^="ad-countdown"]',      // palpite
    '[data-uia^="ad-timer"]',          // palpite
    '[data-uia^="ad-break"]',          // palpite
    '[data-uia^="ads-"]',              // palpite
    '[data-uia^="ad-"]',               // palpite abrangente; `^=` de propósito —
    '[data-uia*="advertisement" i]',   // `*="ad"` casaria "loading", "download"
    '.watch-video--advertisement',     // palpite
    'span[class*="mmvz9h"]',           // hash volátil, último recurso
  ];

  /**
   * O hash acima é o único marcador que não descreve a si mesmo: se o emotion
   * reciclar essa classe pra outro span qualquer, a extensão mutaria o episódio
   * inteiro. Por isso ele só conta se o texto parecer uma contagem regressiva.
   */
  const AD_COUNTDOWN_HASH_SELECTOR = 'span[class*="mmvz9h"]';

  /**
   * Escondidos via CSS quando `hideAdOverlays` está ligado. `display:none` não
   * remove o nó, então esconder o contador não atrapalha a detecção acima.
   */
  const OVERLAY_HIDE_SELECTORS = [
    '[data-uia^="pause-ad"]',          // cartão de anúncio que abre ao pausar
    '[data-uia^="ad-"]',               // contador/badge do bloco (palpite)
    '[data-uia^="ads-"]',              // palpite
    '[data-uia*="advertisement" i]',   // palpite
    '.watch-video--advertisement',     // palpite
  ];

  /**
   * Vazio de propósito: o Netflix não vende espaço de terceiros fora do player
   * — o que a home mostra é promoção do catálogo dele mesmo, que não é anúncio
   * e o usuário não pediu pra sumir. Se um dia aparecer, é aqui que entra.
   */
  const FEED_HIDE_SELECTORS = [];

  /** "Pular abertura" / "Pular recapitulação" / "Pular créditos". */
  const INTRO_SKIP_SELECTORS = [
    '[data-uia="player-skip-intro"]',
    '[data-uia="player-skip-recap"]',
    '[data-uia="player-skip-preplay"]',
    '[data-uia="player-skip-credits"]',      // palpite
    '.watch-video--skip-content-button',
    '.watch-video--skip-preplay-button',
  ];

  /**
   * "Próximo episódio". O `-draining` é o botão com a barrinha que enche
   * durante os créditos; vem primeiro porque é o que aparece na transição
   * automática, enquanto o outro é o cartão de post-play.
   * `watch-credits-seamless-button` fica FORA de propósito: ele faz o oposto
   * (assistir aos créditos inteiros).
   */
  const NEXT_EPISODE_SELECTORS = [
    '[data-uia="next-episode-seamless-button-draining"]',
    '[data-uia="next-episode-seamless-button"]',
  ];

  /**
   * Roots do fallback por texto — e também do dump de diagnóstico do core.
   * Aqui não existe container de anúncio isolado, então o root é o player
   * inteiro, o que inclui a barra de controle: daí o regex abaixo ser estreito.
   */
  const SKIP_FALLBACK_ROOTS = ['.watch-video', '[data-uia="player"]'];

  /**
   * Botão de "pular anúncio" — para os blocos em que o site oferece um.
   *
   * O grosso do inventário daqui é SSAI, onde esse botão não existe: nesses
   * blocos as queries abaixo não casam nada, o pipeline segue pro mute e o
   * custo é uma query que falha. Mas alguns formatos (anúncio interativo,
   * pré-roll de parceiro) trazem botão de verdade, e aí clicar é exatamente o
   * gesto que o usuário faria com o mouse. Não tentar perde o clique quando ele
   * existe; tentar não perde nada quando não existe.
   *
   * SELETORES SÃO PALPITE — nenhum verificado em player real. Quem resolve na
   * prática é o fallback por texto abaixo, que sobrevive a renomeação de
   * classe. Quando o dump de stall revelar o seletor certo, ele entra no topo.
   */
  const AD_SKIP_SELECTORS = [
    '[data-uia*="skip-ad" i]',
    '[data-uia*="ad-skip" i]',
    '[data-uia*="skip-commercial" i]',
    'button[aria-label*="pular an" i]',
    'button[aria-label*="skip ad" i]',
  ];

  /**
   * Estreito de propósito: exige verbo de skip E palavra de anúncio. O padrão
   * do core (/pular|skip/) casaria "Pular abertura" e "Skip Intro", que aqui
   * são tratados fora do bloco de anúncio, no onTick — clicar neles durante o
   * anúncio adiantaria parte do episódio.
   */
  const AD_SKIP_TEXT_RE =
    /\b(?:pular|ignorar|dispensar|saltar|omitir|skip)\b[\s:]*(?:o|a|os|as|este|esta|the|this|el|la)?\s*\b(?:an[\u00fau]ncios?|publicidade|propaganda|comerciais|comercial|ads?|advert(?:isement)?s?)\b/i;


  /**
   * Estreito de propósito. Um `/pular|skip/` genérico varrendo o player pegaria
   * "Avançar 10 segundos" e o "Próximo episódio" da barra de controle, que
   * pularia conteúdo que o usuário está assistindo.
   */
  const SKIP_INTRO_TEXT_RE =
    /pular (in[íi]cio|abertura|intro|recap|recapitula|resumo|cr[ée]ditos)|skip (intro|recap|credits|preplay)|saltar (intro|resumen|cr[ée]ditos)|omitir (intro|resumen)/i;

  /**
   * "Você ainda está assistindo?". O modal pausa o vídeo até alguém confirmar.
   * O container é palpite; o botão é confirmado.
   */
  const INTERRUPTER_DIALOG_SELECTORS = [
    '[data-uia*="interrupter" i]',       // palpite
    '[data-uia^="interrupt-autoplay"]',  // palpite (derivado do botão confirmado)
    '.interrupter-actions',              // palpite (layout antigo)
    '[role="dialog"]',
  ];
  const INTERRUPTER_CONTINUE_SELECTORS = [
    '[data-uia="interrupt-autoplay-continue"]',
    '[data-uia*="continue" i]',          // palpite; só é consultado DENTRO do modal
  ];
  const CONTINUE_TEXT_RE =
    /ainda est[áa] (a[íi]|por a[íi]|assistindo)|continuar assistindo|continue watching|still (watching|there)|sigues (ah[íi]|viendo)|seguir viendo/i;

  /**
   * Intervalo mínimo entre dois cliques de skip. O botão some depois do clique,
   * mas o React remonta a árvore com frequência e o tick roda a cada mutação —
   * sem essa folga, um clique que não "pegou" vira uma rajada que engasga o
   * player.
   */
  const SKIP_CLICK_COOLDOWN_MS = 1000;

  // ───────────────────────────────────────────────────────────────────────────
  // Detecção do bloco de anúncio
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Procura o marcador de anúncio, começando pelo seletor que casou da última
   * vez: durante o bloco o tick roda a cada mutação, e varrer a lista inteira
   * toda vez é desperdício.
   */
  function findAdMarker(ctx) {
    const st = ctx.adapterState;
    const first = st.adMarkerSelector;
    const ordered = first
      ? [first, ...AD_MARKER_SELECTORS.filter((sel) => sel !== first)]
      : AD_MARKER_SELECTORS;

    for (const sel of ordered) {
      const el = ctx.queryFirst([sel]);
      if (!el) continue;
      if (sel === AD_COUNTDOWN_HASH_SELECTOR && !/\d/.test(el.textContent || '')) continue;

      if (st.adMarkerSelector !== sel) {
        st.adMarkerSelector = sel;
        ctx.log('marcador de anúncio casou:', sel, '→', ctx.describe(el));
      }
      return el;
    }

    st.adMarkerSelector = null;
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Diálogo "você ainda está assistindo?"
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Confirmamos sozinhos, mas só depois de bater o texto do modal — mesma
   * guarda do adapter do YouTube. Um `data-uia` pode ser reaproveitado em outro
   * modal (aviso de cobrança, "continuar de onde parou?"), e clique cego em
   * botão de diálogo é exatamente o que não fazemos. NUNCA remover essa guarda.
   */
  function confirmStillWatching(ctx) {
    if (!ctx.can('skipContinueWatching')) return false;

    for (const dialog of ctx.queryAll(INTERRUPTER_DIALOG_SELECTORS)) {
      if (ctx.handledDialogs.has(dialog)) continue;
      if (!CONTINUE_TEXT_RE.test(dialog.textContent || '')) continue;

      const target = ctx.clickTargetFor(ctx.queryFirst(INTERRUPTER_CONTINUE_SELECTORS, dialog));
      if (!target || !ctx.isClickable(target)) {
        // O texto bateu mas o botão não: sinal de que o data-uia mudou. Uma vez
        // por modal, senão vira spam a cada tick.
        if (!ctx.adapterState.interrupterWarned) {
          ctx.adapterState.interrupterWarned = true;
          ctx.log('modal "ainda está assistindo?" encontrado, botão não — revise INTERRUPTER_CONTINUE_SELECTORS');
        }
        continue;
      }

      ctx.handledDialogs.add(dialog);
      target.click();
      ctx.log('"você ainda está assistindo?" confirmado');
      return true;
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Abertura, recapitulação e próximo episódio
  // ───────────────────────────────────────────────────────────────────────────

  function clickSkipButtons(ctx) {
    if (!ctx.can('skipIntros')) return false;

    const st = ctx.adapterState;
    const now = performance.now();
    if (now - (st.lastSkipClick || 0) < SKIP_CLICK_COOLDOWN_MS) return false;

    const clicked =
      ctx.clickFirst(INTRO_SKIP_SELECTORS) ||
      ctx.clickFirst(NEXT_EPISODE_SELECTORS) ||
      // Último recurso: nenhum data-uia conhecido casou. Sobrevive a renomeação,
      // que é o modo mais comum de tudo isso quebrar.
      ctx.clickByText(SKIP_FALLBACK_ROOTS, SKIP_INTRO_TEXT_RE) ||
      // E sem root nenhum: o botão pode nascer fora do wrapper conhecido, ou o
      // wrapper mudar de nome. Ver o comentário de clickByTextAnywhere no core.
      ctx.clickByTextAnywhere(SKIP_INTRO_TEXT_RE);

    if (clicked) st.lastSkipClick = now;
    return clicked;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Navegação
  // ───────────────────────────────────────────────────────────────────────────

  /** `/watch/<id>` é o que identifica o que está tocando. */
  function currentWatchId() {
    const match = /\/watch\/(\d+)/.exec(location.pathname);
    return match ? match[1] : location.pathname;
  }

  function resetCache(ctx) {
    const st = ctx.adapterState;
    st.adMarkerSelector = null;
    st.lastSkipClick = 0;
    st.interrupterWarned = false;
  }

  /**
   * O Netflix navega por `pushState`, que não emite evento nenhum — o core só
   * escuta `popstate`, então trocar de episódio pelo post-play passaria batido.
   * Comparar o id no tick é o sinal que sempre existe.
   */
  function syncLocation(ctx) {
    const st = ctx.adapterState;
    const id = currentWatchId();
    if (id === st.watchId) return;
    st.watchId = id;
    resetCache(ctx);
    ctx.log('navegou para', id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  globalThis.__PULA_ADAPTER__ = {
    id: 'netflix',
    label: 'Netflix',

    playerSelectors: PLAYER_SELECTORS,
    videoSelectors: VIDEO_SELECTORS,

    /**
     * Vazio: no SSAI não existe botão de pular anúncio. Os botões de abertura e
     * próximo episódio moram em INTRO_SKIP_SELECTORS/NEXT_EPISODE_SELECTORS e
     * são clicados no `onTick`, FORA do bloco de anúncio — de propósito, pra
     * que uma detecção de anúncio errada nunca clique neles.
     */
    skipButtonSelectors: AD_SKIP_SELECTORS,
    skipTextRe: AD_SKIP_TEXT_RE,

    skipFallbackRoots: SKIP_FALLBACK_ROOTS,
    overlayHideSelectors: OVERLAY_HIDE_SELECTORS,
    feedHideSelectors: FEED_HIDE_SELECTORS,

    /**
     * O alarme de stall padrão (10s) dispararia em todo intervalo comercial:
     * aqui o anúncio durar é o comportamento normal, não sintoma de seletor
     * quebrado. 45s já é anormal até pro Netflix, e o dump dos botões do player
     * continua sendo a ferramenta de manutenção quando isso acontece.
     */
    configDefaults: { stallWarnMs: 45000 },

    supports: {
      // SSAI: o player reverte o seek dentro do bloco, então adiantar o
      // playhead só geraria loop. Clicar, não: quando o site põe um botão
      // de pular na tela, ele funciona igual ao de qualquer outro lugar.
      fastForwardUnskippable: false,
      // Não existe modal anti-adblock nem painel de capítulos patrocinados.
      dismissAdblockDialog: false,
      skipSponsorChapters: false,
    },

    isAdShowing(ctx) {
      return findAdMarker(ctx) !== null;
    },

    onAdStart(ctx) {
      // Deixa explícito no log que o silêncio a seguir é limitação do SSAI, e
      // não a extensão falhando em pular.
      ctx.log('bloco de anúncio SSAI: dá pra mutar e esconder, não pra pular');
    },

    onTick(ctx) {
      syncLocation(ctx);
      // O modal pausa o vídeo, então ele vem antes: com o vídeo parado nenhum
      // botão de abertura chega a aparecer.
      confirmStillWatching(ctx);
      clickSkipButtons(ctx);
    },

    onNavigate(ctx) {
      // `syncLocation` refaz o resto no próximo tick, quando a URL nova já vale.
      ctx.adapterState.watchId = null;
      resetCache(ctx);
    },
  };
})();
