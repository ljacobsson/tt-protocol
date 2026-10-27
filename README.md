# Matchprotokoll by Pingis.net

En mobilanpassad tävlingsapp för rundpool, poolspel och slutspel. Appen kan
fortfarande köras helt lokalt, men innehåller också en AWS SAM-backend för
klubbar, flera tävlingar per klubb och beständig spelarranking.

Rotadressen är en konsumentinriktad landningssida där en klubb kan skapas
direkt med endast klubbnamnet. Ingen registrering, e-postadress, betalning eller
lösenord krävs; den unika klubblänken är åtkomsten. Äldre lokal användning nås
via `/local`.

## Köra lokalt

```bash
npm start
```

Appen öppnas på `http://localhost:8001`. Den lokala servern har history
fallback så att rena adresser som `/clubs/{clubId}` och
`/clubs/{clubId}/tournaments/{tournamentId}/results` fungerar även efter en
omladdning. Porten kan ändras med `MATCHPROTOKOLL_PORT`.

## AWS-arkitektur

- API Gateway exponerar klubb- och tävlings-API:t.
- En Node.js 24 Lambda validerar klubblänken, sparar tävlingar och räknar om
  rankingen.
- En krypterad DynamoDB-tabell med point-in-time recovery lagrar klubbmetadata,
  tävlingar och spelare. Varje klubb är en egen partition.
- Klubbens administratörslänk innehåller ett slumpat 128-bitars klubb-id som
  fungerar som länkelhemlighet. Äldre separata länktokens stöds fortsatt.

## Driftsättning

AWS CLI och SAM CLI behöver vara konfigurerade mot önskat AWS-konto.

```bash
sam build
sam deploy --guided
```

Ange frontendens origin som `AllowedOrigin` i guiden (till exempel
`https://turnering.example.se`). Kopiera stack-outputen `ApiUrl` till
`config.js`:

```js
window.MATCHPROTOKOLLET_API = "https://....execute-api.eu-north-1.amazonaws.com/Prod";
```

Servera sedan `index.html` och `config.js` från valfri statisk hosting och
konfigurera history fallback till `index.html` för frontendens rena routes. När
API-adressen är tom fungerar appen i sitt tidigare lokala läge. Knappen
**Klubb** skapar en klubb och visar dess unika länk. Via samma dialog går det
att skapa och öppna flera tävlingar samt se klubbens ranking.

### AWS Amplify Hosting

`amplify.yml` bygger en ren `dist`-artefakt med endast frontendfilerna.
Lägg dessutom till följande regel under **Hosting → Rewrites and redirects**
så att klubb- och tävlingslänkar kan öppnas och laddas om direkt:

```json
[
  {
    "source": "</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json|webp|xml|mp4)$)([^.]+$)/>",
    "target": "/index.html",
    "status": "200",
    "condition": null
  }
]
```

Namnchipsen är klubbdata när appen öppnas via en klubblänk. Listan läses från
DynamoDB och tillägg eller borttagning synkas automatiskt, så samma sparade
namn visas på alla enheter som använder klubbens administratörslänk. Utan
klubblänk används fortsatt webbläsarens lokala namnlista.

Klubbens baslänk öppnar en egen klubbsida i stället för en modal. Där visas
pågående och tidigare tävlingar separat, avslutade tävlingar länkar direkt till
sin publika slutresultatvy och klubbens spelare listas i rankingordning med
aktuella poäng. En spelare kan öppnas för individuell statistik med antal
rankingmatcher, vinster och förluster samt en matchlista som visar motståndare,
tävling, datum och exakt rankingförändring. Om periodtaket ±250 påverkat den
faktiska förändringen framgår det separat. Oavgjorda matcher visas i samma
historik som **±0** och räknas i spelarens match- och oavgjortstatistik.

När en backendansluten tävling delas skapas en publik, skrivskyddad länk med
klubb- och tävlings-id. Länken innehåller aldrig administratörshemligheten.
Varje omladdning hämtar tävlingens senaste resultat från API:t med cache
avstängd.

