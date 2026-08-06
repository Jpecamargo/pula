/**
 * Adapter: Globoplay.
 *
 * O player é o Clappr (open source, mantido pela própria Globo) com plugins
 * proprietários por cima. Isso é raro neste projeto: a casca do player tem
 * classes públicas e estáveis, verificáveis no repositório, então os seletores
 * de player/vídeo aqui NÃO são chute. O que continua sendo chute é tudo que os
 * plugins da Globo desenham em cima — marcador de anúncio, "pular abertura",
 * "próximo episódio", modal de inatividade —, porque isso exige login e não dá
 * pra inspecionar de fora.
 *
 * O anúncio do Globoplay é SSAI: vem costurado no mesmo stream do conteúdo, sem
 * <video> separado, sem botão de pular, e o player reverte qualquer avanço de
 * `currentTime` dentro do bloco. Daí `clickSkipButton` e
 * `fastForwardUnskippable` desligados em `supports` — prometer skip aqui só
 * produziria loop de clique e um contador mentindo sobre tempo economizado. O
 * que sobra, e funciona, é mutar o bloco, esconder contador/overlay e clicar em
 * "Pular abertura" / "Pular recapitulação" / "Próximo episódio".
 *
 * CONFIRMADO — lidos no fonte do Clappr (clappr/clappr, `main`):
 *   `[data-player]`                     raiz do Core (clappr-core/src/components/core/core.js)
 *   `.container[data-container]`        container (clappr-core/src/components/container/container.js)
 *   `video[data-html5-video]`           playback html5 (clappr-core/src/playbacks/html5_video)
 *   `.media-control[data-media-control]`, `.media-control-layer[data-controls]`,
 *   `.media-control-button` com `aria-label` em INGLÊS ("playpause",
 *   "fullscreen", …)  (clappr-plugins/src/plugins/media_control)
 *   `.player-poster[data-poster]`       (clappr-plugins/src/plugins/poster)
 *
 * Esse último detalhe importa: como os botões da barra de controle do Clappr têm
 * rótulo em inglês e nome de função, o fallback por texto em português não corre
 * risco de clicar neles por acidente. Ainda assim o regex é estreito — os
 * plugins da Globo traduzem parte da UI.
 *
 * PALPITE — todo o resto: os marcadores de anúncio, os botões de abertura e
 * próximo episódio, e o modal de inatividade. Nenhuma fonte pública nomeia um
 * atributo estável pra esses; estão marcados item a item nas listas abaixo.
 *
 * Manutenção: com `debug: true`, o log informa qual marcador casou. Se nenhum
 * casar, o bloco passa sem mute — inspecione o contador durante um anúncio e
 * ponha o seletor no topo de AD_MARKER_SELECTORS.
 *
 * Carregado ANTES do core.js; só se anuncia em globalThis.__PULA_ADAPTER__.
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // SELETORES
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `[data-player]` é a raiz que o Core do Clappr desenha, e `[data-container]`
   * o wrapper do playback — ambos confirmados no fonte. Os dois últimos são
   * palpite pro caso do Globoplay embrulhar o player num componente próprio que
   * apareça antes no DOM.
   */
  const PLAYER_SELECTORS = [
    '[data-player]',
    '.container[data-container]',
    '[data-testid="player"]',    // palpite: wrapper React do Globoplay
    '#player',                   // palpite
  ];

  /** O `<video>` do playback html5 do Clappr; o core cai em `video` genérico. */
  const VIDEO_SELECTORS = [
    '[data-player] video[data-html5-video]',
    '[data-player] video',
    'video[data-html5-video]',
  ];

  /**
   * Marcadores de "tem anúncio tocando agora". Ordem = confiança.
   * Presença basta, sem checar visibilidade: nosso próprio CSS esconde parte
   * disso com `display:none`, que tira da tela mas mantém o nó no DOM — checar
   * renderização aqui faria a extensão cegar a si mesma.
   *
   * Todos são palpite. Os dois por `class*=` são o que dá pra apostar com alguma
   * segurança: a UI do Globoplay é só em português, então "publicidade" e
   * "anuncio" no nome da classe descrevem o que são. `[class*="ad"]` está fora
   * de propósito — casaria "loading", "header", "download".
   */
  const AD_MARKER_SELECTORS = [
    '[data-ad-countdown]',              // palpite
    '[data-advertisement]',             // palpite
    '[class*="publicidade" i]',         // palpite
    '[class*="anuncio" i]',             // palpite (sem acento: classe raramente acentua)
    '[class*="advertisement" i]',       // palpite
    '.ad-countdown',                    // palpite
    '#ima-ad-container',                // ver nota de container abaixo
    '.ima-ad-container',                // ver nota de container abaixo
    '.ads-container',                   // ver nota de container abaixo
  ];

  /**
   * Marcadores que são só container: o nó do IMA/ads é criado uma vez e fica
   * vazio entre os blocos, então presença não diz nada — checá-la mutaria o
   * episódio inteiro. Só valem com filho dentro.
   */
  const CONTAINER_MARKER_SELECTORS = new Set([
    '#ima-ad-container',
    '.ima-ad-container',
    '.ads-container',
  ]);

  /**
   * Escondidos via CSS quando `hideAdOverlays` está ligado, e prefixados com
   * `[data-player]` pra que nada disso vaze pro resto do site.
   *
   * Duas exclusões deliberadas:
   * - o container do IMA/ads NÃO entra: ele é onde o anúncio de fato toca, e
   *   `display:none` num vídeo em reprodução é o tipo de coisa que faz o player
   *   nunca considerar o bloco consumido — o contrário do que se quer.
   * - nada aqui pode ser ancestral do botão "Pular abertura"/"Próximo
   *   episódio": `display:none` faz `isClickable()` retornar false e desligaria
   *   o `skipIntros` em silêncio. Por isso a lista é só rótulo e contador.
   */
  const OVERLAY_HIDE_SELECTORS = [
    '[data-player] [data-ad-countdown]',
    '[data-player] [data-advertisement]',
    '[data-player] [class*="publicidade" i]',
    '[data-player] [class*="anuncio" i]',
    '[data-player] .ad-countdown',
  ];

  /**
   * O Globoplay não vende espaço de terceiros no catálogo — o que a home mostra
   * é promoção do acervo dele mesmo, que não é anúncio. A única exceção plausível
   * são os slots do Google Publisher Tag, que a Globo usa nos portais: o id
   * `div-gpt-ad-*` é convenção do próprio GPT (confirmada na documentação do
   * Google), nunca casa conteúdo, e por isso é seguro mesmo sendo palpite que o
   * Globoplay os tenha.
   */
  const FEED_HIDE_SELECTORS = ['div[id^="div-gpt-ad"]'];

  /**
   * "Pular abertura" / "Pular recapitulação". Todos palpite — o botão é dos
   * plugins da Globo, não do Clappr base.
   */
  const INTRO_SKIP_SELECTORS = [
    '[data-skip-intro]',
    '[data-testid="skip-intro"]',
    '.skip-intro',
    'button[aria-label*="abertura" i]',
    'button[aria-label*="recapitula" i]',
    'button[aria-label*="resumo" i]',
  ];

  /**
   * "Próximo episódio". Palpite, e o `aria-label` exige "epis" de propósito:
   * um `*="próximo"` solto casaria o "Próximo" de carrossel e o avanço da
   * playlist, que pulariam conteúdo que o usuário está assistindo.
   */
  const NEXT_EPISODE_SELECTORS = [
    '[data-next-episode]',
    '[data-testid="next-episode"]',
    '.next-episode',
    // Duas variantes porque seletor de atributo não tem regex: `i` ignora caixa,
    // não acento, e não dá pra saber se o rótulo vem acentuado.
    'button[aria-label*="próximo epis" i]',
    'button[aria-label*="proximo epis" i]',
  ];

  /**
   * Roots do fallback por texto — e também do dump de diagnóstico do core.
   * Não existe container de anúncio isolado, então o root é o player inteiro, o
   * que inclui a barra de controle: daí o regex abaixo ser estreito.
   */
  const SKIP_FALLBACK_ROOTS = ['[data-player]', '.container[data-container]'];

  /**
   * Estreito de propósito. Um `/pular|próximo/` genérico varrendo o player
   * pegaria "Avançar 10 segundos", "Próximo" e "Ao vivo" da barra de controle.
   * Exige o complemento ("pular ABERTURA", "próximo EPISÓDIO") sempre.
   */
  const SKIP_INTRO_TEXT_RE =
    /pular\s+(a\s+)?(abertura|in[íi]cio|introdu[çc][ãa]o|intro|recapitula[çc][ãa]o|recap|resumo|cr[ée]ditos)|(assistir\s+)?(ao\s+)?pr[óo]ximo\s+epis[óo]dio/i;

  /**
   * Modal de inatividade ("Você ainda está aí?"), que pausa a reprodução até
   * alguém confirmar. Containers são palpite, exceto os `role` de ARIA.
   */
  const IDLE_DIALOG_SELECTORS = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[data-testid*="modal" i]',   // palpite
    '.modal',                     // palpite
  ];
  const IDLE_CONTINUE_SELECTORS = [
    '[data-continue]',                      // palpite
    'button[data-testid*="continu" i]',     // palpite
    'button[aria-label*="continuar" i]',    // palpite
  ];
  const IDLE_DIALOG_TEXT_RE =
    /ainda est[áa]\s+(a[íi]|por a[íi]|assistindo|acompanhando)|voc[êe] ainda est[áa]|continuar assistindo|continuar de onde parou/i;
  /** Só consultado DENTRO de um modal cujo texto já bateu o regex acima. */
  const IDLE_CONTINUE_TEXT_RE = /continuar|estou (aqui|assistindo)|ainda estou/i;

  /**
   * Intervalo mínimo entre dois cliques de skip. O botão some depois do clique,
   * mas o Clappr remonta a barra de controle a cada mudança de estado e o tick
   * roda a cada mutação — sem essa folga, um clique que não "pegou" vira uma
   * rajada que engasga o player.
   */
  const SKIP_CLICK_COOLDOWN_MS = 1000;

  // ───────────────────────────────────────────────────────────────────────────
  // Ao vivo
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * O Globoplay tem canais lineares, onde não existe fim de vídeo nem próximo
   * episódio. `duration` é `Infinity` na live e `NaN` antes da metadata chegar —
   * os dois caem aqui como "ao vivo", e é o lado certo pra errar: um clique
   * indevido em "próximo episódio" pula conteúdo que o usuário está assistindo,
   * enquanto um clique perdido só adia o pulo pro próximo tick.
   */
  function isLive(ctx, video) {
    if (/\/(ao-vivo|canais)\//.test(location.pathname)) return true;
    const el = video || ctx.getVideo();
    return !el || !Number.isFinite(el.duration);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Detecção do bloco de anúncio
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Procura o marcador de anúncio DENTRO do player, começando pelo seletor que
   * casou da última vez: durante o bloco o tick roda a cada mutação, e varrer a
   * lista inteira toda vez é desperdício.
   *
   * O escopo no player não é detalhe: `[class*="publicidade"]` solto no
   * documento casaria banner de home e cartela de catálogo, e o falso positivo
   * aqui muta o episódio inteiro. Sem player na página também não há o que
   * mutar, então devolver null é o comportamento correto.
   */
  function findAdMarker(ctx) {
    const st = ctx.adapterState;
    const player = ctx.getPlayer();
    if (!player) return null;

    const first = st.adMarkerSelector;
    const ordered = first
      ? [first, ...AD_MARKER_SELECTORS.filter((sel) => sel !== first)]
      : AD_MARKER_SELECTORS;

    for (const sel of ordered) {
      const el = ctx.queryFirst([sel], player);
      if (!el) continue;
      if (CONTAINER_MARKER_SELECTORS.has(sel) && el.childElementCount === 0) continue;

      if (st.adMarkerSelector !== sel) {
        st.adMarkerSelector = sel;
        ctx.log('marcador de anúncio casou:', sel, '→', ctx.describe(el));
      }
      return el;
    }

    st.adMarkerSelector = null;
    return null;
  }

  /**
   * Alarme de manutenção do caso mais silencioso: existe `<video>` tocando mas
   * nenhum seletor de player casou, então `isAdShowing` devolve false pra
   * sempre e o adapter fica cego sem reclamar. Uma vez por página.
   */
  function warnMissingPlayer(ctx) {
    const st = ctx.adapterState;
    if (st.missingPlayerWarned) return;
    if (ctx.getPlayer() || !ctx.getVideo()) return;
    st.missingPlayerWarned = true;
    ctx.log('<video> na página mas nenhum seletor de player casou — revise PLAYER_SELECTORS');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Modal "você ainda está aí?"
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Confirmamos sozinhos, mas só depois de bater o texto do modal — mesma
   * guarda dos outros adapters. O botão de confirmação costuma ser o mesmo
   * componente usado em diálogo destrutivo ("sair do plano", "remover
   * download"), e clique cego em botão de diálogo é exatamente o que não
   * fazemos. NUNCA remover essa guarda.
   *
   * Como todos os seletores de botão aqui são palpite, existe um segundo
   * caminho por texto — mas só entre os botões DESTE modal, cujo texto já foi
   * validado, e com um regex que não casa "cancelar"/"sair".
   */
  function confirmStillWatching(ctx) {
    if (!ctx.can('skipContinueWatching')) return false;

    for (const dialog of ctx.queryAll(IDLE_DIALOG_SELECTORS)) {
      if (ctx.handledDialogs.has(dialog)) continue;
      if (!IDLE_DIALOG_TEXT_RE.test(dialog.textContent || '')) continue;

      let target = ctx.clickTargetFor(ctx.queryFirst(IDLE_CONTINUE_SELECTORS, dialog));
      if (!target || !ctx.isClickable(target)) {
        target = ctx.queryAll(['button', '[role="button"]'], dialog).find((el) => {
          const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`;
          return IDLE_CONTINUE_TEXT_RE.test(label) && ctx.isClickable(el);
        });
      }
      if (!target) {
        // O texto do modal bateu mas nenhum botão serviu: sinal de que o layout
        // mudou. Uma vez por modal, senão vira spam a cada tick.
        if (!ctx.adapterState.idleDialogWarned) {
          ctx.adapterState.idleDialogWarned = true;
          ctx.log('modal "ainda está aí?" encontrado, botão não — revise IDLE_CONTINUE_SELECTORS');
        }
        continue;
      }

      // Marcado ANTES do clique: se o clique não remover o modal, o WeakSet é o
      // que impede a rajada de recliques a cada mutação.
      ctx.handledDialogs.add(dialog);
      target.click();
      ctx.log('"você ainda está aí?" confirmado');
      return true;
    }
    return false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Abertura, recapitulação e próximo episódio
  // ───────────────────────────────────────────────────────────────────────────

  function clickSkipButtons(ctx, video) {
    if (!ctx.can('skipIntros')) return false;

    const st = ctx.adapterState;
    const now = performance.now();
    if (now - (st.lastSkipClick || 0) < SKIP_CLICK_COOLDOWN_MS) return false;

    // Em canal ao vivo não existe episódio seguinte: o que casasse aqui seria
    // outro botão qualquer da UI. A abertura, essa, ainda vale — reprise de
    // novela na grade linear tem abertura como qualquer outra.
    const live = isLive(ctx, video);

    const clicked =
      ctx.clickFirst(INTRO_SKIP_SELECTORS) ||
      (!live && ctx.clickFirst(NEXT_EPISODE_SELECTORS)) ||
      // Último recurso: nenhum seletor conhecido casou. Sobrevive a renomeação,
      // que é o modo mais comum de tudo isso quebrar.
      ctx.clickByText(SKIP_FALLBACK_ROOTS, SKIP_INTRO_TEXT_RE);

    if (clicked) st.lastSkipClick = now;
    return clicked;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Navegação
  // ───────────────────────────────────────────────────────────────────────────

  /** `/v/<id>/` (VOD) e `/ao-vivo/<slug>/<id>/` identificam o que está tocando. */
  function currentMediaId() {
    const match = /\/(?:v|ao-vivo|canais)\/[^/]*\/?(\d+)?/.exec(location.pathname);
    return match ? match[0] : location.pathname;
  }

  function resetCache(ctx) {
    const st = ctx.adapterState;
    st.adMarkerSelector = null;
    st.lastSkipClick = 0;
    st.idleDialogWarned = false;
    st.missingPlayerWarned = false;
  }

  /**
   * O Globoplay navega por `pushState`, que não emite evento nenhum — o core só
   * escuta `popstate`, então trocar de episódio pelo pós-play passaria batido e
   * o marcador cacheado seguiria apontando pro DOM antigo. Comparar o id no
   * tick é o sinal que sempre existe.
   */
  function syncLocation(ctx) {
    const st = ctx.adapterState;
    const id = currentMediaId();
    if (id === st.mediaId) return;
    st.mediaId = id;
    resetCache(ctx);
    ctx.log('navegou para', id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  globalThis.__PULA_ADAPTER__ = {
    id: 'globoplay',
    label: 'Globoplay',

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
     * O alarme de stall padrão (10s) dispararia em todo intervalo: aqui o bloco
     * durar é o normal, não sintoma de seletor quebrado — canal ao vivo tem
     * intervalo comercial inteiro, de minutos. Dois minutos é longo o bastante
     * pra não gritar à toa e curto o bastante pra denunciar o risco inverso, o
     * de um marcador ter ficado preso no DOM com a extensão mutando conteúdo.
     */
    configDefaults: { stallWarnMs: 120000 },

    supports: {
      // SSAI: não existe botão de pular, e o player reverte o seek dentro do
      // bloco (na live nem playhead pra frente existe). Ligar qualquer um dos
      // dois só geraria loop de clique.
      clickSkipButton: false,
      fastForwardUnskippable: false,
      // Não existe modal anti-adblock (o Globoplay não faz enforcement na UI)
      // nem painel de capítulos patrocinados declarado pelo site.
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
      warnMissingPlayer(ctx);
      // O modal pausa a reprodução, então ele vem antes: com o vídeo parado
      // nenhum botão de abertura chega a aparecer.
      confirmStillWatching(ctx);
      clickSkipButtons(ctx, video);
    },

    onNavigate(ctx) {
      // `syncLocation` refaz o resto no próximo tick, quando a URL nova já vale.
      ctx.adapterState.mediaId = null;
      resetCache(ctx);
    },
  };

  /**
   * NOTA — por que nada de rede aqui.
   * O caminho "fácil" no Globoplay seria mexer no manifesto HLS ou na resposta
   * do serviço de playback pra tirar o bloco de anúncio. É proibido, e não por
   * preguiça: o princípio do projeto é fazer só o que o usuário faria com o
   * mouse, deixando a página baixar o anúncio normalmente. Sem rede alterada,
   * não há sinal pro detector do site. Nem fetch, nem XHR, nem Worker, nem
   * script no MAIN world, nem webRequest/DNR.
   */
})();
