/**
 * Adapter: Disney+ / Star+ (mesmo player nos dois domínios).
 *
 * O plano com anúncios usa SSAI: o bloco publicitário vem costurado no mesmo
 * stream do título. Não existe <video> separado, não existe botão de pular e o
 * player reverte qualquer avanço de `currentTime` dentro do bloco — por isso
 * `clickSkipButton` e `fastForwardUnskippable` vêm desligados em `supports`.
 * Prometer skip aqui só produziria um loop de clique inútil e um contador
 * mentindo sobre tempo economizado. O que sobra, e funciona, é mutar o bloco,
 * esconder o contador/overlay de publicidade e clicar em "Pular abertura" /
 * "Pular recapitulação" / "Próximo episódio".
 *
 * O player do Disney+ marca boa parte da UI com `data-testid`, que sobrevive a
 * deploy melhor do que classe — daí a preferência por ele em todo seletor novo.
 * As classes que entraram são as que os userscripts públicos usam há anos.
 *
 * O player exige login, então NADA aqui foi verificado no DOM real. A divisão
 * honesta, pra quem for manter:
 *
 * CONFIRMADO — em uso por userscripts/extensões públicos e ativos
 * ("DisneyPlus Skip Intro & Next Episode" e "Autoskip DisneyPlus/StarPlus" no
 * Greasy Fork, funkyremi/autoskipr, k0x1a4/disney-plus-utility):
 *   button.skip__button (às vezes com `.body-copy`) — pular abertura/recap/créditos
 *   [data-testid="up-next-play-button"]             — próximo episódio
 *
 * DOCUMENTADO, não verificado — a marcação do container do player
 * (`.btm-media-client-element` no <video>, `.btm-media-overlays-container` nos
 * overlays) circula em relatos de inspeção do player, mas nenhuma fonte pública
 * que dê pra ler confirma que ainda é assim hoje.
 *
 * PALPITE — TUDO que detecta o bloco de anúncio. Nenhuma lista de filtro ou
 * extensão pública nomeia um marcador de anúncio do Disney+: as que dizem
 * "bloquear anúncio no Disney+" fazem isso por rede, caminho que este projeto
 * não usa por princípio. Também são palpite os `data-testid` de skip, o modal
 * "ainda está assistindo?" e os wrappers alternativos do player.
 *
 * Manutenção: com `debug: true`, o log informa qual marcador casou. Se nenhum
 * casar, o bloco passa sem mute — inspecione o contador durante um anúncio,
 * copie o `data-testid` e ponha no topo de AD_MARKERS.
 *
 * Carregado ANTES do core.js; só se anuncia em globalThis.__PULA_ADAPTER__.
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // SELETORES
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Container do player. Serve de root pra detecção de anúncio e pro dump de
   * diagnóstico do core, então quanto mais estreito melhor: é o que impede o
   * carrossel da home de ser confundido com overlay do player.
   */
  const PLAYER_SELECTORS = [
    '.btm-media-overlays-container',
    '#hudson-wrapper',              // palpite: wrapper histórico do player web
    '[class*="btm-media-client" i]',// palpite: variação do nome do container
  ];

  /**
   * Só seletor qualificado por `video`: o core usa o que vier daqui direto como
   * elemento de mídia (`.muted`, `.playbackRate`), e casar um <div> com nome
   * parecido quebraria mute e restauração em silêncio.
   */
  const VIDEO_SELECTORS = ['video.btm-media-client-element', '#hudson-wrapper video'];

  /**
   * Palavras do contador/badge do bloco publicitário, em pt/en/es. Segunda
   * barreira contra falso positivo, junto com o dígito da contagem.
   */
  const AD_WORD_RE = /an[úu]ncio|publicidade|comercial|intervalo|advertisement|\bads?\b|anuncio/i;

  /**
   * Marcadores de "tem anúncio tocando agora", em ordem de confiança — todos
   * palpite, ver cabeçalho.
   *
   * Nenhum casa por `[class*="ad" i]` solto: "ad" aparece dentro de "loading",
   * "download", "header" e "shadow", e um marcador desses mutaria o filme
   * inteiro. Todos ancoram o "ad" num hífen ou numa palavra completa.
   *
   * Nada aqui casa o cartão de "próximo episódio" nem promoção de catálogo:
   * autopromoção não é bloco publicitário e não deve mutar nada.
   */
  const AD_MARKERS = [
    '[data-testid*="ad-badge" i]',
    '[data-testid*="ad-countdown" i]',
    '[data-testid*="ad-timer" i]',
    '[data-testid*="ad-break" i]',
    '[data-testid*="advertisement" i]',
    '[class*="ad-badge" i]',
    '[class*="ad-countdown" i]',
    '[class*="ad-timer" i]',
    '[class*="advertisement" i]',
    '[class*="commercial-break" i]',
  ];

  /**
   * Escondidos via CSS quando `hideAdOverlays` está ligado. `display:none` não
   * remove o nó nem apaga o `textContent`, então esconder o contador não
   * atrapalha a detecção acima.
   *
   * A lista é só PUBLICIDADE de propósito. O overlay de "próximo episódio"
   * (`[data-testid^="up-next"]`) fica FORA: `skipIntros` precisa clicar nele, e
   * `display:none` reprova em `isClickable` — esconder aqui desligaria o
   * recurso na surdina. Pelo mesmo motivo a `btm-media-overlays-container`
   * inteira fica fora: ela carrega a barra de controle e os botões de skip.
   */
  const OVERLAY_HIDE_SELECTORS = [
    '[data-testid*="ad-badge" i]',
    '[data-testid*="ad-countdown" i]',
    '[data-testid*="ad-timer" i]',
    '[data-testid*="ad-break" i]',
    '[class*="ad-badge" i]',
    '[class*="ad-countdown" i]',
    '[class*="ad-timer" i]',
    '[class*="advertisement" i]',
  ];

  /**
   * Vazio de propósito: fora do player o Disney+ só mostra o próprio catálogo —
   * isso é promoção, não anúncio de terceiro, e o usuário não pediu pra sumir.
   * Se um dia aparecer faixa patrocinada de fora, é aqui que entra.
   */
  const FEED_HIDE_SELECTORS = [];

  /**
   * "Pular abertura" / "Pular recapitulação" / "Pular créditos" — o Disney+ usa
   * o mesmo botão pros três, mudando só o rótulo.
   */
  const INTRO_SKIP_SELECTORS = [
    'button.skip__button',
    '.skip__button',
    '[data-testid="skip-button"]',  // palpite: marcação nova do mesmo botão
    '[class*="skip__button" i]',    // palpite: sufixo renomeado
    '.skip-button',                 // palpite: variante com um hífen só
  ];

  /**
   * "Próximo episódio". Só o botão de play, nunca o container: o cartão de
   * up-next traz também um botão de dispensar, e um `[data-testid^="up-next"]`
   * largo clicaria nele — ou seja, faria o contrário do pedido.
   */
  const NEXT_EPISODE_SELECTORS = [
    '[data-testid="up-next-play-button"]',
    '[data-testid*="up-next-play" i]',  // palpite: sufixo renomeado
  ];

  /**
   * Roots do fallback por texto — e também do dump de diagnóstico do core.
   * Aqui não existe container isolado de anúncio, então o root é o player
   * inteiro, o que inclui a barra de controle: daí o regex abaixo ser estreito.
   */
  const SKIP_FALLBACK_ROOTS = ['.btm-media-overlays-container', '#hudson-wrapper'];

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
    '[data-testid*="skip-ad" i]',
    '[data-testid*="ad-skip" i]',
    '[class*="skip-ad" i]',
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
   * "Avançar 10 segundos" da barra de controle. E "próximo episódio" fica de
   * fora do texto: a barra tem um botão de próximo título que pularia o
   * episódio em andamento — esse caminho só existe via NEXT_EPISODE_SELECTORS,
   * que aponta pro cartão de fim de episódio.
   */
  const SKIP_INTRO_TEXT_RE =
    /pular (abertura|in[íi]cio|intro|introdu[çc][ãa]o|recapitula[çc][ãa]o|recap|resumo|cr[ée]ditos)|skip (intro|recap|credits|opening)|saltar (intro|resumen|cr[ée]ditos)|omitir (intro|resumen)/i;

  /**
   * "Você ainda está assistindo?". O modal pausa o vídeo até alguém confirmar.
   * Nenhum seletor confirmado, então o container é genérico e quem manda é o
   * texto.
   */
  const STILL_WATCHING_DIALOG_SELECTORS = [
    '[data-testid*="still-watching" i]',   // palpite
    '[data-testid*="are-you-still" i]',    // palpite
    '[class*="stillwatching" i]',          // palpite
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
    '[data-testid*="continue" i]',   // palpite
    '[class*="continue" i]',         // palpite
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
   * Onde procurar o marcador. Buscar no documento inteiro é o que produz falso
   * positivo (carrossel da home, banner de assinatura), então a busca fica
   * presa ao player. Se nenhum seletor de player casar — renomearam o
   * container — o <video> ainda existe, e subimos dele até um ancestral
   * plausível em vez de desistir.
   */
  function adRoot(ctx) {
    const player = ctx.getPlayer();
    if (player) return player;

    const video = ctx.getVideo();
    if (!video) return null;
    try {
      return video.closest('[class*="btm-media" i], [class*="player" i], [id*="player" i]') || video.parentElement;
    } catch {
      // `closest` com seletor recusado pelo Chrome antigo não pode derrubar o tick.
      return video.parentElement;
    }
  }

  /**
   * Procura o marcador de anúncio, começando pelo que casou da última vez:
   * durante o bloco o tick roda a cada mutação, e varrer a lista inteira toda
   * vez é desperdício.
   */
  function findAdMarker(ctx) {
    const st = ctx.adapterState;
    const root = adRoot(ctx);
    // Sem player montado não há o que mutar.
    if (!root) {
      st.adMarkerSelector = null;
      return null;
    }

    const first = st.adMarkerSelector;
    const ordered = first ? [first, ...AD_MARKERS.filter((sel) => sel !== first)] : AD_MARKERS;

    for (const sel of ordered) {
      const el = ctx.queryFirst([sel], root);
      if (!el || !looksLikeAdText(el)) continue;

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
   * guarda dos outros adapters. `[role="dialog"]` casa qualquer modal do site
   * (troca de perfil, controle parental, aviso de cobrança), e clique cego em
   * botão de diálogo é exatamente o que não fazemos. NUNCA remover a guarda.
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
      // Último recurso: nenhuma marcação conhecida casou. Sobrevive a
      // renomeação, que é o modo mais comum de tudo isso quebrar.
      ctx.clickByText(SKIP_FALLBACK_ROOTS, SKIP_INTRO_TEXT_RE);

    if (clicked) st.lastSkipClick = now;
    return clicked;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Navegação
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * O que está tocando aparece como `/video/<id>` no Disney+ e `/play/<id>` no
   * Star+ (e nos links antigos que ainda redirecionam pra lá).
   */
  function currentVideoId() {
    const match = /\/(?:video|play)\/([^/?#]+)/.exec(location.pathname);
    return match ? match[1] : location.pathname;
  }

  function resetCache(ctx) {
    const st = ctx.adapterState;
    st.adMarkerSelector = null;
    st.lastSkipClick = 0;
    st.stillWatchingWarned = false;
  }

  /**
   * O Disney+ navega por `pushState`, que não emite evento nenhum — o core só
   * escuta `popstate`, então passar pro próximo episódio pelo cartão de up-next
   * passaria batido. Comparar o id no tick é o sinal que sempre existe.
   */
  function syncLocation(ctx) {
    const st = ctx.adapterState;
    const id = currentVideoId();
    if (id === st.videoId) return;
    st.videoId = id;
    resetCache(ctx);
    ctx.log('navegou para', id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  globalThis.__PULA_ADAPTER__ = {
    id: 'disneyplus',
    label: 'Disney+',

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
     * quebrado. 45s já é anormal até pro Disney+, e o dump dos botões do player
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
      ctx.adapterState.videoId = null;
      resetCache(ctx);
    },
  };
})();