När deltagarna har klubb-ranking visas **Använd ranking för seedning** och är
förvalt. Spelarna sorteras efter ranking och fördelas snake-vis över poolerna
(A–B–C, C–B–A och så vidare), vilket sprider topprankade spelare. Nya
klubbspelare räknas som 1000 poäng. Checkboxen kan stängas av och
poolplaceringarna kan alltid justeras manuellt.

Spelläget **Davis Cup** är ett lagmöte mellan två lag med två spelare var.
De två första spelarna bildar lag 1 (A och B) och de två sista lag 2 (X och Y);
ordningen kan ändras i inställningarna. Matchordningen är A–X, B–Y, dubbel,
A–Y, B–X. Med matchformen 2 set kan en match sluta 1–1, och mötet kan då sluta
oavgjort. Mötet avslutas när det ledande laget inte längre kan hinnas ikapp,
om inte **Spela alla fem matcher** är valt. Endast singelmatcherna räknas till
klubbens ranking och ger push-notiser; dubbeln påverkar bara lagresultatet.

Via **Importera** på klubbsidan kan en avslutad tävling i JSON-format läggas
till i efterhand. Importvyn föreslår kopplingar mellan JSON-spelarna och
klubbens befintliga spelare med Levenshtein-avstånd; varje koppling kan
kontrolleras och ändras före import. Innan något sparas visar en
förhandsberäkning varje berörd spelares nuvarande ranking, föreslagna ranking
och poängskillnad. Först efter en separat bekräftelse sparas pool- och
slutspelsmatcherna som en avslutad tävling och klubbens ranking räknas om.
En återimport med samma käll-id eller samma stabila importmatch-id ersätter den
tidigare importen. Matcherna läggs alltså inte till i rankingunderlaget en gång
till; om resultat har rättats används den senaste versionen.

Den som följer en pågående klubbtävling kan trycka på **Notiser** och få en
push-notis när en match är färdigspelad, antingen för alla matcher eller bara
för valda spelare. Servern jämför varje sparning med den föregående och skickar
en notis när en match går från ej avgjord till avgjord enligt matchformen
(bollpoäng sparas efter varje set, så ett delresultat ger ingen notis).
VAPID-nycklarna skapas automatiskt vid första användningen och lagras i
tabellen. Prenumerationer förnyas vid varje besök och tas bort automatiskt via
DynamoDB TTL tre dagar efter senaste förnyelsen. På iPhone och iPad fungerar
webbpush bara när sidan har lagts till på hemskärmen.

Avslutade tävlingar får fliken **Slutresultat** i både administratörs- och
publik vy. Cupförlorare som åker ut i samma omgång delar placering (till
exempel delad tredjeplats för semifinalförlorarna), och nästa platsnummer
hoppas över enligt competition-ranking. Poolresultat med helt lika
skiljekriterier visas också som delade placeringar.

## Styra med en AI-assistent (MCP)

Backenden har en MCP-server (Model Context Protocol) så att en AI-assistent
som stöder MCP – till exempel ChatGPT, Claude, VS Code eller Cursor – kan
sätta upp och föra protokoll med röst eller text, till exempel ”skapa en
tävling med Anna, Bo, Cia och Dan i bäst av fem och starta den” eller ”Anna
vann mot Bo med 3–1, 11–7, 8–11, 11–9, 11–5”. Knappen **AI-assistent** på
klubbsidan visar klubbens adress och instruktioner för de vanligaste
klienterna.

MCP-inställningar:

- **Adress:** `{ApiUrl}/mcp/{klubb}` där `{klubb}` är klubbens hemliga id eller
  dess alias, till exempel `…/Prod/mcp/bbtk`. Med alias och åskådarlösenord
  läggs lösenordet till som `?password=…`; det hemliga id:t (som klubbsidan
  visar) fungerar alltid utan lösenord.
- **Transport:** fjärrserver via Streamable HTTP, tillståndslös.
- **Autentisering:** ingen – adressen ger samma åtkomst som klubblänken och ska
  hanteras som en hemlighet.

Exempel för Claude Code:

```bash
claude mcp add --transport http matchprotokoll "{ApiUrl}/mcp/{klubb}"
```

Klienter som läser en `mcp.json` (Cursor med flera):

```json
{"mcpServers": {"matchprotokoll": {"url": "{ApiUrl}/mcp/{klubb}"}}}
```

