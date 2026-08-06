/**
 * Adapter: Twitch.
 *
 * ROTA REJEITADA DE PROPÓSITO — interceptação do manifesto HLS.
 * Praticamente toda solução conhecida de "pular anúncio na Twitch" (a família
 * TwitchAdSolutions e derivados) funciona substituindo `window.fetch` ou
 * `XMLHttpRequest`, injetando um worker e reescrevendo o `.m3u8` para pegar uma
 * variante do stream sem anúncio. Aqui isso é PROIBIDO, e não por preguiça: o
 * princípio do projeto é fazer só o que o usuário faria com o mouse, deixando a
 * página carregar o anúncio normalmente. No momento em que a extensão passa a
 * mexer no que a página baixa, ela vira exatamente o sinal que o detector
 * anti-adblock da Twitch procura — e o preço são os "erro #2000 / #4000",
 * stream travado e purple screen que assombram esses scripts a cada round do
 * gato-e-rato. Sem rede, não há o que detectar. Se você veio até aqui pensando
 * em "só um fetch pra checar a playlist": não. Nem fetch, nem XHR, nem Worker,
 * nem <script> no MAIN world, nem webRequest/DNR.
 *
 * O que sobra, e é o que este adapter faz: mutar durante o anúncio e esconder o
 * contador/rótulo. Só. Na Twitch o anúncio é costurado no mesmo stream da live
 * (SSAI) — não existe <video> de anúncio, não existe botão de pular e não dá
 * pra seekar uma transmissão ao vivo. Daí `clickSkipButton` e
 * `fastForwardUnskippable` desligados em `supports`: prometer skip aqui só
 * produziria loop de clique e um contador mentindo sobre tempo economizado.
 *
 * Preferimos `data-a-target` a classe em todo seletor: as classes da Twitch são
 * ou utilitárias (`tw-*`) ou hasheadas, e mudam a cada deploy. E, ao contrário
 * do adapter do Netflix, aqui NÃO usamos prefixo abrangente (`[data-a-target^=
 * "ad-"]`): a Twitch tem overlay o tempo todo (raid, extensão, enquete, drops,
 * hype train, clipe) e um falso positivo aqui muta a live inteira, o que é bem
 * pior do que ouvir o anúncio. Lista explícita, sempre.
 *
 * O player exige login, então NADA aqui foi verificado no DOM real. A divisão
 * honesta, pra quem for manter:
 *
 * CONFIRMADO — citado por userscripts/extensões públicos e ativos (Harest,
 * "Twitch - Mute and hide ads…" no Greasyfork/OpenUserJS, ad-mute):
 *   [data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"],
 *   [data-test-selector="ad-banner-default-text"], [data-a-target="ax-overlay"],
 *   .video-player__container, .pbyp-player-instance,
 *   [data-a-target="player-mute-unmute-button"] (só como referência: NÃO é
 *   clicado — ver nota em MUTE, abaixo)
 *
 * PALPITE — os itens marcados como tal nas listas abaixo.
 *
 * Manutenção: com `debug: true`, o log informa qual marcador casou. Se nenhum
 * casar, o bloco passa sem mute — inspecione o contador durante um anúncio,
 * copie o `data-a-target` e ponha no topo de AD_MARKER_SELECTORS. O caso
 * inverso (marcador preso, live mutada eternamente) cai no aviso de stall do
 * core, ver `configDefaults` no fim do arquivo.
 *
 * Carregado ANTES do core.js; só se anuncia em globalThis.__PULA_ADAPTER__.
 */
