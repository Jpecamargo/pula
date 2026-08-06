/**
 * Pula — pula anúncios do YouTube por manipulação de DOM.
 *
 * Princípio: fazer exatamente o que você faria com o mouse (clicar no botão de
 * skip, fechar o overlay). Nada de webRequest, declarativeNetRequest ou
 * bloqueio de host — a página carrega o anúncio normalmente, então o detector
 * anti-adblock do YouTube não tem sinal pra disparar.
 *
 * Roda em ISOLATED world (padrão do MV3). Isso significa que a API interna do
 * player (`#movie_player.mute()`, `.getPlayerState()`, etc.) NÃO está acessível
 * — métodos que o YouTube pendura no elemento existem só no MAIN world. Por
 * isso o mute é feito direto em `<video>.muted`. Ver nota no final do arquivo.
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // CONFIG — cada comportamento é independente, desligue o que atrapalhar.
  // ───────────────────────────────────────────────────────────────────────────
  const CONFIG = {
    /** Clicar no botão "Pular anúncio" assim que ele existir no DOM. */
    clickSkipButton: true,

    /** Mutar o <video> enquanto o anúncio toca. */
    muteDuringAds: true,

    /**
     * Restaurar o áudio quando o anúncio acaba.
     * Só restaura se fomos NÓS que mutamos e você não mexeu no volume no meio.
     */
    restoreAudioAfterAd: true,

    /**
     * Anúncio não-pulável: joga o playhead pro fim (`currentTime = duration`)
     * pra que o próprio YouTube considere o anúncio consumido e siga adiante.
     */
    fastForwardUnskippable: true,

    /** Fallback do fast-forward: se o seek for ignorado, acelera o playback. */
    fastForwardFallbackRate: 16,

    /** Esconder banners/overlays sobre o player (CSS injetado). */
    hideAdOverlays: true,

    /** Esconder anúncios de feed, home, sidebar e masthead (CSS injetado). */
    hideFeedAds: true,

    /**
     * Rede de segurança: varredura periódica em ms, caso o MutationObserver
     * perca alguma transição. 0 desliga o intervalo.
     * OBS: timers são estrangulados pelo Chrome em aba de fundo — o observer
     * continua sendo o mecanismo principal e não sofre throttling.
     */
    safetyNetIntervalMs: 400,

    /** Logs no console prefixados com [Pula]. */
    debug: false,
  };

  // ───────────────────────────────────────────────────────────────────────────
  // SELETORES — a parte que quebra quando o YouTube renomeia classes.
  // Mantidos em arrays no topo justamente pra você editar sem ler o resto.
  // Ordem importa: o primeiro que casar e estiver clicável é usado.
  // ───────────────────────────────────────────────────────────────────────────

  /** Botões de "Pular anúncio" (layout moderno primeiro, legado depois). */
  const SKIP_BUTTON_SELECTORS = [
    '.ytp-skip-ad-button',                    // layout atual (2024+)
    '.ytp-ad-skip-button-modern',             // layout "modern"
    '.ytp-ad-skip-button',                    // legado
    '.ytp-ad-skip-button-container button',   // wrapper legado
    '.ytp-skip-ad-button__text',              // span interno; subimos pro botão
    '.ytp-ad-overlay-close-button',           // "x" do banner sobre o player
    '.ytp-ad-overlay-close-container',        // wrapper do "x"
  ];

  /** Container do player. Usado pra detectar o estado de anúncio. */
  const PLAYER_SELECTORS = ['#movie_player', '.html5-video-player'];

  /** O <video> principal. `.html5-main-video` evita pegar previews do feed. */
  const VIDEO_SELECTORS = [
    '#movie_player video.html5-main-video',
    '.html5-video-player video.html5-main-video',
    'video.html5-main-video',
  ];

  /**
   * Sinais de "tem anúncio rodando agora".
   * `.ad-showing` / `.ad-interrupting` são classes que o YouTube põe no player.
   */
  const AD_STATE_CLASSES = ['ad-showing', 'ad-interrupting'];

  /** Presença de qualquer um destes também conta como anúncio ativo. */
  const AD_PRESENCE_SELECTORS = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-player-overlay-layout',
    '.ad-showing',
  ];

  /** Overlays/banners sobre o player — escondidos via CSS. */
  const OVERLAY_HIDE_SELECTORS = [
    '.ytp-ad-overlay-slot',
    '.ytp-ad-overlay-container',
    '.ytp-ad-image-overlay',
    '.ytp-ad-text-overlay',
    '.video-ads.ytp-ad-module',
  ];

  /** Anúncios fora do player (feed, home, sidebar, shorts, masthead). */
  const FEED_HIDE_SELECTORS = [
    '#masthead-ad',
    '#player-ads',
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-banner-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-display-ad-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer',
    'ytd-companion-slot-renderer',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    'ytm-companion-ad-renderer',
    'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)',
  ];

  const STYLE_ID = 'pula-hide-ads';

  // ───────────────────────────────────────────────────────────────────────────
  // Estado
  // ───────────────────────────────────────────────────────────────────────────
  const state = {
    /** true entre o início e o fim de um anúncio. */
    adActive: false,
    /** true se o mute atual foi aplicado por nós (e portanto podemos desfazer). */
    mutedByUs: false,
    /** Timestamp até o qual um `volumechange` deve ser considerado nosso. */
    selfVolumeChangeUntil: 0,
    /** Referência ao <video> observado, pra reanexar listener se ele trocar. */
    video: null,
    /** playbackRate original, guardado antes do fallback de fast-forward. */
    originalRate: null,
    /** Coalescência de mutações num único tick. */
    tickScheduled: false,
  };

  const log = (...args) => {
    if (CONFIG.debug) console.log('%c[Pula]', 'color:#ff4d4d;font-weight:bold', ...args);
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers de DOM
  // ───────────────────────────────────────────────────────────────────────────

  /** Primeiro elemento que casar com qualquer seletor da lista. */
  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      let el = null;
      // :has() e outros seletores novos podem lançar em versões antigas do
      // Chrome — um seletor ruim não pode derrubar o loop inteiro.
      try {
        el = root.querySelector(sel);
      } catch (err) {
        log('seletor inválido, ignorando:', sel, err);
        continue;
      }
      if (el) return el;
    }
    return null;
  }

  const getPlayer = () => queryFirst(PLAYER_SELECTORS);
  const getVideo = () => queryFirst(VIDEO_SELECTORS);

  /**
   * Um elemento só é clicável se estiver realmente renderizado. O botão de skip
   * existe no DOM durante a contagem regressiva ("Pular em 5s") mas fica oculto
   * — clicar nele nessa hora é no-op e só polui.
   */
  function isClickable(el) {
    if (!el || el.disabled) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    return true;
  }

  /** Detecta anúncio ativo por classe no player OU pela presença do overlay. */
  function isAdShowing() {
    const player = getPlayer();
    if (player) {
      for (const cls of AD_STATE_CLASSES) {
        if (player.classList.contains(cls)) return true;
      }
    }
    return queryFirst(AD_PRESENCE_SELECTORS) !== null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Clicar no botão de skip
  // ───────────────────────────────────────────────────────────────────────────
  function clickSkipButton() {
    for (const sel of SKIP_BUTTON_SELECTORS) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch {
        continue;
      }
      if (!el) continue;

      // Alguns seletores casam um <span> interno; sobe pro elemento clicável.
      const target = el.closest('button, [role="button"], .ytp-ad-skip-button-container') || el;
      if (!isClickable(target)) continue;

      target.click();
      log('skip clicado via', sel);
      return true;
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Mute durante o anúncio, com respeito ao mute manual
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Marca uma janela curta durante a qual qualquer `volumechange` é atribuído a
   * nós. O evento é disparado em uma task separada, então um flag booleano
   * limpo de forma síncrona não funcionaria; a janela temporal é a heurística
   * pragmática aqui.
   */
  function setMutedByUs(video, value) {
    state.selfVolumeChangeUntil = performance.now() + 100;
    video.muted = value;
  }

  /**
   * Se você mexer no volume/mute durante o anúncio, abrimos mão do controle:
   * `mutedByUs = false` significa que não vamos restaurar nada no fim.
   */
  function onVolumeChange() {
    if (performance.now() < state.selfVolumeChangeUntil) return;
    if (state.mutedByUs) {
      log('volume alterado manualmente durante o anúncio — cedendo o controle');
      state.mutedByUs = false;
    }
  }

  /** Reanexa o listener se o YouTube trocar o elemento <video>. */
  function attachVideoListeners() {
    const video = getVideo();
    if (!video || video === state.video) return;
    if (state.video) state.video.removeEventListener('volumechange', onVolumeChange);
    video.addEventListener('volumechange', onVolumeChange);
    state.video = video;
    log('listener de volume anexado a novo <video>');
  }

  function muteForAd(video) {
    if (!CONFIG.muteDuringAds || !video) return;
    if (video.muted) return; // já estava mutado (por você) — não tocamos
    setMutedByUs(video, true);
    state.mutedByUs = true;
    log('mutado para o anúncio');
  }

  function restoreAudio(video) {
    if (!state.mutedByUs) return;
    state.mutedByUs = false;
    if (!CONFIG.restoreAudioAfterAd || !video) return;
    setMutedByUs(video, false);
    log('áudio restaurado');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Anúncio não-pulável: adiantar o playhead
  // ───────────────────────────────────────────────────────────────────────────
  function fastForwardAd(video) {
    if (!CONFIG.fastForwardUnskippable || !video) return;

    const duration = video.duration;
    // Live/DVR e streams ainda sem metadata dão Infinity ou NaN.
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (video.currentTime >= duration - 0.15) return;

    try {
      video.currentTime = duration;
    } catch (err) {
      log('seek recusado:', err);
    }

    // Se o player rejeitou o seek (buffer do anúncio ainda não baixado, ou o
    // YouTube reverteu o currentTime), acelera como plano B. Restaurado em
    // onAdEnd().
    if (video.currentTime < duration - 0.15 && CONFIG.fastForwardFallbackRate > 1) {
      if (state.originalRate === null) state.originalRate = video.playbackRate;
      if (video.playbackRate !== CONFIG.fastForwardFallbackRate) {
        video.playbackRate = CONFIG.fastForwardFallbackRate;
        log('seek ignorado — acelerando para', CONFIG.fastForwardFallbackRate + 'x');
      }
    }

    // Anúncio pausado nunca termina sozinho.
    if (video.paused) video.play().catch(() => {});
  }

  function restorePlaybackRate(video) {
    if (state.originalRate === null) return;
    if (video) video.playbackRate = state.originalRate;
    state.originalRate = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. CSS: esconder banners e overlays
  // ───────────────────────────────────────────────────────────────────────────
  function buildCss() {
    const groups = [];
    if (CONFIG.hideAdOverlays) groups.push(...OVERLAY_HIDE_SELECTORS);
    if (CONFIG.hideFeedAds) groups.push(...FEED_HIDE_SELECTORS);
    if (groups.length === 0) return '';
    return `${groups.join(',\n')} {\n  display: none !important;\n}\n`;
  }

  /**
   * Injetado em document_start, quando <head> normalmente ainda não existe —
   * daí o fallback pra documentElement. Idempotente: chamado de novo pelo tick
   * caso o YouTube remova o nó em alguma navegação.
   */
  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const css = buildCss();
    if (!css) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    log('CSS injetado');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Loop principal
  // ───────────────────────────────────────────────────────────────────────────
  function onAdStart(video) {
    log('anúncio detectado');
    muteForAd(video);
  }

  function onAdEnd(video) {
    log('anúncio terminou');
    restorePlaybackRate(video);
    restoreAudio(video);
  }

  function tick() {
    injectCss();
    attachVideoListeners();

    const video = state.video;
    const adShowing = isAdShowing();

    if (adShowing) {
      if (!state.adActive) {
        state.adActive = true;
        onAdStart(video);
      }
      // Tenta o skip primeiro: é instantâneo e o mais limpo dos dois caminhos.
      const skipped = CONFIG.clickSkipButton && clickSkipButton();
      // Só adianta o playhead se não deu pra pular (não-pulável ou ainda em
      // contagem regressiva). Barato o suficiente pra rodar todo tick.
      if (!skipped) fastForwardAd(video);
      return;
    }

    if (state.adActive) {
      state.adActive = false;
      onAdEnd(video);
    }
  }

  /**
   * Coalesce todas as mutações de um mesmo lote num único tick.
   * Microtask em vez de setTimeout/rAF de propósito: rAF congela em aba de
   * fundo e timers são estrangulados — microtask não.
   */
  function scheduleTick() {
    if (state.tickScheduled) return;
    state.tickScheduled = true;
    queueMicrotask(() => {
      state.tickScheduled = false;
      try {
        tick();
      } catch (err) {
        console.error('[Pula] erro no tick:', err);
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Bootstrap
  // ───────────────────────────────────────────────────────────────────────────

  injectCss();

  // Mecanismo principal. Observa documentElement (existe em document_start,
  // <body> não) e sobrevive a qualquer troca de subárvore da SPA.
  // attributeFilter em 'class' é o que pega a transição .ad-showing.
  const observer = new MutationObserver(scheduleTick);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'src'],
  });

  // Rede de segurança para transições que não geram mutação observável
  // (ex.: fim do anúncio sinalizado só por timeupdate).
  if (CONFIG.safetyNetIntervalMs > 0) {
    setInterval(scheduleTick, CONFIG.safetyNetIntervalMs);
  }

  // Navegação SPA. yt-navigate-finish é o evento canônico do polymer do
  // YouTube; os outros são redundância barata.
  for (const evt of ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'yt-player-updated']) {
    document.addEventListener(evt, () => {
      // Ao sair de uma página no meio de um anúncio, devolve o áudio antes que
      // o estado seja descartado.
      if (state.mutedByUs) restoreAudio(state.video);
      state.adActive = false;
      scheduleTick();
    }, true);
  }

  // O <video> emite eventos úteis mesmo quando o DOM está estável.
  for (const evt of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'playing']) {
    document.addEventListener(evt, scheduleTick, true); // capture: eventos de mídia não borbulham
  }

  scheduleTick();
  log('ativo');

  /**
   * NOTA — mute e a UI do player.
   * Mutamos `<video>.muted` diretamente. O YouTube guarda o estado de mute no
   * próprio state do player, então o ícone de volume da barra de controles pode
   * não refletir o mute durante o anúncio. Como a janela é de poucos segundos e
   * restauramos em seguida, na prática não incomoda.
   * Se quiser sincronia perfeita com a UI, mude o content script para
   * `"world": "MAIN"` no manifest e troque setMutedByUs por
   * `document.querySelector('#movie_player').mute() / .unMute()`.
   * Trade-off: MAIN world compartilha globais com o YouTube e depende de uma
   * API não-documentada — mais frágil que `<video>.muted`.
   */
})();