Verktygen listar klubbens tävlingar och ranking, visar en tävling med
ställningar och matcher, skapar och ändrar tävlingar (spelare, pooler,
spelläge, matchform, slutspel), startar dem, för in och rättar resultat
(setsiffror eller bollpoäng, pool, slutspel och Davis Cup), registrerar set i
Vinnaren står kvar och avslutar tävlingen. Utan angiven tävling används
klubbens senast ändrade pågående tävling. Spelarnamn tolkas skiftlägesokänsligt
och tål små felstavningar; vid tvetydiga namn frågar assistenten i stället för
att gissa. Ändringar som rensar resultat och avslut med ospelade matcher måste
bekräftas uttryckligen.

Servern använder samma sparvägar som appen, så rankingomräkning, push-notiser
och låsningen av avslutade tävlingar fungerar likadant. Varje ändring läser
den senaste versionen och sparas villkorligt; om en annan enhet hann spara
emellan görs ändringen om på den nya versionen. En enhet som redan har tavlan
öppen ser ändringarna efter omladdning eller vid sin nästa sparning.
Tävlingslogiken finns i `backend/tournament.js` och speglar `index.html`; de
två måste hållas i takt.

## API

Alla klubb-anrop utom skapandet använder `Authorization: Bearer <klubb-id>`.
Äldre länkar med en separat token stöds fortsatt.

- `POST /clubs` (`name`, valfritt URL-vänligt `alias` och valfritt `spectatorPassword`;
  ett ledigt alias genereras vid behov)
- `GET /clubs/{clubId}`
- `PUT /clubs/{clubId}/saved-names`
- `GET /clubs/{clubId}/tournaments/{tournamentId}/public` (ingen hemlighet krävs)
- `POST /clubs/{clubId}/tournaments`
- `POST /clubs/{clubId}/tournaments/preview-ranking` (skriver ingen data)
- `POST /clubs/{clubId}/ranking/recalculate`
- `PUT /clubs/{clubId}/tournaments/{tournamentId}`
- `DELETE /clubs/{clubId}/tournaments/{tournamentId}`
- `GET /push/public-key` (ingen hemlighet krävs)
- `PUT /clubs/{clubId}/tournaments/{tournamentId}/push-subscription`
  (`subscription`, valfria `playerIds`; kräver samma åtkomst som den publika vyn)
- `DELETE /clubs/{clubId}/tournaments/{tournamentId}/push-subscription` (`endpoint`)
- `POST /mcp/{clubId}` (MCP Streamable HTTP, tillståndslöst; åtkomst via
  klubbidentifieraren i adressen och valfritt `?password=`)

`{clubId}` kan även vara klubbens alias, till exempel `/clubs/bbtk`.

Klientens sparning är debouncad och pågående tävlingar sparas som utkast.
Knappen **Avsluta tävling** markerar tävlingen som avslutad och inväntar
serverns omedelbara rankingomräkning. Servern räknar alltid om rankingen från
hela den avslutade tävlingshistoriken, så samma uppdatering kan skickas igen
utan att rankingpoäng dubbleras och rättade resultat får rätt effekt.

## Ranking

Alla spelare börjar på 1000 poäng. Beräkningen följer SBTF:s poängtabell:
vinnaren får plus och förloraren lika mycket minus beroende på skillnaden vid
rankingperiodens början. SM/RM/DM ger 1,5 gånger poängen (avrundat nedåt),
WO begränsas till 10 poäng och periodförändringen begränsas till ±250.
Vid oavgjort får den lägre rankade spelaren poäng och den högre rankade tappar
lika mycket; lika rankade spelare får ±0. Förändringen är halva skillnaden
mellan tabellens poäng för en favorit- respektive skrällseger. En avgjord
poolmatch, exempelvis 2–0, är rankinggrundande även när poolformatet också
tillåter resultatet 1–1.

Rankingperioden avgränsas av månadens första måndag, eller nästa vardag när
dagen är en svensk helgdag. SBTF:s årliga normalisering och inaktivitetsregler
är inte automatiserade eftersom de kräver förbundets externa populationsdata
respektive åldersuppgifter.

## Tester

```bash
node --test
sam validate --lint
```