(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // SELETORES
  // ───────────────────────────────────────────────────────────────────────────

  const PLAYER_SELECTORS = [
    '.video-player__container',
    '[data-a-target="video-player"]',   // palpite: wrapper externo do player
    '.persistent-player',               // palpite: player fixo (theater/mini)
  ];

  /**
   * Durante o anúncio a Twitch encolhe a live num player picture-by-picture no
   * canto da tela: existem DOIS <video> ao mesmo tempo, o do anúncio e o da
   * live. Mutar o errado silencia a transmissão e deixa o anúncio com som —
   * exatamente o oposto do que se quer. O `:not()` tira o pbyp da conta; se o
   * Chrome recusar o seletor complexo, `queryFirst` engole a exceção e cai nos
   * seguintes, que valem enquanto o player principal vier antes no DOM.
   */
  const VIDEO_SELECTORS = [
    '.video-player__container video:not(.pbyp-player-instance video)',
    '.video-player__container video',
    '[data-a-target="video-player"] video',
  ];

  /**
   * Marcadores de "tem anúncio tocando agora". Ordem = confiança.
   * Presença basta, sem checar visibilidade: nosso próprio CSS esconde parte
   * disso com `display:none`, que tira da tela mas mantém o nó no DOM — checar
   * renderização aqui faria a extensão cegar a si mesma.
   */
  const AD_MARKER_SELECTORS = [
    '[data-a-target="video-ad-label"]',
    '[data-a-target="video-ad-countdown"]',
    '[data-test-selector="ad-banner-default-text"]',
    '[data-a-target="video-ad-countdown-container"]',  // palpite
    '[data-a-target="player-ad-notice"]',              // palpite
    '.player-ad-notice',                               // palpite (layout antigo)
    '.pbyp-player-instance',                           // ver nota abaixo
    '[data-a-target="ax-overlay"]',                    // ver nota abaixo
  ];

  /**
   * `.pbyp-player-instance` é a live encolhida no canto — ela só existe durante
   * o bloco de anúncio, o que faz dela um marcador legítimo. Fica no fim porque
   * é sintoma, não rótulo: se a Twitch reaproveitar o picture-by-picture pra
   * outra coisa (multiview, prévia de raid), ele deixa de significar anúncio.
   * E, por ser a live, ele NUNCA entra em OVERLAY_HIDE_SELECTORS: escondê-lo
   * apagaria justamente a única imagem que o usuário quer ver.
   */

  /**
   * Marcadores que são só container: o nó existe o tempo todo e fica vazio fora
   * do anúncio, então presença não diz nada e checá-la mutaria a live inteira.
   * O limiar de filhos vem do userscript público que usa esse seletor há anos —
   * copiado em vez de inventado justamente porque é ele que segura o falso
   * positivo em campo.
   */
  const CONTAINER_MARKER_SELECTORS = new Set(['[data-a-target="ax-overlay"]']);
  const CONTAINER_MARKER_MIN_CHILDREN = 2;

  /**
   * Escondidos via CSS quando `hideAdOverlays` está ligado. Só o rótulo, o
   * contador e o banner de anúncio: nada de esconder o player, o chat ou o
   * picture-by-picture. `display:none` não remove o nó, então esconder o
   * contador não atrapalha a detecção acima.
   */
  const OVERLAY_HIDE_SELECTORS = [
    '[data-a-target="video-ad-label"]',
    '[data-a-target="video-ad-countdown"]',
    '[data-a-target="video-ad-countdown-container"]',  // palpite
    '[data-test-selector="ad-banner-default-text"]',
    '[data-a-target="player-ad-notice"]',              // palpite
    '.player-ad-notice',                               // palpite
  ];

  /**
   * Vazio de propósito: os anúncios fora do player da Twitch (banner do topo da
   * home, card patrocinado na barra lateral) não têm nenhum atributo estável
   * conhecido, e a barra lateral é feita de cards idênticos aos das lives que o
   * usuário segue. Chutar seletor aqui esconderia canal seguido, não anúncio.
   * Se um dia sair um `data-a-target` próprio, é aqui que entra.
   */
  const FEED_HIDE_SELECTORS = [];

  /**
   * Roots do dump de diagnóstico do core (`warnStalledAd`). Não existe container
   * de anúncio isolado nem botão de pular pra procurar por texto — isto aqui
   * serve só pra que, quando a detecção travar, o console liste os botões que a
   * Twitch de fato renderizou naquele momento.
   */
  const SKIP_FALLBACK_ROOTS = ['.video-player__container', '[data-a-target="video-player"]'];

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
    '[data-a-target*="skip-ad" i]',
    '[data-test-selector*="skip-ad" i]',
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


  // ───────────────────────────────────────────────────────────────────────────
  // Detecção do bloco de anúncio
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Procura o marcador de anúncio, começando pelo seletor que casou da última
   * vez: durante o bloco o tick roda a cada mutação, e a Twitch muta o DOM sem
   * parar (chat, viewers, extensões) — varrer a lista inteira toda vez é
   * desperdício num site que dispara tick o dia todo.
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
      if (
        CONTAINER_MARKER_SELECTORS.has(sel) &&
        el.childElementCount < CONTAINER_MARKER_MIN_CHILDREN
      ) {
        continue;
      }

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
  // Navegação
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * O canal é o que identifica o que está tocando; `/videos/…` e `/clip/…` caem
   * no pathname inteiro, que serve igual como chave de "mudou de página".
   */
  function currentChannel() {
    return location.pathname;
  }

  function resetCache(ctx) {
    ctx.adapterState.adMarkerSelector = null;
  }

  /**
   * A Twitch troca de canal por `pushState`, que não emite evento nenhum — o
   * core só escuta `popstate`, então clicar num canal da barra lateral passaria
   * batido e o marcador cacheado seguiria apontando pro DOM antigo. Comparar o
   * pathname no tick é o sinal que sempre existe.
   */
  function syncLocation(ctx) {
    const st = ctx.adapterState;
    const channel = currentChannel();
    if (channel === st.channel) return;
    st.channel = channel;
    resetCache(ctx);
    ctx.log('navegou para', channel);
  }

  // ───────────────────────────────────────────────────────────────────────────
  globalThis.__PULA_ADAPTER__ = {
    id: 'twitch',
    label: 'Twitch',

    playerSelectors: PLAYER_SELECTORS,
    videoSelectors: VIDEO_SELECTORS,

    /** Vazio: não existe botão de pular anúncio na Twitch. */
    skipButtonSelectors: AD_SKIP_SELECTORS,
    skipTextRe: AD_SKIP_TEXT_RE,

    skipFallbackRoots: SKIP_FALLBACK_ROOTS,
    overlayHideSelectors: OVERLAY_HIDE_SELECTORS,
    feedHideSelectors: FEED_HIDE_SELECTORS,

    /**
     * Nenhum evento de navegação próprio: a Twitch não expõe um evento público
     * de troca de rota, então `popstate` (já escutado pelo core) mais o
     * `syncLocation` do `onTick` cobrem o caso. Inventar nome de evento aqui só
     * adicionaria listener morto.
     */

    /**
     * Aqui o anúncio durar não é sintoma de seletor quebrado — é o normal, e
     * pré-roll de 3 minutos existe. O alarme de stall muda de significado neste
     * site: ele passa a avisar do risco oposto, o de um marcador ter ficado
     * preso no DOM e a extensão estar mutando a live sem anúncio nenhum. 4
     * minutos é longo demais pra qualquer bloco e curto o bastante pra não
     * deixar a live muda a tarde toda sem um aviso no console.
     */
    configDefaults: { stallWarnMs: 240000 },

    supports: {
      // SSAI: o player reverte o seek dentro do bloco, então adiantar o
      // playhead só geraria loop. Clicar, não: quando o site põe um botão
      // de pular na tela, ele funciona igual ao de qualquer outro lugar.
      fastForwardUnskippable: false,
      // Nada disso existe na Twitch: não há abertura/recap, não há modal de
      // "ainda está assistindo?", não há capítulo patrocinado declarado pelo
      // site e não há modal anti-adblock (o enforcement de lá é no stream, não
      // na UI — e é exatamente o que este adapter evita provocar).
      skipIntros: false,
      skipContinueWatching: false,
      skipSponsorChapters: false,
      dismissAdblockDialog: false,
    },

    isAdShowing(ctx) {
      return findAdMarker(ctx) !== null;
    },

    onAdStart(ctx) {
      // Deixa explícito no log que o silêncio a seguir é o comportamento
      // pretendido, e não a extensão falhando em pular.
      ctx.log('anúncio SSAI ao vivo: dá pra mutar e esconder, não pra pular');
    },

    onTick(ctx) {
      syncLocation(ctx);
    },

    onNavigate(ctx) {
      // `syncLocation` refaz o resto no próximo tick, quando a URL nova já vale.
      ctx.adapterState.channel = null;
      resetCache(ctx);
    },
  };

  /**
   * NOTA — MUTE.
   * O mute é do core, feito em `<video>.muted` com posse (ele só restaura o que
   * ele mesmo mutou e cede o controle se você mexer no volume). O botão de mute
   * da barra de controles da Twitch (`[data-a-target="player-mute-unmute-button"]`)
   * fica de fora de propósito: clicar nele gravaria o mute no estado do próprio
   * player, que a Twitch persiste entre sessões — o usuário acabaria com a
   * Twitch permanentemente muda por causa de um anúncio de 30 segundos.
   */
})();
