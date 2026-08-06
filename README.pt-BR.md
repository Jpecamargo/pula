<img src="icons/icon128.png" alt="Pula" width="128" height="128">

# Pula — extensão Chrome que pula anúncio do YouTube e abertura de streaming, só por DOM

Extensão Chrome MV3 que pula anúncios do YouTube clicando nos mesmos botões que
você clicaria na mão, e que muta, esconde e atravessa intervalo, abertura e
recapitulação na Netflix, Prime Video, Disney+, Max, Twitch, Globoplay,
Crunchyroll e Paramount+.

Sem bloqueio de rede. Sem filtro de requisição. Sem servidor. Sem cadastro.

[Read in English](README.md)

## Por que eu fiz isso

Jogo com um vídeo ou uma playlist rodando na segunda tela. Funcionava bem até
entrar anúncio: aí eu tinha que largar o controle, pegar o mouse, arrastar o
ponteiro até o outro monitor, procurar o "Pular anúncio", clicar, e voltar pro
jogo — que a essa altura já tinha ido mal pra mim. Pausar o jogo pra pular
anúncio vinte vezes numa noite é um jeito idiota de passar a noite.

Então escrevi algo que clica no botão por mim. É essa a ideia inteira, e é o que
explica o funcionamento da extensão: ela não briga com o sistema de anúncio do
YouTube, só faz o trabalho de mouse que eu estava fazendo na mão. Se dá pra fazer
com o mouse na página, o Pula faz. Se não dá, o Pula não finge que dá.

## O que ela faz, por serviço

O YouTube é a exceção entre os streamings: lá o anúncio é um **`<video>`
separado**, com duração própria e botão "Pular anúncio" de verdade, então dá pra
pular mesmo — clicar no botão, ou jogar o playhead pro fim.

Em todo o resto o anúncio é **SSAI** (inserção no lado do servidor): vem costurado
no mesmo stream do conteúdo. Não existe elemento de anúncio, e o player reverte
qualquer tentativa de avançar o intervalo — insistir nisso só geraria loop de
clique. O que funciona ali é mutar o bloco, esconder o overlay e o contador, e
clicar em "Pular abertura" / "Pular recapitulação" / "Próximo episódio" quando o
próprio episódio oferece.

O botão de pular anúncio o Pula também clica, quando aparece: a maior parte do
inventário desses serviços não tem botão nenhum, mas alguns formatos têm, e aí
clicar é o mesmo gesto que você faria com o mouse. Quando não tem, a busca
simplesmente não acha nada e o bloco segue mutado.

| Serviço | Como o anúncio é servido | Clica no botão de pular | Muta + esconde overlay | Pula abertura / recap / próximo episódio |
|---|---|---|---|---|
| YouTube | vídeo de anúncio separado | sim — clica em "Pular anúncio" e adianta o não-pulável | sim | n/a |
| Netflix | SSAI | quando o site oferece | sim | sim |
| Prime Video | SSAI | quando o site oferece | sim | sim |
| Disney+ | SSAI | quando o site oferece | sim | sim |
| Max | SSAI | quando o site oferece | sim | sim |
| Twitch | SSAI | quando o site oferece | sim | n/a |
| Globoplay | SSAI | quando o site oferece | sim | sim |
| Crunchyroll | SSAI | quando o site oferece | sim | sim |
| Paramount+ | SSAI | quando o site oferece | sim | sim |

Além disso, no YouTube especificamente:

- Esconde overlays sobre o player e anúncios de feed, home, sidebar e masthead
- Confirma sozinho o "Vídeo pausado. Continuar assistindo?"
- Fecha o modal anti-adblock quando ele aparece por falso positivo
- Pula **capítulos de patrocínio** usando os capítulos do próprio vídeo — sem
  servidor, sem API de terceiro, sem conta. É a ideia do SponsorBlock sem a
  chamada de rede
- Avisa no console quando os seletores quebram, com os candidatos a botão que
  encontrou, pra você saber exatamente o que consertar

O popup tem um toggle **por streaming** e um toggle **por comportamento**, mais o
contador de anúncios pulados, tempo economizado e patrocínios pulados. O toggle
vale na hora, sem F5.

## Por que não bloquear rede importa

