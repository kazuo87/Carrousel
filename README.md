# Carrousel scientifique

Bot qui génère **toutes les 6 minutes** un nouvel article de vulgarisation scientifique à partir des
dernières publications **PubMed / NCBI**, avec une **illustration scientifique générée**, et l'affiche
dans un **carrousel** web. Sujets couverts : pharmaceutique, peptides thérapeutiques, nouveaux
médicaments, biosimilaires, biologiques & anticorps, essais cliniques, thérapie génique & ARN,
anti-infectieux.

```
PubMed (E-utilities) ──▶ filtre nouveauté + pertinence ──▶ rédaction (Claude) ──▶ illustration ──▶ carrousel
      esearch/efetch        PMID/DOI/titre jamais vus        repli extractif        SVG / OpenAI     HTTP + SSE
```

## Démarrage rapide

```bash
npm install
cp .env.example .env        # puis renseigner ANTHROPIC_API_KEY (et NCBI_EMAIL)
npm start                   # http://localhost:3000
```

Le bot génère un premier article immédiatement, puis un nouvel article toutes les 6 minutes
(`INTERVAL_MINUTES`). Le carrousel se met à jour en direct (flux SSE) sans recharger la page.

Sans `ANTHROPIC_API_KEY`, le bot fonctionne quand même : les articles sont construits par un
générateur **extractif** (sections et points clés tirés du résumé PubMed, en anglais). Avec la clé,
les articles sont rédigés en français (ou en anglais, `ARTICLE_LANGUAGE=en`) par Claude.

### Docker

```bash
docker compose up -d --build      # lit .env, persiste les données dans le volume carrousel-data
```

## Fonctionnement

### 1. Recherche PubMed (`src/pubmed.js`, `src/topics.js`)

À chaque tour, le bot prend le sujet suivant de la rotation et interroge `esearch.fcgi` avec la
requête du sujet, restreinte aux notices **ajoutées récemment à PubMed** (`datetype=edat`,
`reldate=14` jours, puis 60 et 365 jours si rien de nouveau), avec résumé disponible, en anglais, sans
errata/commentaires/lettres. Les notices retenues sont téléchargées via `efetch.fcgi` (XML) et
analysées : titre, résumé (structuré ou non), revue, dates, auteurs, DOI, types de publication, MeSH,
mots-clés.

Le client respecte l'étiquette NCBI : paramètres `tool` et `email`, clé API optionnelle
(`NCBI_API_KEY`), limitation de débit (3 req/s sans clé, 10 avec), nouvelles tentatives sur 429/5xx.

### 2. Nouveauté et pertinence (`src/relevance.js`)

- **Nouveauté** : un PMID, un DOI ou un titre normalisé déjà traité n'est jamais repris
  (`data/seen.json`, persistant entre redémarrages). Les notices lues mais rejetées sont aussi mémorisées.
- **Pertinence** : score fondé sur les mots-clés du sujet (titre ×3, MeSH ×2, mots-clés auteurs ×1,5,
  résumé ×0,5), le type de publication (essai randomisé, phase II/III, méta-analyse…), la richesse du
  résumé et la fraîcheur. Errata, rétractations, commentaires et résumés trop courts sont exclus.
  Seules les notices au-dessus de `MIN_RELEVANCE` sont retenues ; sinon le tour passe au sujet suivant.

### 3. Rédaction (`src/generate/article.js`)

Claude (`claude-opus-5-5` par défaut, SDK Anthropic) reçoit la notice complète et renvoie un article
**structuré** (titre, sous-titre, chapô, sections, points clés, tags, prompt d'illustration, texte
alternatif) validé par un schéma Zod. Consignes : fidélité stricte au résumé, aucune donnée inventée,
distinction préclinique/clinique, limites explicites, pas de conseil médical. Le prompt système est
mis en cache (prompt caching) ; le repli serveur sur refus de politique est activé
(`CLAUDE_FALLBACKS=default`). En cas de refus, de troncature, de réponse hors schéma ou d'erreur
réseau/limite de débit, le tour bascule sur le générateur extractif ; une erreur d'authentification
désactive Claude pour le reste du processus (le bot continue en extractif).

### 4. Illustration (`src/generate/svg-art.js`, `src/generate/image.js`)

- `IMAGE_PROVIDER=svg` (défaut) : illustration scientifique **procédurale** et déterministe (graine =
  PMID), thématisée : chaîne peptidique, anticorps IgG, graphe moléculaire, gélules + courbe
  dose-réponse, double hélice, cellules/bactéries, courbes de survie.
