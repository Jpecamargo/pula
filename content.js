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
  // Os valores aqui são os padrões; o popup sobrescreve via chrome.storage.
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

    /** Confirmar sozinho o diálogo "Vídeo pausado. Continuar assistindo?". */
    skipContinueWatching: true,

    /** Fechar o modal de enforcement anti-adblock se ele aparecer. */
    dismissAdblockDialog: true,

    /**
     * Pular capítulos cujo título casa com SPONSOR_CHAPTER_RE.
     * Usa só os capítulos que o próprio vídeo declara no DOM — sem servidor,
     * sem requisição. Se o painel de capítulos não existir, é no-op.
     */
    skipSponsorChapters: true,

    /** Contar anúncios pulados e tempo economizado (chrome.storage.local). */
    collectStats: true,

    /**
     * Rede de segurança: varredura periódica em ms, caso o MutationObserver
     * perca alguma transição. 0 desliga o intervalo.
     * OBS: timers são estrangulados pelo Chrome em aba de fundo — o observer
     * continua sendo o mecanismo principal e não sofre throttling.
     */
    safetyNetIntervalMs: 400,

    /**
     * Se um anúncio continuar ativo por mais que isso sem que skip nem
     * fast-forward resolvam, logar um aviso com os candidatos a botão que
     * existem no DOM. É o alarme de "o YouTube renomeou as classes". 0 desliga.
     */
    stallWarnMs: 10000,

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

  /**
   * Fallback quando nenhum seletor acima casa: varrer botões DENTRO dos
   * containers de anúncio e escolher pelo texto. Sobrevive a renomeação de
   * classe, que é o modo mais comum da extensão quebrar.
   * Os roots são só containers de anúncio de propósito — varrer `#movie_player`
   * inteiro pegaria botões da barra de controle ("Avançar", "Pular pro fim").
   */
  const SKIP_FALLBACK_ROOTS = [
    '.video-ads',
    '.ytp-ad-module',
    '.ytp-ad-player-overlay',
    '.ytp-ad-player-overlay-layout',
  ];
  const SKIP_TEXT_RE = /pular|skip|ignorar|omitir|saltar/i;

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

  /**
   * Diálogo "Vídeo pausado. Continuar assistindo?". Confirmamos sozinhos, mas
   * só depois de conferir o texto — `#confirm-button` também é o botão de
   * diálogos destrutivos (apagar comentário, remover da playlist).
   */
  const CONFIRM_DIALOG_SELECTORS = [
    'yt-confirm-dialog-renderer',
    'tp-yt-paper-dialog',
    '.ytp-confirm-dialog-renderer',
  ];
  const CONTINUE_TEXT_RE =
    /continuar assistindo|v[íi]deo pausado|ainda est[áa] a[íi]|continue watching|video paused|still watching/i;
  const CONFIRM_BUTTON_SELECTORS = [
    '#confirm-button',
    '.ytp-confirm-dialog-confirm-button',
    'yt-button-renderer#confirm-button',
  ];

  /** Modal de enforcement anti-adblock ("Os bloqueadores não são permitidos"). */
  const ADBLOCK_DIALOG_SELECTORS = [
    'ytd-enforcement-message-view-model',
    'ytd-enforcement-message-renderer',
  ];
  const ADBLOCK_DISMISS_SELECTORS = [
    '#dismiss-button',
    '.dismiss-button',
    'button[aria-label*="Fechar"]',
    'button[aria-label*="Close"]',
  ];

  /** Itens do painel de capítulos. Só existem se o painel estiver montado. */
  const CHAPTER_ITEM_SELECTOR = 'ytd-macro-markers-list-item-renderer';
  const CHAPTER_TIME_SELECTORS = ['#time', '.macro-markers-list-item-time'];
  const CHAPTER_TITLE_SELECTORS = ['#details h4', 'h4', '#details'];
  /** Títulos de capítulo tratados como patrocínio. Edite à vontade. */
  const SPONSOR_CHAPTER_RE = /patroc[íi]n|sponsor|publicidade|propaganda|parceria|merch|anunciante/i;

  const STYLE_ID = 'pula-hide-ads';
  const STORAGE_CONFIG_KEY = 'config';
  const STORAGE_STATS_KEY = 'stats';

  // ───────────────────────────────────────────────────────────────────────────
  // Estado
  // ───────────────────────────────────────────────────────────────────────────
  const state = {
    /** true entre o início e o fim de um anúncio. */
    adActive: false,
    /** performance.now() do início do anúncio atual — base do aviso de stall. */
    adSince: 0,
    /** Evita repetir o aviso de stall e a contagem, ambos 1x por anúncio. */
    stallWarned: false,
    adCounted: false,
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
    /** Capítulos do vídeo atual, já com `end` calculado. */
    chapters: [],
    /** Chave de cache da lista de capítulos (vídeo + quantidade de itens). */
    chaptersKey: null,
    /** Vídeo a que `skippedChapters` se refere. */
    chaptersVideoId: null,
    /** Starts já pulados: se você voltar pro capítulo na mão, não insistimos. */
    skippedChapters: new Set(),
  };

  /** Diálogos já tratados — impede reclique em loop no mesmo nó. */
  const handledDialogs = new WeakSet();

  const log = (...args) => {
    if (CONFIG.debug) console.log('%c[Pula]', 'color:#ff4d4d;font-weight:bold', ...args);
  };

  // ───────────────────────────────────────────────────────────────────────────
  // Config persistida (popup) e estatísticas
  // ───────────────────────────────────────────────────────────────────────────

  /** chrome.storage some quando a extensão é recarregada com a aba aberta. */
  function storage() {
    try {
      return chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch {
      return null;
    }
  }

  /** Aplica só chaves conhecidas e do mesmo tipo — ignora lixo de versão antiga. */
  function applyStoredConfig(stored) {
    if (!stored || typeof stored !== 'object') return false;
    let changed = false;
    for (const [key, value] of Object.entries(stored)) {
      if (!Object.prototype.hasOwnProperty.call(CONFIG, key)) continue;
      if (typeof value !== typeof CONFIG[key]) continue;
      if (CONFIG[key] === value) continue;
      CONFIG[key] = value;
      changed = true;
    }
    return changed;
  }

  const pendingStats = { adsSkipped: 0, secondsSaved: 0, sponsorChaptersSkipped: 0 };
  let statsFlushTimer = null;

  /**
   * Acumula e grava em lote. Read-modify-write em vez de manter o total em
   * memória porque várias abas do YouTube podem estar contando ao mesmo tempo.
   */
  function bumpStat(key, amount = 1) {
    if (!CONFIG.collectStats || !storage()) return;
    if (!(key in pendingStats) || !(amount > 0)) return;
    pendingStats[key] += amount;
    if (statsFlushTimer !== null) return;
    statsFlushTimer = setTimeout(flushStats, 1000);
  }

  function flushStats() {
    statsFlushTimer = null;
    const local = storage();
    if (!local) return;
    const delta = { ...pendingStats };
    for (const key of Object.keys(pendingStats)) pendingStats[key] = 0;
    try {
      local.get(STORAGE_STATS_KEY, (res) => {
        if (chrome.runtime.lastError) return;
        const current = (res && res[STORAGE_STATS_KEY]) || {};
        const next = {};
        for (const key of Object.keys(delta)) {
          next[key] = (Number(current[key]) || 0) + delta[key];
        }
        try {
          local.set({ [STORAGE_STATS_KEY]: next }, () => void chrome.runtime.lastError);
        } catch {
          /* contexto da extensão invalidado */
        }
      });
    } catch {
      /* contexto da extensão invalidado */
    }
  }

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

  /** Todos os elementos que casarem, achatando a lista de seletores. */
  function queryAll(selectors, root = document) {
    const out = [];
    for (const sel of selectors) {
      try {
        out.push(...root.querySelectorAll(sel));
      } catch (err) {
        log('seletor inválido, ignorando:', sel, err);
      }
    }
    return out;
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

  /** Sobe do nó casado até o elemento que de fato aceita o clique. */
  function clickTargetFor(el) {
    if (!el) return null;
    return el.closest('button, [role="button"]') || el.querySelector('button, [role="button"]') || el;
  }

  /** Descrição curta de um nó, pro dump de diagnóstico. */
  function describe(el) {
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
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
    return clickSkipByText();
  }

  /**
   * Último recurso: nenhum seletor conhecido casou, então procuramos por texto
   * dentro dos containers de anúncio. Vale a lentidão porque roda só quando a
   * lista de seletores já falhou.
   */
  function clickSkipByText() {
    for (const rootSel of SKIP_FALLBACK_ROOTS) {
      let root;
      try {
        root = document.querySelector(rootSel);
      } catch {
        continue;
      }
      if (!root) continue;

      for (const el of queryAll(['button', '[role="button"]'], root)) {
        const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`;
        if (!SKIP_TEXT_RE.test(label)) continue;
        if (!isClickable(el)) continue;
        el.click();
        log('skip clicado pelo fallback de texto:', describe(el));
        return true;
      }
    }
    return false;
  }

  /**
   * Alarme de manutenção: o anúncio não sai e nada do que tentamos resolveu.
   * Dispara console.warn mesmo com debug desligado — é exatamente o momento em
   * que você precisa da informação, e sai no máximo uma vez por anúncio.
   */
  function warnStalledAd() {
    state.stallWarned = true;
    const candidates = [];
    for (const rootSel of SKIP_FALLBACK_ROOTS) {
      let root;
      try {
        root = document.querySelector(rootSel);
      } catch {
        continue;
      }
      if (!root) continue;
      for (const el of queryAll(['button', '[role="button"]'], root)) {
        candidates.push({
          seletor: describe(el),
          texto: (el.textContent || '').trim().slice(0, 60),
          clicavel: isClickable(el),
        });
      }
    }
    console.warn(
      `[Pula] anúncio ativo há mais de ${CONFIG.stallWarnMs}ms e nem o skip nem o ` +
        'fast-forward resolveram. Os seletores provavelmente mudaram — os candidatos ' +
        'abaixo saíram dos containers de anúncio; adicione o certo no topo de ' +
        'SKIP_BUTTON_SELECTORS.',
      candidates,
    );
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

  /** Segundos que ainda faltam do que está tocando (0 se a duração é opaca). */
  function remainingSeconds(video) {
    if (!video || !Number.isFinite(video.duration)) return 0;
    return Math.max(0, video.duration - video.currentTime);
  }

  /**
   * Adianta o anúncio e contabiliza o que isso economizou. Quem conta é aqui, e
   * não o `tick()`, porque quanto se economiza depende de qual dos dois
   * caminhos pegou — e só esta função sabe disso.
   *
   * `remaining` vem medido de fora de propósito: depois do seek o `currentTime`
   * já é o do fim do anúncio, e a conta sairia zerada.
   *
   * @returns true se conseguiu de fato adiantar o anúncio.
   */
  function fastForwardAd(video, remaining) {
    if (!CONFIG.fastForwardUnskippable || !video) return false;

    const duration = video.duration;
    // Live/DVR e streams ainda sem metadata dão Infinity ou NaN.
    if (!Number.isFinite(duration) || duration <= 0) return false;
    if (video.currentTime >= duration - 0.15) return false;

    try {
      video.currentTime = duration;
    } catch (err) {
      log('seek recusado:', err);
    }

    const seeked = video.currentTime >= duration - 0.15;

    // Se o player rejeitou o seek (buffer do anúncio ainda não baixado, ou o
    // YouTube reverteu o currentTime), acelera como plano B. Restaurado em
    // onAdEnd().
    if (!seeked && CONFIG.fastForwardFallbackRate > 1) {
      if (state.originalRate === null) state.originalRate = video.playbackRate;
      if (video.playbackRate !== CONFIG.fastForwardFallbackRate) {
        video.playbackRate = CONFIG.fastForwardFallbackRate;
        log('seek ignorado — acelerando para', CONFIG.fastForwardFallbackRate + 'x');
      }
      // O anúncio acelerado ainda toca até o fim: economizamos só a fração que
      // a aceleração corta, não o restante inteiro.
      countAd(remaining * (1 - 1 / CONFIG.fastForwardFallbackRate));
    }

    if (seeked) countAd(remaining);

    // Anúncio pausado nunca termina sozinho.
    if (video.paused) video.play().catch(() => {});

    return seeked;
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

  /** Toggle no popup mudou de valor: o CSS já injetado precisa ser refeito. */
  function refreshCss() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    injectCss();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Diálogos: "continuar assistindo" e modal anti-adblock
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * O YouTube pausa o vídeo e pergunta se você ainda está aí. Confirmamos, mas
   * só depois de bater o texto: `#confirm-button` é compartilhado com diálogos
   * destrutivos e um clique cego neles seria bem pior que o incômodo.
   */
  function confirmContinueWatching() {
    if (!CONFIG.skipContinueWatching) return false;

    for (const dialog of queryAll(CONFIRM_DIALOG_SELECTORS)) {
      if (handledDialogs.has(dialog)) continue;
      if (!CONTINUE_TEXT_RE.test(dialog.textContent || '')) continue;

      const target = clickTargetFor(queryFirst(CONFIRM_BUTTON_SELECTORS, dialog));
      if (!target || !isClickable(target)) continue;

      handledDialogs.add(dialog);
      target.click();
      log('diálogo "continuar assistindo" confirmado');
      return true;
    }
    return false;
  }

  /**
   * Modal de enforcement anti-adblock. Não bloqueamos rede, então ele só
   * aparece por falso positivo — mas quando aparece, trava a página inteira.
   * Preferimos o botão de fechar; se não houver, removemos o diálogo na mão e
   * desfazemos o que ele deixa pra trás (backdrop e scroll travado).
   */
  function dismissAdblockDialog() {
    if (!CONFIG.dismissAdblockDialog) return false;

    const dialog = queryFirst(ADBLOCK_DIALOG_SELECTORS);
    if (!dialog || handledDialogs.has(dialog)) return false;
    handledDialogs.add(dialog);

    const target = clickTargetFor(queryFirst(ADBLOCK_DISMISS_SELECTORS, dialog));
    if (target && isClickable(target)) {
      target.click();
      log('modal anti-adblock fechado no botão');
    } else {
      (dialog.closest('tp-yt-paper-dialog') || dialog).remove();
      log('modal anti-adblock removido do DOM');
    }

    for (const backdrop of queryAll(['tp-yt-iron-overlay-backdrop'])) backdrop.remove();
    if (document.body) document.body.style.setProperty('overflow', 'auto', 'important');

    // O modal pausa o vídeo ao abrir; como acabamos de fechá-lo, retomar é a
    // continuação do mesmo gesto.
    const video = getVideo();
    if (video && video.paused) video.play().catch(() => {});
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Capítulos patrocinados
  // ───────────────────────────────────────────────────────────────────────────

  function currentVideoId() {
    try {
      return new URL(location.href).searchParams.get('v') || location.pathname;
    } catch {
      return location.pathname;
    }
  }

  /** "1:02:03" → 3723. Null se o texto não for um timestamp. */
  function parseTimestamp(text) {
    const parts = String(text || '').trim().split(':');
    if (parts.length === 0 || parts.length > 3) return null;
    let total = 0;
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isFinite(n) || part.trim() === '') return null;
      total = total * 60 + n;
    }
    return total;
  }

  /**
   * Lê os capítulos do painel lateral. Fonte local de propósito: é o mesmo dado
   * que o SponsorBlock traria de um servidor, só que sem rede e sem terceiros.
   * Se o painel não estiver montado, `state.chapters` fica vazio e a feature
   * simplesmente não faz nada.
   */
  function refreshChapters(video) {
    if (!CONFIG.skipSponsorChapters) return;

    const videoId = currentVideoId();
    if (videoId !== state.chaptersVideoId) {
      state.chaptersVideoId = videoId;
      state.skippedChapters.clear();
      state.chapters = [];
      state.chaptersKey = null;
    }

    const items = queryAll([CHAPTER_ITEM_SELECTOR]);
    const key = `${videoId}|${items.length}`;
    if (key === state.chaptersKey) return;

    const parsed = [];
    for (const item of items) {
      const start = parseTimestamp((queryFirst(CHAPTER_TIME_SELECTORS, item) || {}).textContent);
      if (start === null) continue;
      const titleEl = queryFirst(CHAPTER_TITLE_SELECTORS, item);
      const title = ((titleEl && titleEl.textContent) || '').trim();
      parsed.push({ start, title, sponsor: SPONSOR_CHAPTER_RE.test(title) });
    }
    parsed.sort((a, b) => a.start - b.start);

    const total = video && Number.isFinite(video.duration) ? video.duration : Infinity;
    parsed.forEach((ch, i) => {
      ch.end = i + 1 < parsed.length ? parsed[i + 1].start : total;
    });

    state.chapters = parsed;
    // Sem duração ainda (metadata não chegou) o último capítulo fica sem fim —
    // não cacheia, pra reparsear quando `durationchange` disparar.
    state.chaptersKey = Number.isFinite(total) ? key : null;

    const sponsors = parsed.filter((ch) => ch.sponsor);
    if (sponsors.length) log('capítulos patrocinados detectados:', sponsors.map((ch) => ch.title));
  }

  function skipSponsorChapters(video) {
    if (!CONFIG.skipSponsorChapters || !video || state.chapters.length === 0) return;

    const t = video.currentTime;
    for (const ch of state.chapters) {
      if (!ch.sponsor || !Number.isFinite(ch.end)) continue;
      // Já pulamos este uma vez: se você voltou pra lá na mão, foi de propósito.
      if (state.skippedChapters.has(ch.start)) continue;
      if (t < ch.start || t >= ch.end - 0.3) continue;

      state.skippedChapters.add(ch.start);
      video.currentTime = ch.end;
      bumpStat('sponsorChaptersSkipped', 1);
      bumpStat('secondsSaved', ch.end - t);
      log('capítulo patrocinado pulado:', ch.title);
      return;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Loop principal
  // ───────────────────────────────────────────────────────────────────────────
  function onAdStart(video) {
    log('anúncio detectado');
    state.adSince = performance.now();
    state.stallWarned = false;
    state.adCounted = false;
    muteForAd(video);
  }

  function onAdEnd(video) {
    log('anúncio terminou');
    restorePlaybackRate(video);
    restoreAudio(video);
  }

  /** Contabiliza o anúncio uma única vez, com o tempo que faltava dele. */
  function countAd(remaining) {
    if (state.adCounted) return;
    state.adCounted = true;
    bumpStat('adsSkipped', 1);
    bumpStat('secondsSaved', remaining);
  }

  function tick() {
    injectCss();
    attachVideoListeners();
    dismissAdblockDialog();

    const video = state.video;
    const adShowing = isAdShowing();

    if (adShowing) {
      if (!state.adActive) {
        state.adActive = true;
        onAdStart(video);
      }
      // Medido antes de agir: depois do skip a duração já é a do vídeo real.
      const remaining = remainingSeconds(video);
      // Tenta o skip primeiro: é instantâneo e o mais limpo dos dois caminhos.
      // Cada caminho contabiliza o que economizou — `countAd` ignora o segundo.
      if (CONFIG.clickSkipButton && clickSkipButton()) {
        countAd(remaining);
      } else {
        // Só adianta o playhead se não deu pra pular (não-pulável ou ainda em
        // contagem regressiva). Barato o suficiente pra rodar todo tick.
        fastForwardAd(video, remaining);
      }

      if (
        CONFIG.stallWarnMs > 0 &&
        !state.stallWarned &&
        performance.now() - state.adSince > CONFIG.stallWarnMs
      ) {
        warnStalledAd();
      }
      return;
    }

    if (state.adActive) {
      state.adActive = false;
      onAdEnd(video);
    }

    confirmContinueWatching();
    refreshChapters(video);
    skipSponsorChapters(video);
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

  // A config do popup chega assíncrona; até lá valem os padrões acima. Como o
  // CSS já foi injetado em document_start, refazemos se algum toggle mudar.
  const local = storage();
  if (local) {
    try {
      local.get(STORAGE_CONFIG_KEY, (res) => {
        if (chrome.runtime.lastError) return;
        if (applyStoredConfig(res && res[STORAGE_CONFIG_KEY])) {
          refreshCss();
          scheduleTick();
        }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_CONFIG_KEY]) return;
        // Aplicado ao vivo: mexer no popup não exige recarregar a aba.
        if (applyStoredConfig(changes[STORAGE_CONFIG_KEY].newValue)) {
          refreshCss();
          scheduleTick();
        }
      });
    } catch {
      /* contexto da extensão invalidado */
    }
  }

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
