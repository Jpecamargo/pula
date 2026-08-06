/**
 * Adapter: YouTube (e youtube-nocookie).
 *
 * É o único streaming em que o anúncio é um vídeo SEPARADO do conteúdo: o
 * player troca o `src` do <video>, marca `.ad-showing` no container e a duração
 * passa a ser a do anúncio. Isso é o que torna possível clicar em "Pular
 * anúncio" e adiantar o playhead — nos serviços com SSAI (anúncio costurado no
 * mesmo stream) nada disso existe, e os adapters de lá desligam esses recursos.
 *
 * Carregado ANTES do core.js; só se anuncia em globalThis.__PULA_ADAPTER__.
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // SELETORES — a parte que quebra quando o YouTube renomeia classes.
  // Ordem importa: o primeiro que casar e estiver clicável é usado.
  // ───────────────────────────────────────────────────────────────────────────

  /** Botões de "Pular anúncio" (layout moderno primeiro, legado depois). */
  const SKIP_BUTTON_SELECTORS = [
    '.ytp-skip-ad-button',                    // layout atual (2024+)
    '.ytp-ad-skip-button-modern',             // layout "modern"
    '.ytp-ad-skip-button',                    // legado
    '.ytp-ad-skip-button-container button',   // wrapper legado
    '.ytp-skip-ad-button__text',              // span interno; o core sobe pro botão
    '.ytp-ad-overlay-close-button',           // "x" do banner sobre o player
    '.ytp-ad-overlay-close-container',        // wrapper do "x"
  ];

  /**
   * Roots do fallback por texto. São só containers de anúncio de propósito —
   * varrer `#movie_player` inteiro pegaria botões da barra de controle
   * ("Avançar", "Pular pro fim").
   */
  const SKIP_FALLBACK_ROOTS = [
    '.video-ads',
    '.ytp-ad-module',
    '.ytp-ad-player-overlay',
    '.ytp-ad-player-overlay-layout',
  ];

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

  // ───────────────────────────────────────────────────────────────────────────
  // Diálogos
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * O YouTube pausa o vídeo e pergunta se você ainda está aí. Confirmamos, mas
   * só depois de bater o texto: `#confirm-button` é compartilhado com diálogos
   * destrutivos e um clique cego neles seria bem pior que o incômodo.
   * NUNCA remover essa guarda.
   */
  function confirmContinueWatching(ctx) {
    if (!ctx.can('skipContinueWatching')) return false;

    for (const dialog of ctx.queryAll(CONFIRM_DIALOG_SELECTORS)) {
      if (ctx.handledDialogs.has(dialog)) continue;
      if (!CONTINUE_TEXT_RE.test(dialog.textContent || '')) continue;

      const target = ctx.clickTargetFor(ctx.queryFirst(CONFIRM_BUTTON_SELECTORS, dialog));
      if (!target || !ctx.isClickable(target)) continue;

      ctx.handledDialogs.add(dialog);
      target.click();
      ctx.log('diálogo "continuar assistindo" confirmado');
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
  function dismissAdblockDialog(ctx) {
    if (!ctx.can('dismissAdblockDialog')) return false;

    const dialog = ctx.queryFirst(ADBLOCK_DIALOG_SELECTORS);
    if (!dialog || ctx.handledDialogs.has(dialog)) return false;
    ctx.handledDialogs.add(dialog);

    const target = ctx.clickTargetFor(ctx.queryFirst(ADBLOCK_DISMISS_SELECTORS, dialog));
    if (target && ctx.isClickable(target)) {
      target.click();
      ctx.log('modal anti-adblock fechado no botão');
    } else {
      (dialog.closest('tp-yt-paper-dialog') || dialog).remove();
      ctx.log('modal anti-adblock removido do DOM');
    }

    for (const backdrop of ctx.queryAll(['tp-yt-iron-overlay-backdrop'])) backdrop.remove();
    if (document.body) document.body.style.setProperty('overflow', 'auto', 'important');

    // O modal pausa o vídeo ao abrir; como acabamos de fechá-lo, retomar é a
    // continuação do mesmo gesto.
    const video = ctx.getVideo();
    if (video && video.paused) video.play().catch(() => {});
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Capítulos patrocinados
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
   * Se o painel não estiver montado, a lista fica vazia e a feature é no-op.
   */
  function refreshChapters(ctx, video) {
    if (!ctx.can('skipSponsorChapters')) return;
    const st = ctx.adapterState;

    const videoId = currentVideoId();
    if (videoId !== st.chaptersVideoId) {
      st.chaptersVideoId = videoId;
      st.skippedChapters = new Set();
      st.chapters = [];
      st.chaptersKey = null;
    }

    const items = ctx.queryAll([CHAPTER_ITEM_SELECTOR]);
    const key = `${videoId}|${items.length}`;
    if (key === st.chaptersKey) return;

    const parsed = [];
    for (const item of items) {
      const start = parseTimestamp((ctx.queryFirst(CHAPTER_TIME_SELECTORS, item) || {}).textContent);
      if (start === null) continue;
      const titleEl = ctx.queryFirst(CHAPTER_TITLE_SELECTORS, item);
      const title = ((titleEl && titleEl.textContent) || '').trim();
      parsed.push({ start, title, sponsor: SPONSOR_CHAPTER_RE.test(title) });
    }
    parsed.sort((a, b) => a.start - b.start);

    const total = video && Number.isFinite(video.duration) ? video.duration : Infinity;
    parsed.forEach((ch, i) => {
      ch.end = i + 1 < parsed.length ? parsed[i + 1].start : total;
    });

    st.chapters = parsed;
    // Sem duração ainda (metadata não chegou) o último capítulo fica sem fim —
    // não cacheia, pra reparsear quando `durationchange` disparar.
    st.chaptersKey = Number.isFinite(total) ? key : null;

    const sponsors = parsed.filter((ch) => ch.sponsor);
    if (sponsors.length) ctx.log('capítulos patrocinados detectados:', sponsors.map((ch) => ch.title));
  }

  function skipSponsorChapters(ctx, video) {
    const st = ctx.adapterState;
    if (!ctx.can('skipSponsorChapters') || !video || !st.chapters || st.chapters.length === 0) return;

    const t = video.currentTime;
    for (const ch of st.chapters) {
      if (!ch.sponsor || !Number.isFinite(ch.end)) continue;
      // Já pulamos este uma vez: se você voltou pro capítulo na mão, foi de propósito.
      if (st.skippedChapters.has(ch.start)) continue;
      if (t < ch.start || t >= ch.end - 0.3) continue;

      st.skippedChapters.add(ch.start);
      video.currentTime = ch.end;
      ctx.bumpStat('sponsorChaptersSkipped', 1);
      ctx.bumpStat('secondsSaved', ch.end - t);
      ctx.log('capítulo patrocinado pulado:', ch.title);
      return;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  globalThis.__PULA_ADAPTER__ = {
    id: 'youtube',
    label: 'YouTube',

    playerSelectors: PLAYER_SELECTORS,
    videoSelectors: VIDEO_SELECTORS,
    skipButtonSelectors: SKIP_BUTTON_SELECTORS,
    skipFallbackRoots: SKIP_FALLBACK_ROOTS,
    overlayHideSelectors: OVERLAY_HIDE_SELECTORS,
    feedHideSelectors: FEED_HIDE_SELECTORS,

    /** yt-navigate-finish é o evento canônico do polymer; os outros são redundância barata. */
    navigationEvents: [
      'yt-navigate-start',
      'yt-navigate-finish',
      'yt-page-data-updated',
      'yt-player-updated',
    ],

    /** O YouTube é o único onde tudo é possível — nada desligado aqui. */
    supports: {},

    /** Detecta anúncio por classe no player OU pela presença do overlay. */
    isAdShowing(ctx) {
      const player = ctx.getPlayer();
      if (player) {
        for (const cls of AD_STATE_CLASSES) {
          if (player.classList.contains(cls)) return true;
        }
      }
      return ctx.queryFirst(AD_PRESENCE_SELECTORS) !== null;
    },

    /**
     * O modal anti-adblock pode aparecer durante o anúncio e travar tudo, então
     * ele é tratado aqui também (e não só no onTick fora de anúncio).
     */
    onAdTick(ctx) {
      dismissAdblockDialog(ctx);
      return false; // deixa o pipeline genérico de skip seguir
    },

    onTick(ctx, video) {
      dismissAdblockDialog(ctx);
      confirmContinueWatching(ctx);
      refreshChapters(ctx, video);
      skipSponsorChapters(ctx, video);
    },

    onNavigate(ctx) {
      // Vídeo novo: a lista de capítulos e os já pulados não valem mais.
      ctx.adapterState.chaptersKey = null;
    },
  };
})();
