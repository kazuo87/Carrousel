# Carrousel scientifique

Bot qui génère **toutes les 6 minutes** un nouvel article de vulgarisation scientifique à partir des
dernières publications **PubMed / NCBI**, avec une **illustration scientifique générée**, et l'affiche
dans un **carrousel** web **trilingue (français, anglais, arabe)**. Sujets couverts : pharmaceutique,
peptides thérapeutiques, nouveaux médicaments, biosimilaires, biologiques & anticorps, essais
cliniques, thérapie génique & ARN, anti-infectieux.

```
PubMed (E-utilities) ──▶ filtre nouveauté + pertinence ──▶ rédaction (Claude) ──▶ illustration ──▶ carrousel
      esearch/efetch        PMID/DOI/titre jamais vus        repli extractif        SVG / OpenAI     HTTP + SSE
```

## Démarrage rapide

```bash
npm install
cp .env.example .env        # puis renseigner ANTHROPIC_API_KEY (et NCBI_EMAIL)…
echo "ANTHROPIC_API_KEY=sk-ant-…" >> .env   # …ou simplement ajouter les lignes en fin de fichier
npm start                   # http://localhost:3000
```

Le bot génère un premier article immédiatement, puis un nouvel article toutes les 6 minutes
(`INTERVAL_MINUTES`), sur une grille de temps fixe (la durée d'un tour ne décale pas les suivants ; un
créneau manqué est sauté, pas rattrapé). Le carrousel se met à jour en direct (flux SSE) sans
recharger la page.

Sans `ANTHROPIC_API_KEY`, le bot fonctionne quand même : les articles sont construits par un
générateur **extractif** (sections et points clés tirés du résumé PubMed ; le corps reste en anglais,
seuls les intitulés sont traduits). Avec la clé, Claude rédige chaque article dans toutes les langues
de `LANGUAGES` (par défaut `fr,en,ar`) en un seul appel, et le carrousel bascule instantanément de
l'une à l'autre.

### Docker

```bash
docker compose up -d --build      # lit .env, persiste les données dans le volume carrousel-data
```

## Fonctionnement

### 1. Recherche PubMed (`src/pubmed.js`, `src/topics.js`)

À chaque tour, le bot prend le sujet suivant de la rotation et interroge `esearch.fcgi` avec la
requête du sujet, restreinte aux notices **ajoutées récemment à PubMed** (`datetype=edat`) : d'abord
les 14 derniers jours, puis des fenêtres disjointes de plus en plus anciennes (J-60 à J-14, puis J-365
à J-60) si rien de nouveau, chaque fenêtre étant parcourue par pages de 40 identifiants (5 pages au
plus). Les requêtes exigent un résumé disponible, l'anglais, et excluent errata, commentaires et
lettres. Les notices retenues sont téléchargées via `efetch.fcgi` (XML) et analysées : titre, résumé
(structuré ou non), revue, dates, auteurs, DOI, types de publication, MeSH, mots-clés.

Le client respecte l'étiquette NCBI : paramètres `tool` et `email`, clé API optionnelle
(`NCBI_API_KEY`), limitation de débit (3 req/s sans clé, 10 avec), nouvelles tentatives sur 429/5xx.

### 2. Nouveauté et pertinence (`src/relevance.js`)

- **Nouveauté** : un PMID, un DOI ou un titre normalisé déjà publié n'est jamais repris
  (`data/seen.json`, persistant entre redémarrages). Les notices lues mais écartées sont aussi
  mémorisées : définitivement (erratum, résumé absent, identifiant sans notice) ou seulement pour le
  sujet qui les a rejetées, de sorte qu'un article hors sujet pour « peptides » reste candidat pour
  « biosimilaires ».
- **Pertinence** : une notice sans aucun mot-clé du sujet (titre, résumé, MeSH, mots-clés auteurs) est
  écartée d'office ; sinon son score combine ces mots-clés (titre ×3, MeSH ×2, mots-clés auteurs ×1,5,
  résumé ×0,5), le type de publication (essai randomisé, phase II/III, méta-analyse…), la richesse du
  résumé et la fraîcheur. Errata, rétractations, commentaires et résumés trop courts sont exclus.
  Seules les notices au-dessus de `MIN_RELEVANCE` sont retenues ; sinon le tour passe au sujet suivant.

### 3. Rédaction (`src/generate/article.js`)

