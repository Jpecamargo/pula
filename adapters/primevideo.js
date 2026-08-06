/**
 * Adapter: Prime Video (primevideo.com e as páginas /gp/video da amazon).
 *
 * O tier com anúncios usa SSAI: o bloco publicitário vem costurado no mesmo
 * stream do título. Não existe <video> separado, não existe botão de pular e o
 * player reverte qualquer avanço de `currentTime` dentro do bloco — por isso
 * `clickSkipButton` e `fastForwardUnskippable` vêm desligados em `supports`.
 * Prometer skip aqui só produziria um loop de clique inútil e um contador
 * mentindo sobre tempo economizado. O que sobra, e funciona, é mutar o bloco,
 * esconder o contador de anúncio e clicar em "Pular abertura" /
 * "Pular recapitulação" / "Próximo episódio".
 *
 * Todo seletor aqui usa o prefixo `atvwebplayersdk-`, que a Amazon mantém há
 * anos no player web. O mesmo player também gera classes hasheadas curtas
 * (`.fu4rd6c` e afins) que mudam a cada deploy: nenhuma entrou nas listas
 * abaixo de propósito — sem uma fonte pública que diga QUAL hash é o de
 * anúncio hoje, colocar uma seria chutar em cima de um alvo que já mudou.
 *
 * O player exige login, então NADA aqui foi verificado no DOM real. A divisão
 * honesta, pra quem for manter:
 *
 * CONFIRMADO — em uso por extensões/userscripts públicos e ativos
 * (Netflix-Prime-Auto-Skip / StreamingEnhanced, binge-stream,
 * skip-prime-video-intro):
 *   .atvwebplayersdk-skipelement-button   (pular abertura/recapitulação)
 *   .atvwebplayersdk-nextupcard-button    (próximo episódio)
 *   .atvwebplayersdk-adtimeindicator-text (texto do contador de anúncio)
 *   .atvwebplayersdk-infobar-container    (barra de info do player)
 *   .webPlayerSDKContainer / .webPlayerElement (container do player)
 *
 * PALPITE — todo o resto: as variações `[class*=…]`, os `data-testid`, o
 * diálogo "ainda está assistindo?" e a lista de anúncios fora do player.
 *
 * Manutenção: com `debug: true`, o log informa qual marcador casou. Se nenhum
 * casar, o bloco passa sem mute — inspecione o contador durante um anúncio,
 * copie a classe `atvwebplayersdk-*` e ponha no topo de AD_MARKERS.
 *
 * Carregado ANTES do core.js; só se anuncia em globalThis.__PULA_ADAPTER__.
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // SELETORES
  // ───────────────────────────────────────────────────────────────────────────

  const PLAYER_SELECTORS = [
    '.webPlayerSDKContainer',
    '.webPlayerElement',
    '.dv-player-fullscreen',        // palpite: wrapper do modo cheio
    '[id^="dv-web-player"]',        // palpite: host do player na página de detalhe
  ];

  /**
   * O player monta mais de um <video> (o do título e o de pré-carregamento), e
   * o primeiro dentro do container é o que está na tela. O core cai em `video`
   * genérico se nada casar.
   */
  const VIDEO_SELECTORS = ['.webPlayerSDKContainer video', '.webPlayerElement video'];

  /**
   * Palavras que aparecem no contador/badge do bloco publicitário. Servem de
   * segunda barreira contra falso positivo, junto com o dígito da contagem.
   */
  const AD_WORD_RE = /an[úu]ncio|publicidade|comercial|advertisement|\bads?\b/i;

  /**
   * Marcadores de "tem anúncio tocando agora", em ordem de confiança.
   *
   * Todos exigem que o nó tenha texto de anúncio (ver `looksLikeAdText`): o
   * player da Amazon pré-monta a árvore de overlays vazia, então presença de
   * nó sozinha não distingue "existe um lugar pro contador" de "o contador
   * está contando". Sem essa guarda, a extensão mutaria o filme inteiro.
   *
   * Nada aqui casa X-Ray, cartão de "assista a seguir" ou promoção de catálogo
   * — autopromoção de conteúdo não é bloco publicitário e não deve mutar nada.
   */
  const AD_MARKERS = [
    { sel: '.atvwebplayersdk-adtimeindicator-text' },
    { sel: '[class*="adtimeindicator" i]' },          // palpite: sufixo renomeado
    { sel: '[class*="atvwebplayersdk-ad-" i]' },      // palpite; o hífen depois de
                                                      // "ad" evita casar "addto…"
    { sel: '[class*="adcountdown" i]' },              // palpite
    { sel: '[data-testid*="ad-countdown" i]' },       // palpite
    { sel: '[data-testid*="ad-badge" i]' },           // palpite
  ];

  /**
   * Escondidos via CSS quando `hideAdOverlays` está ligado. `display:none` não
   * remove o nó nem apaga o `textContent`, então esconder o contador não
   * atrapalha a detecção acima.
   *
   * A `infobar-container` inteira fica FORA: ela é a barra de título do player,
   * usada o tempo todo, e não o overlay do anúncio.
   */
  const OVERLAY_HIDE_SELECTORS = [
    '.atvwebplayersdk-adtimeindicator-text',
    '[class*="adtimeindicator" i]',      // palpite
    '[class*="atvwebplayersdk-ad-" i]',  // palpite
    '[data-testid*="ad-countdown" i]',   // palpite
    '[data-testid*="ad-badge" i]',       // palpite
  ];

  /**
   * Fora do player, a Prime Video só mostra o próprio catálogo — isso é
   * promoção, não anúncio de terceiro, e o usuário não pediu pra sumir. Sobram
   * as faixas explicitamente marcadas como patrocinadas, que a Amazon rotula.
   * Tudo palpite; ligado só com `hideFeedAds`.
   */
  const FEED_HIDE_SELECTORS = [
    '[data-testid*="sponsored" i]',
    '[class*="dv-sponsored" i]',
    '[aria-label*="Patrocinado" i]',
    '[aria-label*="Sponsored" i]',
  ];

  /** "Pular abertura" / "Pular recapitulação" / "Pular créditos". */
  const INTRO_SKIP_SELECTORS = [
    '.atvwebplayersdk-skipelement-button',
    '[class*="skipelement" i]',          // palpite: sufixo renomeado
  ];

  /**
   * "Próximo episódio". Só a classe exata: o mesmo cartão traz um botão de
   * dispensar (`…-nextupcard-hide-button`), e um `[class*="nextupcard"]` largo
   * clicaria nele — ou seja, faria justamente o contrário do pedido.
   */
  const NEXT_EPISODE_SELECTORS = ['.atvwebplayersdk-nextupcard-button'];

  /**
   * Roots do fallback por texto — e também do dump de diagnóstico do core.
   * Aqui não existe container isolado de anúncio, então o root é o player
   * inteiro, o que inclui a barra de controle: daí o regex abaixo ser estreito.
   */
  const SKIP_FALLBACK_ROOTS = ['.webPlayerSDKContainer', '.webPlayerElement'];

  /**
   * Estreito de propósito. Um `/pular|skip/` genérico varrendo o player pegaria
   * "Avançar 10 segundos" da barra de controle. E "próximo episódio" fica de
   * fora do texto de propósito: a barra tem um botão de próximo título, que
   * pularia o episódio que está sendo assistido — esse caminho só existe via
   * NEXT_EPISODE_SELECTORS, que aponta pro cartão de fim de episódio.
   */
  const SKIP_INTRO_TEXT_RE =
    /pular (abertura|in[íi]cio|intro|introdu[çc][ãa]o|recapitula[çc][ãa]o|recap|resumo|cr[ée]ditos)|skip (intro|recap|credits|opening)|saltar (intro|resumen|cr[ée]ditos)|omitir (intro|resumen)/i;

  /**
   * "Você ainda está assistindo?". O modal pausa o vídeo até alguém confirmar.
   * Nenhum seletor confirmado, então o container é genérico e quem manda é o
   * texto.
   */
  const STILL_WATCHING_DIALOG_SELECTORS = [
    '[class*="stillwatching" i]',   // palpite
    '[data-testid*="still-watching" i]', // palpite
    '[role="dialog"]',
    '[role="alertdialog"]',
  ];
  /**
   * A forma interrogativa é obrigatória: "continuar assistindo" sozinho é o
   * nome da prateleira da home, e casaria com meia tela do site.
   */
  const STILL_WATCHING_TEXT_RE =
    /ainda est[áa] (a[íi]|por a[íi]|assistindo)|continua assistindo\?|still (watching|there)|sigues (ah[íi]|viendo)|sigue ah[íi]/i;
  /** Consultados SÓ dentro de um diálogo cujo texto já bateu o regex acima. */
  const STILL_WATCHING_CONTINUE_SELECTORS = [
    '[class*="continue" i]',        // palpite
    '[data-testid*="continue" i]',  // palpite
  ];
  const CONTINUE_BUTTON_TEXT_RE = /continuar|continue|seguir|estou aqui|sim\b|yes\b/i;

  /**
   * Intervalo mínimo entre dois cliques de skip. O botão some depois do clique,
   * mas o player remonta a árvore de overlays com frequência e o tick roda a
   * cada mutação — sem essa folga, um clique que não "pegou" vira uma rajada
   * que engasga o player.
   */
  const SKIP_CLICK_COOLDOWN_MS = 1000;

  // ───────────────────────────────────────────────────────────────────────────
  // Detecção do bloco de anúncio
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Um contador de anúncio tem número (tempo restante, "1 de 3") ou a palavra.
   * Nó pré-montado e vazio não passa — é o que separa "o player tem um lugar
   * pro contador" de "o anúncio está tocando".
   */
  function looksLikeAdText(el) {
    const text = (el.textContent || '').trim();
    if (!text) return false;
    return /\d/.test(text) || AD_WORD_RE.test(text);
  }

  /**
   * Procura o marcador de anúncio, começando pelo que casou da última vez:
   * durante o bloco o tick roda a cada mutação, e varrer a lista inteira toda
   * vez é desperdício.
   *
   * A busca é restrita ao container do player. X-Ray, cartões promocionais e
   * carrosséis da home vivem fora dele, e essa restrição é a primeira defesa
   * contra tratar autopromoção de catálogo como anúncio.
   */
  function findAdMarker(ctx) {
    const st = ctx.adapterState;
    const root = ctx.getPlayer();
    // Sem player montado não há o que mutar — e buscar no documento inteiro só
    // ampliaria a superfície de falso positivo.
    if (!root) {
      st.adMarker = null;
      return null;
    }

    const first = st.adMarker;
    const ordered = first ? [first, ...AD_MARKERS.filter((m) => m !== first)] : AD_MARKERS;

    for (const marker of ordered) {
      const el = ctx.queryFirst([marker.sel], root);
      if (!el || !looksLikeAdText(el)) continue;

      if (st.adMarker !== marker) {
        st.adMarker = marker;
        ctx.log('marcador de anúncio casou:', marker.sel, '→', ctx.describe(el));
      }
      return el;
    }

    st.adMarker = null;
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Diálogo "você ainda está assistindo?"
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Confirmamos sozinhos, mas só depois de bater o texto do modal — mesma
   * guarda dos outros adapters. `[role="dialog"]` casa qualquer modal do site
   * (aviso de cobrança, troca de perfil, confirmação de compra), e clique cego
   * em botão de diálogo é exatamente o que não fazemos. NUNCA remover a guarda.
   */
  function confirmStillWatching(ctx) {
    if (!ctx.can('skipContinueWatching')) return false;

    for (const dialog of ctx.queryAll(STILL_WATCHING_DIALOG_SELECTORS)) {
      if (ctx.handledDialogs.has(dialog)) continue;
      if (!STILL_WATCHING_TEXT_RE.test(dialog.textContent || '')) continue;

      const target = findContinueButton(ctx, dialog);
      if (!target) {
        // O texto bateu mas o botão não: sinal de que a marcação mudou. Uma vez
        // por sessão, senão vira spam a cada tick.
        if (!ctx.adapterState.stillWatchingWarned) {
          ctx.adapterState.stillWatchingWarned = true;
          ctx.log('modal "ainda está assistindo?" encontrado, botão não — revise STILL_WATCHING_CONTINUE_SELECTORS');
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

  /**
   * Busca confinada ao diálogo já validado pelo texto. Sem seletor confirmado
   * pra este modal, o texto do próprio botão é o critério mais estável — e
   * dentro de um modal que já se identificou, varrer botões é seguro.
   */
  function findContinueButton(ctx, dialog) {
    const bySelector = ctx.clickTargetFor(ctx.queryFirst(STILL_WATCHING_CONTINUE_SELECTORS, dialog));
    if (bySelector && ctx.isClickable(bySelector)) return bySelector;

    for (const el of ctx.queryAll(['button', '[role="button"]', 'a'], dialog)) {
      const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`;
      if (!CONTINUE_BUTTON_TEXT_RE.test(label)) continue;
      if (!ctx.isClickable(el)) continue;
      return el;
    }
    return null;
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
      // Último recurso: nenhuma classe conhecida casou. Sobrevive a renomeação,
      // que é o modo mais comum de tudo isso quebrar.
      ctx.clickByText(SKIP_FALLBACK_ROOTS, SKIP_INTRO_TEXT_RE);

    if (clicked) st.lastSkipClick = now;
    return clicked;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Navegação
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * O id do título aparece como `/detail/<gti>` na primevideo.com e no
   * `/gp/video/detail/<asin>` da amazon. É o que identifica o que está tocando.
   */
  function currentTitleId() {
    const match = /\/detail\/([^/?#]+)/.exec(location.pathname);
    return match ? match[1] : location.pathname;
  }

  function resetCache(ctx) {
    const st = ctx.adapterState;
    st.adMarker = null;
    st.lastSkipClick = 0;
    st.stillWatchingWarned = false;
  }

  /**
   * A Prime Video navega por `pushState`, que não emite evento nenhum — o core
   * só escuta `popstate`, então passar pro próximo episódio pelo cartão de fim
   * passaria batido. Comparar o id no tick é o sinal que sempre existe.
   */
  function syncLocation(ctx) {
    const st = ctx.adapterState;
    const id = currentTitleId();
    if (id === st.titleId) return;
    st.titleId = id;
    resetCache(ctx);
    ctx.log('navegou para', id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  globalThis.__PULA_ADAPTER__ = {
    id: 'primevideo',
    label: 'Prime Video',

    playerSelectors: PLAYER_SELECTORS,
    videoSelectors: VIDEO_SELECTORS,

    /**
     * Vazio: no SSAI não existe botão de pular anúncio. Os botões de abertura e
     * próximo episódio moram em INTRO_SKIP_SELECTORS/NEXT_EPISODE_SELECTORS e
     * são clicados no `onTick`, FORA do bloco de anúncio — de propósito, pra
     * que uma detecção de anúncio errada nunca clique neles.
     */
    skipButtonSelectors: [],

    skipFallbackRoots: SKIP_FALLBACK_ROOTS,
    overlayHideSelectors: OVERLAY_HIDE_SELECTORS,
    feedHideSelectors: FEED_HIDE_SELECTORS,

    /**
     * O alarme de stall padrão (10s) dispararia em todo intervalo comercial:
     * aqui o anúncio durar é o comportamento normal, não sintoma de seletor
     * quebrado. 45s já é anormal até pra Prime Video, e o dump dos botões do
     * player continua sendo a ferramenta de manutenção quando isso acontece.
     */
    configDefaults: { stallWarnMs: 45000 },

    supports: {
      // SSAI: não existe botão de pular, e o player reverte o seek dentro do
      // bloco. Ligar qualquer um dos dois só geraria loop de clique.
      clickSkipButton: false,
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
      ctx.adapterState.titleId = null;
      resetCache(ctx);
    },
  };
})();
