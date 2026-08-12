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

Avslutade tävlingar får fliken **Slutresultat** i både administratörs- och
publik vy. Cupförlorare som åker ut i samma omgång delar placering (till
exempel delad tredjeplats för semifinalförlorarna), och nästa platsnummer
hoppas över enligt competition-ranking. Poolresultat med helt lika
skiljekriterier visas också som delade placeringar.

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
- `PUT /clubs/{clubId}/tournaments/{tournamentId}`
- `DELETE /clubs/{clubId}/tournaments/{tournamentId}`

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