Claude (`claude-opus-5-5` par défaut, SDK Anthropic) reçoit la notice complète et renvoie, **en un seul
appel**, une version de l'article par langue demandée (`LANGUAGES`, par défaut français, anglais et
arabe standard moderne), chacune **structurée** (titre, sous-titre, chapô, sections, points clés, tags,
texte alternatif) plus un prompt d'illustration commun, le tout validé par un schéma Zod. Les trois
versions sont rédigées ensemble pour transmettre exactement les mêmes faits et réserves ; en arabe, les
dénominations de médicaments et les sigles restent en caractères latins. Consignes : fidélité stricte
au résumé, aucune donnée inventée,
distinction préclinique/clinique, limites explicites, pas de conseil médical. Le repli serveur sur
refus de politique est activé (`CLAUDE_FALLBACKS=default`). En cas de refus, de troncature, de réponse
hors schéma ou d'erreur réseau/limite de débit, le tour bascule sur le générateur extractif ; des
identifiants absents ou refusés désactivent Claude pour le reste du processus (le bot continue en
extractif). Les identifiants sont résolus par le SDK (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` ou
profil `ant auth login`).

### 4. Illustration (`src/generate/svg-art.js`, `src/generate/image.js`)

- `IMAGE_PROVIDER=svg` (défaut) : illustration scientifique **procédurale** et déterministe (graine =
  PMID), thématisée : chaîne peptidique, anticorps IgG, graphe moléculaire, gélules + courbe
  dose-réponse, double hélice, cellules/bactéries, courbes de survie.
- `IMAGE_PROVIDER=openai` : image générée par `gpt-image-1` à partir du prompt rédigé avec l'article
  (clé `OPENAI_API_KEY`), avec repli automatique sur le SVG en cas d'erreur.

### 5. Carrousel (`public/`, `src/server.js`)

Carrousel accessible (clavier, balayage tactile, lecture/pause, points de navigation, barre de
progression, filtres par sujet, diapositives masquées inertes, respect de `prefers-reduced-motion`),
fiche article complète avec sources (PMID, DOI, revue, auteurs), compte à rebours jusqu'au prochain
article, insertion en direct des nouveaux articles (flux SSE, avec rattrapage après une coupure) et
**sélecteur de langue FR / EN / AR** dans l'en-tête : menu, sujets, dates et articles basculent
instantanément, avec affichage de droite à gauche pour l'arabe (le choix est mémorisé dans le
navigateur ; la langue par défaut est `ARTICLE_LANGUAGE`).

## API

| Méthode | Route | Description |
|---|---|---|
| GET | `/` | Le carrousel |
| GET | `/api/articles?limit=30&offset=0&topic=` | Articles, du plus récent au plus ancien (`content.fr`, `content.en`, `content.ar` ; champs de premier niveau dans la langue principale) |
| GET | `/api/articles/:id` | Un article |
| GET | `/api/topics` | Sujets configurés |
| GET | `/api/status` | État du planificateur, prochain tour, générateurs utilisés |
| GET | `/api/events` | Flux SSE : événement `article` à chaque nouvel article |
| GET | `/images/:fichier` | Illustrations générées |
| POST | `/api/run` | Déclenche un tour immédiatement (`Authorization: Bearer ADMIN_TOKEN` ; sans jeton configuré, seulement depuis une connexion locale directe, sans reverse proxy ni origine navigateur étrangère) |
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
| `LANGUAGES` | `fr,en,ar` | Langues produites et proposées (`fr`, `en`, `ar`) |
| `ARTICLE_LANGUAGE` | première de `LANGUAGES` | Langue principale (interface par défaut, champs de premier niveau de l'API) |
| `TOPICS` | tous | Sous-ensemble et ordre de rotation des sujets |
| `ANTHROPIC_API_KEY` | — | Rédaction par Claude (sinon extractif) |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` | `claude-opus-5-5` / `medium` | Modèle et effort de raisonnement |
| `NCBI_API_KEY` / `NCBI_EMAIL` | — | Identification auprès de NCBI |
| `IMAGE_PROVIDER` | `svg` | `svg` ou `openai` |
| `ADMIN_TOKEN` | — | Protège `POST /api/run` |
| `DATA_DIR` | `data` | Emplacement des données persistantes |

### Coût indicatif

À 6 minutes d'intervalle, le bot rédige 240 articles par jour. Avec `claude-opus-5-5` et les trois
langues, environ 2 000 jetons d'entrée par article et 4 000 à 6 000 jetons de sortie (trois versions
et raisonnement adaptatif compris, selon `CLAUDE_EFFORT`), comptez de l'ordre de 25 à 35 $ par jour ;
`LANGUAGES=fr` ramène la sortie à un tiers et `CLAUDE_MODEL=claude-sonnet-5-5` divise le coût par deux.
Le prompt système est trop court pour bénéficier du cache de prompts. Le générateur extractif et les
illustrations SVG sont gratuits.

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

## Robustesse

- Un fichier de données illisible (écriture interrompue, disque plein) est mis de côté
  (`*.corrompu-<horodatage>`) et le bot repart des valeurs par défaut ; les fichiers temporaires et
  les illustrations orphelines sont nettoyés au démarrage.
- Un sujet en erreur (requête refusée par NCBI, panne) n'empêche pas les autres : le curseur avance et
  le tour suivant reprend au sujet d'après.
- Les requêtes réseau (NCBI, Claude, OpenAI) ont toutes un délai maximal ; un tour ne peut pas bloquer
  indéfiniment le planificateur, et un tour encore en cours fait sauter le créneau suivant plutôt que
  de se superposer.
- Les promesses rejetées sans gestionnaire sont journalisées ; une exception non rattrapée arrête le
  processus avec un code d'erreur (à relancer par Docker ou un superviseur).

## Avertissement

Les articles sont générés automatiquement à partir des **résumés** PubMed (pas du texte intégral).
Ils ne constituent pas un avis médical et doivent être vérifiés avant tout usage professionnel. Les
sources (PMID, DOI) sont affichées sur chaque fiche.