O Pula não encosta em `webRequest`, `declarativeNetRequest` nem host permissions.
A página carrega o anúncio exatamente como carregaria sem a extensão, e o que a
extensão faz é interagir com o DOM resultante.

Isso é de propósito. Detector de adblock funciona percebendo que uma requisição
falhou ou que um elemento esperado nunca apareceu. Se nada é bloqueado, não há
sinal pra detectar, e o enforcement anti-adblock não tem em que disparar. E
também significa que a extensão não consegue quebrar a reprodução tirando do
player um recurso de que ele precisava.

`storage` é a única permissão do manifest, e existe só pro popup lembrar dos seus
toggles e do contador.

## Instalar (carregar sem compactação)

Não há build step nem dependências. O repositório é a extensão.

1. Abra `chrome://extensions`
2. Ligue o **Modo do desenvolvedor** (canto superior direito)
3. **Carregar sem compactação** e selecione a pasta `pula/` (a pasta, não o
   `manifest.json`)
4. Abra um vídeo. Se a aba já estava aberta, recarregue: content scripts só são
   injetados em navegações posteriores à instalação

Pra conferir que está rodando, ligue `debug: true` no `CONFIG` (topo do `core.js`,
ou pelo toggle de debug no popup) e filtre o console do DevTools por `[Pula]`.

## Recarregar depois de editar

O botão ⟳ sozinho não basta: ele recarrega o pacote da extensão, mas a aba aberta
continua com a cópia antiga do content script já injetada.

| Editou | O que fazer |
|---|---|
| `core.js` ou `adapters/*.js` | ⟳ no card da extensão em `chrome://extensions` **e** F5 na aba do streaming |
| `popup.html` / `popup.js` | Feche e reabra o popup (⟳ só se não pegar) |
| `_locales/*/messages.json` | ⟳ e depois reabra o popup |
| `manifest.json` | ⟳ e depois F5. Se o Chrome reclamar, remova e carregue de novo |
| `icons/` | ⟳ (pode precisar de hard-reload da página `chrome://extensions`) |

Atalho: deixe `chrome://extensions` numa aba fixada e edite direto na pasta. Não
existe watcher, mas ⟳ + F5 leva dois segundos.

## Estrutura

```
pula/
├── manifest.json      # MV3, content scripts em document_start, permissão storage
├── core.js            # motor genérico: loop de tick, mute, stats, CSS, config
├── adapters/          # um arquivo por streaming (ver adapters/README.md)
├── popup.html         # UI de toggles e contador
├── popup.js           # lê/grava chrome.storage.local
├── _locales/          # textos da UI em en e pt_BR
└── icons/             # icon16.png, icon48.png, icon128.png
```

Os três PNGs são obrigatórios enquanto o `manifest.json` declarar o bloco `icons`
— o Chrome recusa carregar a extensão com referência a arquivo inexistente.

## Quando quebrar

Streaming renomeia classe de CSS de vez em quando, e é assim que uma extensão
baseada em DOM para de funcionar. Quando acontecer, o console vai ter um aviso
`[Pula:netflix] anúncio ativo há mais de ...` listando todo botão que existe
dentro do container de anúncio naquele momento. O prefixo diz qual adapter está
falando, e o seletor certo quase sempre está nessa lista — ponha ele no topo do
`skipButtonSelectors` do adapter correspondente.

Se o aviso não aparecer mas o anúncio sumir mesmo assim, é o fallback por texto
segurando as pontas: o Pula também varre os botões dentro dos containers de
anúncio e escolhe pelo rótulo (português, inglês e espanhol), o que sobrevive à
maioria das renomeações. Ainda assim vale atualizar o seletor.

Os toggles de comportamento ficam no popup, não no código. Atenção: o popup grava
por cima do `CONFIG`. Se você editar um booleano no arquivo e nada mudar, é porque
aquela chave já está em `chrome.storage` — mexa pelo popup.

Adicionar outro streaming é adicionar um arquivo de adapter e uma entrada no
manifest. O contrato está em [`adapters/README.md`](adapters/README.md).

## Escopo e aviso

Projeto de uso pessoal, escrito pro meu setup e publicado como está. Não está na
Chrome Web Store, não passou por auditoria, e vai quebrar sempre que um streaming
mexer no DOM. Vale apoiar quem você assiste — a graça disso nunca foi deixar de
pagar por conteúdo, foi parar de pausar o jogo.
