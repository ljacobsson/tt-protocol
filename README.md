# Matchprotokollet

En mobilanpassad tävlingsapp för rundpool, poolspel och slutspel. Appen kan
fortfarande köras helt lokalt, men innehåller också en AWS SAM-backend för
klubbar, flera tävlingar per klubb och beständig spelarranking.

## AWS-arkitektur

- API Gateway exponerar klubb- och tävlings-API:t.
- En Node.js 24 Lambda validerar klubblänken, sparar tävlingar och räknar om
  rankingen.
- En krypterad DynamoDB-tabell med point-in-time recovery lagrar klubbmetadata,
  tävlingar och spelare. Varje klubb är en egen partition.
- Klubbens administratörslänk innehåller ett slumpat klubb-id och en 256-bitars
  hemlighet. Endast SHA-256-hashen av hemligheten lagras.

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

Servera sedan `index.html` och `config.js` från valfri statisk hosting. När
API-adressen är tom fungerar appen i sitt tidigare lokala läge. Knappen
**Klubb** skapar en klubb och visar dess unika länk. Via samma dialog går det
att skapa och öppna flera tävlingar samt se klubbens ranking.

När en backendansluten tävling delas skapas en publik, skrivskyddad länk med
klubb- och tävlings-id. Länken innehåller aldrig administratörshemligheten.
Varje omladdning hämtar tävlingens senaste resultat från API:t med cache
avstängd.

När deltagarna har klubb-ranking visas **Använd ranking för seedning** och är
förvalt. Spelarna sorteras efter ranking och fördelas snake-vis över poolerna
(A–B–C, C–B–A och så vidare), vilket sprider topprankade spelare. Nya
klubbspelare räknas som 1000 poäng. Checkboxen kan stängas av och
poolplaceringarna kan alltid justeras manuellt.

## API

Alla klubb-anrop utom skapandet använder
`Authorization: Bearer <hemligheten-från-klubblänken>`.

- `POST /clubs`
- `GET /clubs/{clubId}`
- `GET /clubs/{clubId}/tournaments/{tournamentId}/public` (ingen hemlighet krävs)
- `POST /clubs/{clubId}/tournaments`
- `PUT /clubs/{clubId}/tournaments/{tournamentId}`
- `DELETE /clubs/{clubId}/tournaments/{tournamentId}`

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
Matcher som kan sluta oavgjort rankas inte; därför är poolspelets format
**2 set** inte rankinggrundande, medan dess avgjorda slutspelsmatcher är det.

Rankingperioden avgränsas av månadens första måndag, eller nästa vardag när
dagen är en svensk helgdag. SBTF:s årliga normalisering och inaktivitetsregler
är inte automatiserade eftersom de kräver förbundets externa populationsdata
respektive åldersuppgifter.

## Tester

```bash
node --test
sam validate --lint
```
