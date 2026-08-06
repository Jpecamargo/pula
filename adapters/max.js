/**
 * Adapter: Max / HBO Max (mesmo player nos dois domínios).
 *
 * O plano com anúncios usa SSAI: o bloco publicitário vem costurado no mesmo
 * stream do título. Não existe <video> separado, não existe botão de pular e o
 * player reverte qualquer avanço de `currentTime` dentro do bloco — por isso
 * `clickSkipButton` e `fastForwardUnskippable` vêm desligados em `supports`.
 * Prometer skip aqui só produziria um loop de clique inútil e um contador
 * mentindo sobre tempo economizado. O que sobra, e funciona, é mutar o bloco,
 * esconder a barra/contador de publicidade e clicar em "Pular abertura" /
 * "Pular recapitulação" / "Próximo episódio".
 *
 * Ressalva que vale mais que qualquer seletor daqui: a UI foi reescrita várias
 * vezes desde o rebrand HBO Max → Max → HBO Max de novo. Quase tudo que se acha
 * na web sobre o DOM deste player descreve uma versão que já não existe. Por
 * isso o texto do botão é o caminho mais confiável neste adapter, e não o
 * último recurso que ele é nos outros.
 *
 * O player exige login, então NADA aqui foi verificado no DOM real. A divisão
 * honesta, pra quem for manter:
 *
 * CONFIRMADO — só o COMPORTAMENTO, não a marcação. Três extensões públicas e
 * ativas ("Auto Skip for Max", "HBOmax Skipper", "HBO Max - AutoSkip")
 * descrevem exatamente os botões "Skip Intro", "Skip Recap" e "Next Episode"
 * neste player. Ou seja: os rótulos existem e são clicáveis — é o que sustenta
 * SKIP_INTRO_TEXT_RE e NEXT_EPISODE_TEXT_RE. Nenhuma delas publica o seletor.
 *
 * DOCUMENTADO, não atribuído — `[class^="AdInfoBar-message-"]` e
 * `[class^="AdsContainer-"]` aparecem no userscript CHJ85/Stream-Assistant, que
 * casa `*.max.com` e `play.hbomax.com`. Mas o mesmo script casa outros 45 sites
 * e aplica esses seletores em todos, então nada garante que sejam daqui. Entram
 * como o palpite mais bem informado da lista, não como fato.
 *
 * PALPITE — todo o resto: container do player, `data-testid` de skip e de
 * próximo episódio, e o modal "ainda está assistindo?".
 *
 * Sobre classe: este player monta o CSS por CSS-in-JS, no formato
 * `Componente-parte-hash`. O prefixo semântico (`[class^="AdInfoBar-"]`) é
 * estável o bastante pra servir; o hash do fim, não — por isso nenhum seletor
 * aqui carrega hash, ao contrário do que se vê em listas de filtro por aí.
 *
 * Manutenção: com `debug: true`, o log informa qual marcador de anúncio casou.
 * Se nenhum casar, o bloco passa sem mute — inspecione a barra de publicidade
 * durante um anúncio, copie o `data-testid`/prefixo de classe e ponha no topo
 * de AD_MARKERS.
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
   * diagnóstico do core, então quanto mais estreito melhor: é o que impede um
   * carrossel da home de ser confundido com overlay do player. Tudo palpite.
   */
  const PLAYER_SELECTORS = [
    '[data-testid="player-ui"]',
    '[data-testid*="player-container" i]',
    '[class^="PlayerUI-"]',
    '[class^="PlayerContainer-"]',
    '[class*="player-container" i]',
  ];

  /**
   * Só seletor qualificado por `video`: o core usa o que vier daqui direto como
   * elemento de mídia (`.muted`, `.playbackRate`), e casar um <div> de nome
   * parecido quebraria mute e restauração em silêncio.
   */
  const VIDEO_SELECTORS = [
    '[data-testid="player-ui"] video',
    '[class^="PlayerUI-"] video',
    '[class*="player" i] video',
  ];

  /**
   * Palavras da barra/contador do bloco publicitário, em pt/en/es. Segunda
   * barreira contra falso positivo, junto com o dígito da contagem.
   */
  const AD_WORD_RE = /an[úu]ncio|publicidade|comercial|intervalo|advertisement|\bads?\b|anuncio/i;

  /**
   * Marcadores de "tem anúncio tocando AGORA", em ordem de confiança.
   *
   * Nenhum casa por `[class*="ad" i]` solto: "ad" aparece dentro de "loading",
   * "download", "header" e "shadow", e um marcador desses mutaria o filme
   * inteiro. Todos ancoram o "ad" num hífen ou numa palavra completa.
   *
   * Fica de fora, de propósito, qualquer coisa do tipo `ad-marker`/`ad-cue`: no
   * player esses são as marcações na barra de progresso mostrando ONDE ficam os
   * intervalos — existem o tempo todo, inclusive fora do anúncio, e mutariam o
   * episódio do começo ao fim.
   *
   * Também fica de fora `.abvsVideo`, que aparece junto dos dois primeiros no
   * userscript citado no cabeçalho: o nome sugere que ele é (ou envolve) o
   * próprio elemento de mídia, e tratá-lo como marcador arriscaria esconder o
   * player. Sem saber o que é, não entra.
   */
  const AD_MARKERS = [
    '[class^="AdInfoBar-"]',           // documentado, não atribuído (ver cabeçalho)
    '[class^="AdsContainer-"]',        // documentado, não atribuído
    '[data-testid*="ad-badge" i]',     // palpite
    '[data-testid*="ad-countdown" i]', // palpite
    '[data-testid*="ad-timer" i]',     // palpite
    '[data-testid*="ad-break" i]',     // palpite
    '[data-testid*="advertisement" i]',// palpite
    '[class^="AdCountdown-"]',         // palpite
    '[class^="AdBadge-"]',             // palpite
    '[class*="ad-countdown" i]',       // palpite
    '[class*="ad-badge" i]',           // palpite
    '[class*="advertisement" i]',      // palpite
    '[class*="commercial-break" i]',   // palpite
  ];

  /**
   * Escondidos via CSS quando `hideAdOverlays` está ligado. `display:none` não
   * remove o nó nem apaga o `textContent`, então esconder a barra não atrapalha
   * a detecção acima.
   *
   * A lista é só o que é claramente TEXTO/BADGE de publicidade. Dois cuidados:
   *
   * 1. `[class^="AdsContainer-"]` fica FORA. Ele é marcador de detecção, mas
   *    "container" pode muito bem envolver a área inteira do player durante o
   *    bloco — e no SSAI o anúncio toca no mesmo <video> do episódio, então
   *    `display:none` aí correria o risco de apagar a tela e a barra de
   *    controle junto. Esconder o que não se sabe o tamanho não compensa.
   * 2. Nada de "next"/"up next"/"skip" entra aqui. `display:none` reprova em
   *    `isClickable()`, então esconder o cartão de próximo episódio desligaria
   *    o `skipIntros` na surdina — o recurso pararia sem erro nenhum no log.
   */
  const OVERLAY_HIDE_SELECTORS = [
    '[class^="AdInfoBar-"]',
    '[data-testid*="ad-badge" i]',
    '[data-testid*="ad-countdown" i]',
    '[data-testid*="ad-timer" i]',
    '[class^="AdCountdown-"]',
    '[class^="AdBadge-"]',
    '[class*="ad-countdown" i]',
    '[class*="ad-badge" i]',
  ];

  /**
   * Vazio de propósito: fora do player o Max só mostra o próprio catálogo —
   * isso é promoção, não anúncio de terceiro, e o usuário não pediu pra sumir.
   * Se um dia aparecer faixa patrocinada de fora, é aqui que entra.
   */
  const FEED_HIDE_SELECTORS = [];

  /**
   * "Pular abertura" / "Pular recapitulação" / "Pular créditos" — o player usa
   * o mesmo botão pros três, mudando só o rótulo. Todos palpite; o que sustenta
   * este caminho de verdade é o fallback por texto lá embaixo.
   *
   * Nenhum `[class*="skip" i]` genérico: a barra de controle tem "avançar 10
   * segundos", que em várias UIs se chama justamente `skip-forward`.
   */
  const INTRO_SKIP_SELECTORS = [
    '[data-testid="skip-intro-button"]',
    '[data-testid*="skip-intro" i]',
    '[data-testid*="skip-recap" i]',
    '[data-testid*="skip-credits" i]',
    '[class^="SkipButton-"]',
    '[class*="skip-intro" i]',
    '[class*="skip-recap" i]',
  ];

  /**
   * "Próximo episódio". Só botão, nunca o container do cartão: o cartão de
   * up-next também traz um "dispensar", e `clickTargetFor()` cairia no primeiro
   * <button> de dentro dele — que pode ser exatamente o dispensar.
   *
   * Estes seletores só são consultados perto do fim do episódio (ver
   * `nearEnd()`), porque a barra de controle tem um botão de próximo episódio
   * com o mesmo nome e clicar nele no meio do episódio pularia o que o usuário
   * está assistindo.
   */
  const NEXT_EPISODE_SELECTORS = [
    '[data-testid="next-episode-button"]',
    '[data-testid*="up-next-play" i]',
    '[data-testid*="next-episode" i]',
    'button[class^="NextEpisode"]',
    'button[class^="UpNext"]',
  ];

  /**
   * Roots do fallback por texto — e também do dump de diagnóstico do core.
   * Aqui não existe container isolado de anúncio, então o root é o player
   * inteiro, o que inclui a barra de controle: daí os regex abaixo serem
   * estreitos.
   */
  const SKIP_FALLBACK_ROOTS = PLAYER_SELECTORS;

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
    '[class^="SkipAd"]',
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
   * Estreito de propósito, nos três idiomas em que a UI aparece (pt-BR, en,
   * es). Um `/pular|skip/` genérico varrendo o player pegaria "Avançar 10
   * segundos", "Pular para o fim" e o próprio "Próximo" da barra de controle.
   *
   * Cada alternativa exige o complemento (intro/recap/créditos): é o
   * complemento que separa "pular a abertura" de "pular o que estou assistindo".
   */
  const SKIP_INTRO_TEXT_RE =
    /pular (abertura|in[íi]cio|intro|introdu[çc][ãa]o|recapitula[çc][ãa]o|recap|resumo|cr[ée]ditos)|skip (intro|recap|credits|opening)|saltar (intro|resumen|cr[ée]ditos)|omitir (intro|resumen)/i;

  /**
   * "Próximo episódio" tem regex separado porque só pode ser usado sob a guarda
   * de `nearEnd()`. Exige a palavra "episódio"/"capítulo" junto: "Próximo"
   * sozinho é o botão da barra de controle e também aparece em carrossel.
   */
  const NEXT_EPISODE_TEXT_RE =
    /pr[óo]ximo (epis[óo]dio|cap[íi]tulo)|next episode|siguiente (episodio|cap[íi]tulo)/i;

  /**
   * Janela em que o cartão de próximo episódio faz sentido. O overlay de
   * autoplay aparece nos créditos, então clicar em "próximo episódio" só é o
   * que o usuário quer perto do fim; antes disso é destruir o que ele está
   * assistindo. Generoso porque crédito de série longa passa de um minuto.
   */
  const NEAR_END_SECONDS = 120;

  /**
   * "Você ainda está assistindo?". O modal pausa o vídeo até alguém confirmar.
   * Nenhum seletor confirmado, então o container é genérico e quem manda é o
   * texto.
   */
  const STILL_WATCHING_DIALOG_SELECTORS = [
    '[data-testid*="still-watching" i]',   // palpite
    '[data-testid*="are-you-still" i]',    // palpite
    '[class^="StillWatching"]',            // palpite
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
    '[class^="ContinueButton"]',     // palpite
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
   * Uma barra de anúncio tem número (tempo restante, "1 de 3") ou a palavra.
   * Nó pré-montado e vazio não passa — é o que separa "o player tem um lugar
   * pra barra de publicidade" de "o anúncio está tocando".
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
   * container, que aqui é o cenário mais provável de todos — o <video> ainda
   * existe, e subimos dele até um ancestral plausível em vez de desistir.
   */
  function adRoot(ctx) {
    const player = ctx.getPlayer();
    if (player) return player;

    const video = ctx.getVideo();
    if (!video) return null;
    try {
      return video.closest('[class*="player" i], [id*="player" i], [data-testid*="player" i]') || video.parentElement;
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
   * (troca de perfil, controle parental, aviso de cobrança, cancelar
   * assinatura), e clique cego em botão de diálogo é exatamente o que não
   * fazemos. NUNCA remover a guarda.
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

      // Marcado ANTES do clique: se o clique disparar uma mutação que reentra
      // no tick, o modal já está na lista e não leva um segundo clique.
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

  /**
   * Estamos nos créditos? Sem duração conhecida (live, metadata ainda não
   * chegou) a resposta é não: na dúvida, não clicar em nada que troque de
   * episódio.
   */
  function nearEnd(ctx, video) {
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return false;
    return ctx.remainingSeconds(video) <= NEAR_END_SECONDS;
  }

  function clickSkipButtons(ctx, video) {
    if (!ctx.can('skipIntros')) return false;

    const st = ctx.adapterState;
    const now = performance.now();
    if (now - (st.lastSkipClick || 0) < SKIP_CLICK_COOLDOWN_MS) return false;

    // Abertura/recap não precisam de guarda: o botão só existe enquanto o
    // trecho está passando.
    let clicked =
      ctx.clickFirst(INTRO_SKIP_SELECTORS) ||
      // Aqui o texto não é último recurso, é o caminho de maior confiança: os
      // rótulos são conhecidos, os seletores acima não (ver cabeçalho).
      ctx.clickByText(SKIP_FALLBACK_ROOTS, SKIP_INTRO_TEXT_RE);

    // Próximo episódio só perto do fim, seletor E texto: os dois caminhos
    // esbarram no botão homônimo da barra de controle, que no meio do episódio
    // pularia o que o usuário está assistindo.
    if (!clicked && nearEnd(ctx, video)) {
      clicked =
        ctx.clickFirst(NEXT_EPISODE_SELECTORS) ||
        ctx.clickByText(SKIP_FALLBACK_ROOTS, NEXT_EPISODE_TEXT_RE);
    }

    if (clicked) st.lastSkipClick = now;
    return clicked;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Navegação
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * O que está tocando aparece como `/video/watch/<id>` no max.com e
   * `/player/<id>` nos links antigos do hbomax.com que ainda circulam.
   */
  function currentVideoId() {
    const match = /\/(?:video\/watch|player|watch)\/([^/?#]+)/.exec(location.pathname);
    return match ? match[1] : location.pathname;
  }

  function resetCache(ctx) {
    const st = ctx.adapterState;
    st.adMarkerSelector = null;
    st.lastSkipClick = 0;
    st.stillWatchingWarned = false;
  }

  /**
   * O Max navega por `pushState`, que não emite evento nenhum — o core só
   * escuta `popstate`, então passar pro próximo episódio pelo cartão de autoplay
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
    id: 'max',
    label: 'Max',

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
     * quebrado. 45s já é anormal até pro Max, e o dump dos botões do player
     * continua sendo a ferramenta de manutenção quando isso acontece — nesta
     * UI, que muda de deploy em deploy, é a única forma prática de descobrir o
     * seletor novo.
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

    onTick(ctx, video) {
      syncLocation(ctx);
      // O modal pausa o vídeo, então ele vem antes: com o vídeo parado nenhum
      // botão de abertura chega a aparecer.
      confirmStillWatching(ctx);
      clickSkipButtons(ctx, video);
    },

    onNavigate(ctx) {
      // `syncLocation` refaz o resto no próximo tick, quando a URL nova já vale.
      ctx.adapterState.videoId = null;
      resetCache(ctx);
    },
  };
})();
