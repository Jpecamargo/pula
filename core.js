/**
 * Pula — motor genérico. Tudo que não é específico de um streaming mora aqui.
 *
 * Princípio (vale pra todo adapter): fazer exatamente o que você faria com o
 * mouse — clicar no botão de skip, fechar o overlay, mutar. Nada de
 * webRequest, declarativeNetRequest ou bloqueio de host: a página carrega o
 * anúncio normalmente, então nenhum detector de adblock tem sinal pra disparar.
 * Qualquer adapter que introduza bloqueio de rede quebra esse princípio.
 *
 * Roda em ISOLATED world (padrão do MV3): a API interna dos players
 * (`#movie_player.mute()` e equivalentes) NÃO está acessível. Por isso o mute é
 * feito direto em `<video>.muted`. Ver nota no final do arquivo.
 *
 * O adapter do site é injetado ANTES deste arquivo (ver ordem do `js` no
 * manifest) e se anuncia em `globalThis.__PULA_ADAPTER__`. Sem adapter, este
 * arquivo não faz nada — é o que garante que uma entrada errada no manifest
 * falhe em silêncio em vez de quebrar a página.
 */
(() => {
  'use strict';

  const adapter = globalThis.__PULA_ADAPTER__;
  if (!adapter || typeof adapter.isAdShowing !== 'function') return;

  // ───────────────────────────────────────────────────────────────────────────
  // CONFIG — cada comportamento é independente, desligue o que atrapalhar.
  // Os valores aqui são os padrões globais; o adapter sobrescreve o que não faz
  // sentido no site dele (`adapter.configDefaults`) e o popup sobrescreve tudo
  // via chrome.storage.
  // ───────────────────────────────────────────────────────────────────────────
  const CONFIG = {
    /** Clicar no botão de pular anúncio assim que ele existir no DOM. */
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
     * pra que o player considere o anúncio consumido e siga adiante.
     * Só funciona onde o anúncio é um vídeo separado (YouTube). Em streaming com
     * SSAI o anúncio é o mesmo stream do conteúdo e o adapter desliga isto.
     */
    fastForwardUnskippable: true,

    /** Fallback do fast-forward: se o seek for ignorado, acelera o playback. */
    fastForwardFallbackRate: 16,

    /** Esconder banners/overlays sobre o player (CSS injetado). */
    hideAdOverlays: true,

    /** Esconder anúncios fora do player: feed, home, sidebar (CSS injetado). */
    hideFeedAds: true,

    /** Confirmar sozinho diálogos do tipo "ainda está aí?" / "continuar?". */
    skipContinueWatching: true,

    /** Fechar modais de enforcement anti-adblock se aparecerem. */
    dismissAdblockDialog: true,

    /** Pular capítulos/segmentos declarados como patrocínio pelo próprio site. */
    skipSponsorChapters: true,

    /** Clicar em "Pular abertura" / "Pular recapitulação" / "Próximo episódio". */
    skipIntros: true,

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
     * Se um anúncio continuar ativo por mais que isso sem que nada resolva,
     * logar um aviso com os candidatos a botão que existem no DOM. É o alarme de
     * "o site renomeou as classes". 0 desliga.
     */
    stallWarnMs: 10000,

    /** Logs no console prefixados com [Pula]. */
    debug: false,

    /**
     * Liga/desliga por streaming, indexado por `adapter.id`.
     * Chave ausente = ligado. O popup grava aqui.
     */
    sites: {},
  };

  Object.assign(CONFIG, adapter.configDefaults || {});

  /**
   * O que o site realmente permite. O adapter declara `false` no que não dá pra
   * fazer lá — não adianta o toggle estar ligado se o comportamento é impossível
   * (ex.: seek pra frente em anúncio SSAI, que o player simplesmente reverte).
   * Chave ausente = suportado.
   */
  const SUPPORTS = adapter.supports || {};
  const can = (key) => CONFIG[key] === true && SUPPORTS[key] !== false;

  const STYLE_ID = 'pula-hide-ads';
  const STORAGE_CONFIG_KEY = 'config';
  const STORAGE_STATS_KEY = 'stats';

  /** Texto de botão de skip, em pt/en/es. O adapter pode substituir. */
  const SKIP_TEXT_RE = adapter.skipTextRe || /pular|skip|ignorar|omitir|saltar|dispensar/i;

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
  };

  /** Bag livre do adapter. O core nunca lê daqui — evita colisão de chave. */
  const adapterState = {};

  /** Diálogos já tratados — impede reclique em loop no mesmo nó. */
  const handledDialogs = new WeakSet();

  const log = (...args) => {
    if (CONFIG.debug) {
      console.log(`%c[Pula:${adapter.id}]`, 'color:#ff4d4d;font-weight:bold', ...args);
    }
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
      // `sites` é o único objeto do CONFIG: mescla em vez de comparar por valor.
      if (key === 'sites') {
        if (!value || typeof value !== 'object') continue;
        for (const [site, on] of Object.entries(value)) {
          if (typeof on !== 'boolean' || CONFIG.sites[site] === on) continue;
          CONFIG.sites[site] = on;
          changed = true;
        }
        continue;
      }
      if (typeof value !== typeof CONFIG[key]) continue;
      if (CONFIG[key] === value) continue;
      CONFIG[key] = value;
      changed = true;
    }
    return changed;
  }

  /** Este streaming está ligado no popup? Chave ausente = ligado. */
  const siteEnabled = () => CONFIG.sites[adapter.id] !== false;

  const pendingStats = { adsSkipped: 0, secondsSaved: 0, sponsorChaptersSkipped: 0 };
  let statsFlushTimer = null;

  /**
   * Acumula e grava em lote. Read-modify-write em vez de manter o total em
   * memória porque várias abas (e agora vários sites) podem estar contando ao
   * mesmo tempo.
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
  // Helpers de DOM — também expostos ao adapter via ctx
  // ───────────────────────────────────────────────────────────────────────────

  /** Primeiro elemento que casar com qualquer seletor da lista. */
  function queryFirst(selectors, root = document) {
    for (const sel of selectors || []) {
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
    for (const sel of selectors || []) {
      try {
        out.push(...root.querySelectorAll(sel));
      } catch (err) {
        log('seletor inválido, ignorando:', sel, err);
      }
    }
    return out;
  }

  const getPlayer = () => queryFirst(adapter.playerSelectors);
  const getVideo = () => queryFirst(adapter.videoSelectors) || document.querySelector('video');

  /**
   * Um elemento só é clicável se estiver realmente renderizado. O botão de skip
   * costuma existir no DOM durante a contagem regressiva ("Pular em 5s") mas
   * fica oculto — clicar nele nessa hora é no-op.
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
    return el.closest('button, [role="button"], a') || el.querySelector('button, [role="button"]') || el;
  }

  /** Descrição curta de um nó, pro dump de diagnóstico. */
  function describe(el) {
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '';
    const label = el.getAttribute && el.getAttribute('data-uia') ? `[data-uia="${el.getAttribute('data-uia')}"]` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}${label}`;
  }

  /**
   * Clica no primeiro seletor da lista que estiver clicável.
   * É o helper que os adapters usam pra "pular abertura", "próximo episódio" e
   * afins — o padrão try/catch por seletor já vem embutido.
   */
  function clickFirst(selectors, root = document) {
    for (const sel of selectors || []) {
      let el;
      try {
        el = root.querySelector(sel);
      } catch {
        continue;
      }
      if (!el) continue;
      const target = clickTargetFor(el);
      if (!isClickable(target)) continue;
      target.click();
      log('clique em', sel);
      return true;
    }
    return false;
  }

  /** Varre botões dentro de `roots` e clica no primeiro cujo texto casar. */
  function clickByText(roots, textRe, { silent = false } = {}) {
    for (const rootSel of roots || []) {
      let root;
      try {
        root = document.querySelector(rootSel);
      } catch {
        continue;
      }
      if (!root) continue;

      for (const el of queryAll(['button', '[role="button"]', 'a'], root)) {
        const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`;
        if (!textRe.test(label)) continue;
        if (!isClickable(el)) continue;
        el.click();
        if (!silent) log('clique pelo fallback de texto:', describe(el));
        return true;
      }
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Clicar no botão de skip
  // ───────────────────────────────────────────────────────────────────────────
  function clickSkipButton() {
    for (const sel of adapter.skipButtonSelectors || []) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch {
        continue;
      }
      if (!el) continue;

      // Alguns seletores casam um <span> interno; sobe pro elemento clicável.
      const target = clickTargetFor(el);
      if (!isClickable(target)) continue;

      target.click();
      log('skip clicado via', sel);
      return true;
    }
    // Último recurso: nenhum seletor conhecido casou, então procuramos por texto
    // dentro dos containers de anúncio. Sobrevive a renomeação de classe, que é
    // o modo mais comum da extensão quebrar.
    return clickByText(adapter.skipFallbackRoots, SKIP_TEXT_RE);
  }

  /**
   * Alarme de manutenção: o anúncio não sai e nada do que tentamos resolveu.
   * Dispara console.warn mesmo com debug desligado — é exatamente o momento em
   * que você precisa da informação, e sai no máximo uma vez por anúncio.
   *
   * Nos streamings que não são o YouTube este dump é a principal ferramenta:
   * os seletores dos players com login não dá pra verificar de fora, então o
   * caminho real de manutenção é ler os candidatos daqui.
   */
  function warnStalledAd() {
    state.stallWarned = true;
    const roots = (adapter.skipFallbackRoots || []).concat(adapter.playerSelectors || []);
    const candidates = [];
    for (const rootSel of roots) {
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
          rotulo: (el.getAttribute('aria-label') || '').slice(0, 60),
          clicavel: isClickable(el),
        });
      }
    }
    console.warn(
      `[Pula:${adapter.id}] anúncio ativo há mais de ${CONFIG.stallWarnMs}ms e nada resolveu. ` +
        'Os seletores provavelmente mudaram — os candidatos abaixo saíram dos containers de ' +
        `anúncio e do player; adicione o certo no topo de skipButtonSelectors em adapters/${adapter.id}.js.`,
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

  /** Reanexa o listener se o site trocar o elemento <video>. */
  function attachVideoListeners() {
    const video = getVideo();
    if (!video || video === state.video) return;
    if (state.video) state.video.removeEventListener('volumechange', onVolumeChange);
    video.addEventListener('volumechange', onVolumeChange);
    state.video = video;
    log('listener de volume anexado a novo <video>');
  }

  function muteForAd(video) {
    if (!can('muteDuringAds') || !video) return;
    if (video.muted) return; // já estava mutado (por você) — não tocamos
    setMutedByUs(video, true);
    state.mutedByUs = true;
    log('mutado para o anúncio');
  }

  function restoreAudio(video) {
    if (!state.mutedByUs) return;
    state.mutedByUs = false;
    if (!can('restoreAudioAfterAd') || !video) return;
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
    if (!can('fastForwardUnskippable') || !video) return false;

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
    // site reverteu o currentTime), acelera como plano B. Restaurado em
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
    if (can('hideAdOverlays')) groups.push(...(adapter.overlayHideSelectors || []));
    if (can('hideFeedAds')) groups.push(...(adapter.feedHideSelectors || []));
    let css = groups.length ? `${groups.join(',\n')} {\n  display: none !important;\n}\n` : '';
    // CSS que não é só `display:none` (ex.: destravar scroll, esconder overlay
    // sem tirar do fluxo) fica a cargo do adapter.
    if (typeof adapter.extraCss === 'function') css += adapter.extraCss(CONFIG) || '';
    return css;
  }

  /**
   * Injetado em document_start, quando <head> normalmente ainda não existe —
   * daí o fallback pra documentElement. Idempotente: chamado de novo pelo tick
   * caso o site remova o nó em alguma navegação.
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
    if (siteEnabled()) injectCss();
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
    if (typeof adapter.onAdStart === 'function') adapter.onAdStart(ctx, video);
  }

  function onAdEnd(video) {
    log('anúncio terminou');
    restorePlaybackRate(video);
    restoreAudio(video);
    if (typeof adapter.onAdEnd === 'function') adapter.onAdEnd(ctx, video);
  }

  /** Contabiliza o anúncio uma única vez, com o tempo que faltava dele. */
  function countAd(remaining) {
    if (state.adCounted) return;
    state.adCounted = true;
    bumpStat('adsSkipped', 1);
    bumpStat('secondsSaved', remaining);
  }

  /**
   * Contexto entregue ao adapter. É a única superfície que os adapters usam —
   * mantenha estável, cada streaming depende dela.
   */
  const ctx = {
    id: adapter.id,
    CONFIG,
    can,
    state,
    adapterState,
    handledDialogs,
    log,
    queryFirst,
    queryAll,
    clickFirst,
    clickByText,
    isClickable,
    clickTargetFor,
    describe,
    getPlayer,
    getVideo,
    remainingSeconds,
    bumpStat,
    countAd,
  };

  function tick() {
    if (!siteEnabled()) return;

    injectCss();
    attachVideoListeners();

    const video = state.video;
    const adShowing = !!adapter.isAdShowing(ctx);

    if (adShowing) {
      if (!state.adActive) {
        state.adActive = true;
        onAdStart(video);
      }
      // Medido antes de agir: depois do skip a duração já é a do vídeo real.
      const remaining = remainingSeconds(video);

      // O adapter tem a primeira palavra durante o anúncio: alguns sites têm um
      // caminho próprio (botão em shadow DOM, contador em iframe) que o
      // pipeline genérico não alcança. `true` = ele resolveu, não insistimos.
      const handled =
        typeof adapter.onAdTick === 'function' && adapter.onAdTick(ctx, { video, remaining }) === true;

      // Tenta o skip: é instantâneo e o mais limpo dos caminhos.
      // Cada caminho contabiliza o que economizou — `countAd` ignora o segundo.
      if (!handled) {
        if (can('clickSkipButton') && clickSkipButton()) {
          countAd(remaining);
        } else {
          // Só adianta o playhead se não deu pra pular. Barato o suficiente pra
          // rodar todo tick.
          fastForwardAd(video, remaining);
        }
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

    // Fora de anúncio: diálogos, "pular abertura", capítulos patrocinados.
    if (typeof adapter.onTick === 'function') adapter.onTick(ctx, video);
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
        console.error(`[Pula:${adapter.id}] erro no tick:`, err);
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
          // Desligar o site no popup tem que devolver o que estava emprestado.
          if (!siteEnabled()) {
            restorePlaybackRate(state.video);
            restoreAudio(state.video);
            state.adActive = false;
          }
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
  // attributeFilter em 'class' é o que pega transições tipo .ad-showing.
  const observer = new MutationObserver(scheduleTick);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'src', 'data-uia'],
  });

  // Rede de segurança para transições que não geram mutação observável
  // (ex.: fim do anúncio sinalizado só por timeupdate).
  if (CONFIG.safetyNetIntervalMs > 0) {
    setInterval(scheduleTick, CONFIG.safetyNetIntervalMs);
  }

  // Navegação SPA. Cada site tem os seus eventos; `popstate` cobre o resto.
  for (const evt of ['popstate', 'hashchange', ...(adapter.navigationEvents || [])]) {
    const target = evt === 'popstate' || evt === 'hashchange' ? window : document;
    target.addEventListener(
      evt,
      () => {
        // Ao sair de uma página no meio de um anúncio, devolve o áudio antes que
        // o estado seja descartado.
        if (state.mutedByUs) restoreAudio(state.video);
        restorePlaybackRate(state.video);
        state.adActive = false;
        if (typeof adapter.onNavigate === 'function') adapter.onNavigate(ctx);
        scheduleTick();
      },
      true,
    );
  }

  // O <video> emite eventos úteis mesmo quando o DOM está estável.
  for (const evt of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'playing']) {
    document.addEventListener(evt, scheduleTick, true); // capture: eventos de mídia não borbulham
  }

  scheduleTick();
  log('ativo');

  /**
   * NOTA — mute e a UI do player.
   * Mutamos `<video>.muted` diretamente. Os players guardam o estado de mute no
   * próprio state deles, então o ícone de volume da barra de controles pode não
   * refletir o mute durante o anúncio. Como a janela é de poucos segundos e
   * restauramos em seguida, na prática não incomoda.
   * Se quiser sincronia perfeita com a UI, mude o content script para
   * `"world": "MAIN"` no manifest e chame a API do player.
   * Trade-off: MAIN world compartilha globais com a página e depende de APIs
   * não-documentadas — mais frágil que `<video>.muted`.
   */
})();
