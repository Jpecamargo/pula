/**
 * Adapter: Crunchyroll.
 *
 * O plano gratuito usa SSAI: o bloco comercial vem costurado no mesmo stream do
 * episódio. Não existe <video> separado, não existe botão de pular anúncio e o
 * player reverte qualquer avanço de `currentTime` dentro do bloco. Por isso
 * `clickSkipButton` e `fastForwardUnskippable` vêm desligados em `supports` —
 * prometer skip aqui só produziria loop de clique e um contador mentindo. O que
 * sobra, e funciona, é mutar o bloco, esconder o contador e clicar em
 * "Skip Intro" / "Skip Recap" / "Skip Credits" / "Next Episode".
 *
 * ─── O FATO MAIS IMPORTANTE DESTE ARQUIVO ──────────────────────────────────
 * O player do Crunchyroll (o "Vilos") roda dentro de um <iframe> servido de
 * `static.crunchyroll.com/vilos-v2/web/vilos/player.html` — que casa o padrão
 * `*://*.crunchyroll.com/*` do manifest, e com `all_frames: true` significa que
 * este arquivo roda DUAS vezes por aba, em dois documentos que não compartilham
 * nada:
 *
 *   - no frame de fora (`www.crunchyroll.com/watch/<id>/...`) existem a página
 *     da série, o cabeçalho e os banners, mas NÃO existe o <video>;
 *   - dentro do iframe existem o <video>, o contador de anúncio e os botões de
 *     skip, mas NÃO existe nada da página.
 *
 * Cada instância enxerga só metade do mundo e não alcança a outra (origens
 * diferentes, sem `postMessage` nosso). Portanto nada aqui pode assumir que o
 * <video> ou o player existem: no frame de fora `isAdShowing` volta false, o
 * adapter fica inerte e o único efeito útil é o CSS de `feedHideSelectors`.
 * Isso é de propósito, não é bug.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * O player exige login, então o DOM real não foi inspecionado. A divisão
 * honesta, pra quem for manter:
 *
 * CONFIRMADO — em uso por extensões/userscripts públicos:
 *   [data-testid="vilos-ad_label"] e a URL do iframe (userscript "Crunchyroll
 *   Skip Ads", theusaf); [title="Advertisement"] (mesmo userscript);
 *   [data-testid="skipIntroText"] (cr-autoskip); a varredura por
 *   [data-testid*="skip" i] e [role="button"][aria-label*="skip" i]
 *   (crunchyroll-auto-skip, cr-autoskip); [data-testid="vilos-large_play_
 *   pause_button"], que é o que estabelece a convenção `vilos-<coisa>` usada
 *   nos palpites abaixo.
 *
 * PALPITE — tudo marcado como tal: os seletores de player, de "próximo
 * episódio", os de feed e o diálogo de inatividade. Nenhuma fonte pública
 * nomeia um `data-testid` estável pra esses.
 *
 * Manutenção: com `debug: true` o log diz qual marcador casou; se nenhum casar,
 * o bloco passa sem mute. O dump do `console.warn` de stall lista os botões do
 * player durante o anúncio travado — é de lá que sai o seletor novo.
 *
 * Carregado ANTES do core.js; só se anuncia em globalThis.__PULA_ADAPTER__.
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // SELETORES
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Container do player. Só serve na página de fora e para o dump de stall —
   * dentro do iframe o documento INTEIRO é o player, e é por isso que `body`
   * aparece nos roots de fallback mais abaixo.
   */
  const PLAYER_SELECTORS = [
    '#vilosRoot',                     // palpite
    '[data-testid="vilos-player"]',   // palpite (convenção `vilos-*` confirmada)
    '#velocity-player-package',       // palpite
    '.video-player-wrapper',          // palpite: wrapper da página de fora
  ];

  /**
   * O <video> só existe dentro do iframe, onde nenhum wrapper conhecido casa —
   * quem resolve de fato é o fallback `video` genérico do core. A lista abaixo
   * existe só pro dia em que o player for renderizado direto na página.
   */
  const VIDEO_SELECTORS = ['#vilosRoot video', '.video-player-wrapper video'];

  /**
   * Marcadores de "tem anúncio tocando agora". Ordem = confiança.
   * Presença basta, sem checar renderização: nosso próprio CSS esconde parte
   * disso com `display:none`, que tira da tela mas mantém o nó no DOM — checar
   * renderização aqui faria a extensão cegar a si mesma. A exceção está logo
   * abaixo.
   */
  const AD_MARKER_SELECTORS = [
    '[data-testid="vilos-ad_label"]',    // confirmado: o "Anúncio (0:15)" do Vilos
    '[data-testid^="vilos-ad_"]',        // palpite: resto da mesma família
    '[data-testid^="vilos-ad-"]',        // palpite: variante com hífen
    '[data-testid*="ad_countdown" i]',   // palpite
    '[title="Advertisement"]',           // confirmado, mas exige a guarda abaixo
    // `*="ad"` fica FORA de propósito: casaria "load", "download", "shadow".
  ];

  /**
   * O único marcador que persiste no DOM entre os blocos — o userscript público
   * que o usa precisa checar `display` justamente porque ele fica lá, oculto,
   * com o anúncio parado. Presença dele não significa nada; renderização, sim.
   * Por isso ele também não entra em OVERLAY_HIDE_SELECTORS: se o nosso CSS o
   * escondesse, esta guarda nunca mais casaria.
   */
  const AD_ELEMENT_SELECTOR = '[title="Advertisement"]';

  /**
   * Escondidos via CSS quando `hideAdOverlays` está ligado. `display:none` não
   * remove o nó, então esconder o contador não atrapalha a detecção acima.
   *
   * NUNCA colocar aqui nada que case o botão de "Skip Intro"/"Next Episode":
   * `display:none` faz `isClickable()` voltar false e desligaria o `skipIntros`
   * em silêncio. Daí o prefixo `vilos-ad_`, que não alcança `skipIntroText`.
   */
  const OVERLAY_HIDE_SELECTORS = [
    '[data-testid="vilos-ad_label"]',
    '[data-testid^="vilos-ad_"]',   // palpite: contador/badge da mesma família
    '[data-testid^="vilos-ad-"]',   // palpite
  ];

  /**
   * Anúncios fora do player, na página de fora. Isto é só CSS: o anúncio carrega
   * normalmente e o detector de adblock do site não tem sinal pra disparar.
   * Os dois primeiros são containers genéricos do Google (GPT/AdSense), não
   * específicos do Crunchyroll; o resto é palpite sobre o prefixo `erc-`, que é
   * o dos componentes React do próprio site.
   */
  const FEED_HIDE_SELECTORS = [
    '[id^="google_ads_iframe"]',
    'ins.adsbygoogle',
    '[data-t="ad-banner"]',   // palpite (`data-t` é o atributo da página de fora)
    '.erc-ad-banner',         // palpite
  ];

  /**
   * "Skip Intro" / "Skip Recap" / "Skip Credits". O primeiro casa um <div> de
   * texto DENTRO do botão — quem sobe até o elemento clicável é o
   * `clickTargetFor` do core, então não precisamos do container aqui.
   * O `aria-label*="skip"` só pega UI em inglês; as outras línguas caem no
   * fallback por texto.
   */
  const INTRO_SKIP_SELECTORS = [
    '[data-testid="skipIntroText"]',
    '[data-testid*="skip" i]',
    '[role="button"][aria-label*="skip" i]',
    'button[aria-label*="skip" i]',
  ];

  /**
   * "Próximo episódio" — o cartão que aparece nos créditos. Só é clicado dentro
   * do player (ver `nextEpisodeRoot`): na página de fora existe a lista de
   * episódios, e clicar num item dela tiraria o usuário do episódio que ele
   * está assistindo agora.
   */
  const NEXT_EPISODE_SELECTORS = [
    '[data-testid="vilos-next_episode_button"]',   // palpite (convenção `vilos-*`)
    '[data-testid*="next_episode" i]',             // palpite
    '[data-testid*="nextEpisode" i]',              // palpite
  ];

  /**
   * Roots do fallback por texto — e também do dump de diagnóstico do core.
   * `body` é o último e é o que realmente funciona dentro do iframe, onde
   * nenhum wrapper conhecido casa. Varrer o documento inteiro só é aceitável
   * porque o regex abaixo é estreito.
   */
  const SKIP_FALLBACK_ROOTS = [
    '#vilosRoot',
    '[data-testid="vilos-player"]',
    '.video-player-wrapper',
    'body',
  ];
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
    '[data-testid*="vilos-skip" i]',
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
   * Estreito de propósito, em duas metades: verbo + substantivo (pt/en/es/fr/it)
   * e a ordem invertida do alemão ("Opening überspringen"). Um `/pular|skip/`
   * solto varrendo o `body` pegaria "Avançar 10s", "Pular anúncio" e o
   * "Próximo episódio" da barra de controle — este último de propósito fora
   * daqui, porque pular pro próximo episódio por semelhança de texto é
   * exatamente o tipo de clique que não fazemos às cegas.
   */
  const SKIP_INTRO_TEXT_RE =
    /\b(?:pular|skip|saltar|omitir|passer|salta|lewati)\b[\s'’a-z]{0,6}\b(?:in[íi]cio|intro(?:du[çc][ãa]o)?|abertura|opening|recap(?:itula[çc][ãa]o)?|r[ée]cap|resumen|resumo|riepilogo|cr[ée]dit(?:o|os|s)?|titoli|g[ée]n[ée]rique|outro|ending)\b|\b(?:opening|intro|credits|recap|abspann|r[üu]ckblick|zusammenfassung)\s+überspringen\b/i;

  /**
   * "Você ainda está assistindo?" — o prompt de inatividade pausa o player até
   * alguém confirmar. Container e botão são palpite; o que segura o clique é o
   * regex de texto, não o seletor.
   */
  const IDLE_DIALOG_SELECTORS = [
    '[data-testid*="still-watching" i]',   // palpite
    '[data-t*="still-watching" i]',        // palpite
    '[role="dialog"]',
  ];
  const IDLE_CONTINUE_SELECTORS = [
    '[data-testid*="continue" i]',   // palpite; só consultado DENTRO do diálogo
    '[data-t*="continue" i]',        // palpite; idem
  ];
  const CONTINUE_TEXT_RE =
    /ainda est[áa] (a[íi]|por a[íi]|assistindo)|continuar assistindo|continue watching|still (watching|there)|sigues (ah[íi]|viendo)|seguir viendo|toujours l[àa]|schaust du noch/i;

  /**
   * Texto do botão de confirmar. Existe porque nenhum `data-testid` do diálogo
   * é confirmado: sem ele o fallback seria "clique no primeiro botão do
   * diálogo", que pode ser o X de fechar ou pior. Aqui o botão precisa dizer o
   * que faz.
   */
  const CONTINUE_BUTTON_TEXT_RE =
    /continuar|continue|seguir|weiter|reprendre|sim|yes|estou aqui|i'?m here/i;

  /**
   * Intervalo mínimo entre dois cliques de skip. O botão some depois do clique,
   * mas o player remonta a árvore com frequência e o tick roda a cada mutação —
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
      // Ver AD_ELEMENT_SELECTOR: esse nó vive no DOM o tempo todo, só que oculto
      // fora do bloco — sem a checagem de renderização mutaríamos o episódio.
      if (sel === AD_ELEMENT_SELECTOR && el.getClientRects().length === 0) continue;

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
  // Diálogo de inatividade
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Confirmamos sozinhos, mas só depois de bater o texto do diálogo — mesma
   * guarda dos outros adapters. O botão de confirmação costuma ser o mesmo
   * componente de diálogos destrutivos (cancelar assinatura, remover da lista),
   * e clique cego em botão de diálogo é exatamente o que não fazemos. NUNCA
   * remover essa guarda.
   */
  /** Botão de confirmar quando nenhum `data-testid` casou — escolhido por texto. */
  function findContinueButton(ctx, dialog) {
    for (const btn of ctx.queryAll(['button', '[role="button"]'], dialog)) {
      const label = `${btn.textContent || ''} ${btn.getAttribute('aria-label') || ''}`;
      if (CONTINUE_BUTTON_TEXT_RE.test(label)) return btn;
    }
    return null;
  }

  function confirmStillWatching(ctx) {
    if (!ctx.can('skipContinueWatching')) return false;

    for (const dialog of ctx.queryAll(IDLE_DIALOG_SELECTORS)) {
      if (ctx.handledDialogs.has(dialog)) continue;
      if (!CONTINUE_TEXT_RE.test(dialog.textContent || '')) continue;

      const target = ctx.clickTargetFor(
        ctx.queryFirst(IDLE_CONTINUE_SELECTORS, dialog) || findContinueButton(ctx, dialog),
      );
      if (!target || !ctx.isClickable(target)) {
        // O texto bateu mas o botão não: sinal de que a estrutura mudou. Uma vez
        // por documento, senão vira spam a cada tick.
        if (!ctx.adapterState.idleDialogWarned) {
          ctx.adapterState.idleDialogWarned = true;
          ctx.log('diálogo de inatividade encontrado, botão não — revise IDLE_CONTINUE_SELECTORS');
        }
        continue;
      }

      // Marcado ANTES do clique: se o clique disparar uma mutação que reentra no
      // tick, o diálogo já está na lista e não leva um segundo clique.
      ctx.handledDialogs.add(dialog);
      target.click();
      ctx.log('diálogo de inatividade confirmado');
      return true;
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Abertura, recapitulação e próximo episódio
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Onde é seguro procurar o "próximo episódio".
   * Dentro do iframe do Vilos o documento inteiro é o player, então vale tudo.
   * Na página de fora só vale o que estiver DENTRO do player — a lista de
   * episódios da página tem links com o mesmo nome, e clicar num deles trocaria
   * o episódio no meio do que o usuário está assistindo.
   */
  function nextEpisodeRoot(ctx) {
    if (window.top !== window.self) return document;
    return ctx.getPlayer();
  }

  function clickSkipButtons(ctx) {
    if (!ctx.can('skipIntros')) return false;

    const st = ctx.adapterState;
    const now = performance.now();
    if (now - (st.lastSkipClick || 0) < SKIP_CLICK_COOLDOWN_MS) return false;

    const nextRoot = nextEpisodeRoot(ctx);
    const clicked =
      ctx.clickFirst(INTRO_SKIP_SELECTORS) ||
      (nextRoot ? ctx.clickFirst(NEXT_EPISODE_SELECTORS, nextRoot) : false) ||
      // Último recurso: nenhum data-testid conhecido casou. É o que sobrevive a
      // renomeação e o que cobre as línguas em que o `aria-label` não tem
      // "skip" (pt, es, fr, it, de).
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

  /**
   * `/watch/<id>` identifica o episódio na página de fora. Dentro do iframe não
   * existe esse caminho — e nem precisa: trocar de episódio troca o `src` do
   * iframe, o documento inteiro é descartado e o content script nasce de novo.
   */
  function currentWatchId() {
    const match = /\/watch\/([^/?#]+)/.exec(location.pathname);
    return match ? match[1] : location.pathname;
  }

  function resetCache(ctx) {
    const st = ctx.adapterState;
    st.adMarkerSelector = null;
    st.lastSkipClick = 0;
    st.idleDialogWarned = false;
  }

  /**
   * O Crunchyroll navega por `pushState`, que não emite evento nenhum — o core
   * só escuta `popstate`, então ir pro próximo episódio pelo cartão de post-play
   * passaria batido. Comparar o id no tick é o sinal que sempre existe.
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
    id: 'crunchyroll',
    label: 'Crunchyroll',

    playerSelectors: PLAYER_SELECTORS,
    videoSelectors: VIDEO_SELECTORS,

    /**
     * Vazio: no SSAI não existe botão de pular anúncio. Os botões de abertura e
     * próximo episódio moram em INTRO_SKIP_SELECTORS/NEXT_EPISODE_SELECTORS e
     * são clicados no `onTick`, FORA do bloco de anúncio — de propósito, pra que
     * uma detecção de anúncio errada nunca clique neles.
     */
    skipButtonSelectors: AD_SKIP_SELECTORS,
    skipTextRe: AD_SKIP_TEXT_RE,

    skipFallbackRoots: SKIP_FALLBACK_ROOTS,
    overlayHideSelectors: OVERLAY_HIDE_SELECTORS,
    feedHideSelectors: FEED_HIDE_SELECTORS,

    /**
     * O alarme de stall padrão (10s) dispararia em todo intervalo comercial:
     * aqui o anúncio durar é o comportamento normal, não sintoma de seletor
     * quebrado. 45s já é anormal até pro plano gratuito, e o dump dos botões do
     * player continua sendo a ferramenta de manutenção quando isso acontece.
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
      // O diálogo pausa o vídeo, então ele vem antes: com o player parado nenhum
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