- `IMAGE_PROVIDER=openai` : image générée par `gpt-image-1` à partir du prompt rédigé avec l'article
  (clé `OPENAI_API_KEY`), avec repli automatique sur le SVG en cas d'erreur.

### 5. Carrousel (`public/`, `src/server.js`)

Carrousel accessible (clavier, balayage tactile, lecture/pause, points de navigation, barre de
progression, filtres par sujet), fiche article complète avec sources (PMID, DOI, revue, auteurs),
compte à rebours jusqu'au prochain article et insertion en direct des nouveaux articles.

## API

| Méthode | Route | Description |
|---|---|---|
| GET | `/` | Le carrousel |
| GET | `/api/articles?limit=30&offset=0&topic=` | Articles, du plus récent au plus ancien |
| GET | `/api/articles/:id` | Un article |
| GET | `/api/topics` | Sujets configurés |
| GET | `/api/status` | État du planificateur, prochain tour, générateurs utilisés |
| GET | `/api/events` | Flux SSE : événement `article` à chaque nouvel article |
| GET | `/images/:fichier` | Illustrations générées |
| POST | `/api/run` | Déclenche un tour immédiatement (`Authorization: Bearer ADMIN_TOKEN`, ou localhost sans jeton) |
| GET | `/healthz` | Sonde de vie |

## Commandes

```bash
npm start            # serveur + génération automatique
npm run once         # génère un seul article puis quitte (utile en cron ou pour tester)
npm run serve        # serveur seul, sans génération
npm test             # tests (node:test, sans réseau)
npm run mock:eutils  # faux serveur E-utilities local (PUBMED_BASE_URL=http://localhost:8765)
```

Démonstration hors ligne complète :

```bash
npm run mock:eutils &
PUBMED_BASE_URL=http://localhost:8765 INTERVAL_MINUTES=0.1 npm start
```

## Configuration

Toutes les options sont documentées dans [`.env.example`](.env.example). Les plus utiles :

| Variable | Défaut | Rôle |
|---|---|---|
| `INTERVAL_MINUTES` | `6` | Cadence de génération |
| `ARTICLE_LANGUAGE` | `fr` | Langue des articles (`fr` / `en`) |
| `TOPICS` | tous | Sous-ensemble et ordre de rotation des sujets |
| `ANTHROPIC_API_KEY` | — | Rédaction par Claude (sinon extractif) |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` | `claude-opus-5-5` / `medium` | Modèle et effort de raisonnement |
| `NCBI_API_KEY` / `NCBI_EMAIL` | — | Identification auprès de NCBI |
| `IMAGE_PROVIDER` | `svg` | `svg` ou `openai` |
| `ADMIN_TOKEN` | — | Protège `POST /api/run` |
| `DATA_DIR` | `data` | Emplacement des données persistantes |

### Coût indicatif

À 6 minutes d'intervalle, le bot rédige 240 articles par jour. Avec `claude-opus-5-5` et environ
2 000 jetons d'entrée (dont le prompt système en cache) et 1 500 jetons de sortie par article, comptez
de l'ordre de 10 $ par jour ; `CLAUDE_MODEL=claude-sonnet-5-5` divise ce coût par deux. Le générateur
extractif et les illustrations SVG sont gratuits.

## Structure

```
src/
  index.js            point d'entrée (serveur + planificateur)
  cli.js              once | serve
  app.js              assemblage des composants
  config.js           variables d'environnement (+ .env)
  topics.js           sujets, requêtes PubMed, mots-clés, thèmes visuels
  pubmed.js           client E-utilities + analyse XML
  relevance.js        score de pertinence, nouveauté
  pipeline.js         un tour : recherche → sélection → rédaction → image → enregistrement
  scheduler.js        cadence fixe sans chevauchement
  store.js            persistance JSON atomique (articles, vus, état)
  server.js           HTTP, API, SSE, images
  generate/
    article.js        rédaction avec Claude (sortie structurée) + repli
    extractive.js     générateur extractif sans LLM
    image.js          fournisseurs d'illustration (svg, openai)
    svg-art.js        illustrations scientifiques procédurales
public/               carrousel (HTML/CSS/JS sans dépendance)
test/                 tests node:test, fixtures PubMed, faux serveur E-utilities
data/                 articles.json, seen.json, state.json, images/ (ignoré par git)
```

## Avertissement

Les articles sont générés automatiquement à partir des **résumés** PubMed (pas du texte intégral).
Ils ne constituent pas un avis médical et doivent être vérifiés avant tout usage professionnel. Les
sources (PMID, DOI) sont affichées sur chaque fiche.
