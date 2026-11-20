# Galeries privées

Plan technique. Rien n'est implémenté à ce jour.

Les photographies restent stockées sur kDrive, et uniquement là. Le serveur
d'administration ne fait que les relayer, avec un cache mémoire de cinq minutes
pour l'affichage et un cache disque temporaire pour les archives.

Objectif : livrer à un client ou à un proche un ensemble de photos protégé par un
code, visible avec la même présentation que la galerie publique, téléchargeable
photo par photo ou en une archive.

## 1. Décisions structurantes

### 1.1 Les photos privées ne sont jamais publiées

Un nouveau statut `private` s'ajoute aux statuts existants des fiches photo.
Le site public filtre partout sur `status === 'published'` (`src/pages/index.astro`,
`src/pages/series/[slug].astro`, recherche, carte, RSS, sitemap) : une photo
`private` sort donc du site public sans aucune modification de ces pages.
Le relais `GET /api/public/kdrive` refuse déjà tout ce qui n'est pas `published`
(`core/portfolio/kdrive-media.ts`), elle n'est donc pas davantage servie par là.

Deux enums à étendre, sinon le build échoue sur une fiche `private` :

- `src/content.config.ts:36` — `z.enum(['published','draft','trash'])`
- `Admin-Sites-Astro/sites/portfolio-photo/schemas.ts:42` — mêmes valeurs plus `archived`

### 1.2 Un sous-domaine servi par le VPS : `prive.stan-bouchet.fr`

C'est le point le plus contraignant du dossier. Le site est statique chez
O2Switch, l'API et les images sont sur le VPS : un cookie de session posé par
`admin.stan-bouchet.fr` pour une page de `stan-bouchet.eu` est un cookie tiers,
que Safari bloque. Sans cookie, il reste le jeton passé en paramètre d'URL sur
chaque `<img>`, qui fuit dans les en-têtes `Referer` et dans les journaux.

Solution retenue, validée : le dossier `dist/` est déployé **aussi** sur le VPS, et Caddy
sert `prive.stan-bouchet.fr` en statique depuis ce dossier, avec `/api/*`
proxifié vers Next. Le nom est en `.fr` et non en `.eu` : c'est le domaine de
tous les services du VPS, dont `admin.stan-bouchet.fr`, et sa zone est chez
Infomaniak, là où tourne le serveur. Seule compte l'égalité d'origine entre la
page et son API ; le domaine du site public n'entre pas en jeu. La page privée et son API partagent alors la même origine :
cookie `__Host-` first-party, pas de CORS, pas de jeton dans les URL, et le ZIP
part directement du VPS sans transiter par l'hébergement mutualisé.

Conséquences :

- un vhost à ajouter dans le Caddyfile du VPS (vérifier les ports occupés, le
  Caddyfile en production diffère de celui du dépôt) ;
- une étape de déploiement supplémentaire dans `.github/workflows/deploy.yml`,
  en rsync/SSH vers le VPS, après le build, en parallèle du FTP O2Switch ;
- `prive.stan-bouchet.fr` sert techniquement tout le site : les URL hors
  `/prive/` y répondent en 301 vers `stan-bouchet.eu`, et un `robots.txt` propre
  à cet hôte interdit l'indexation, pour éviter le contenu dupliqué.

Repli si le sous-domaine n'est pas souhaité : jeton de session en `localStorage`
envoyé en en-tête `Authorization`, et jeton court (15 min, renouvelé) en
paramètre sur les images. Cela fonctionne, mais c'est moins étanche.

### 1.3 Le code d'accès est chiffré, pas haché

Un code haché en argon2 est irrécupérable : au premier « j'ai perdu le code »,
il n'y a plus qu'à en générer un autre. Comme il ne s'agit pas d'un mot de passe
d'utilisateur mais d'un code de partage que tu dois pouvoir redonner, il est
stocké chiffré en AES-256-GCM avec une clé dédiée (`GALLERY_CODE_KEY` dans le
`.env` du VPS), donc lisible dans l'administration et révocable.

La compensation se fait sur la force du code et sur la limitation de débit :
code de 10 caractères sans ambiguïté visuelle (ni `0`/`O`, ni `1`/`l`), ou
quatre mots courants, et `isRateLimited` sur `galerie:<slug>` à 10 essais par
quart d'heure et par IP (`core/auth/rate-limit.ts`, déjà en place).

### 1.4 Organisation sur kDrive

Le stockage ne change pas : les fichiers restent sur kDrive et continuent d'être
servis par le serveur d'administration. Les galeries privées rangent simplement
leurs fichiers dans un dossier dédié :

```
Photographies - Galerie Photo/
├── Bourges — 2025-05-29/          (séries publiques, inchangé)
├── Instants — 2026-11-18/
└── Privé/
    ├── repetition-moise/
    └── mariage-dupont/
```

Un dossier par galerie, nommé d'après son identifiant d'URL. Il contient, pour
chaque photo, l'original et les trois versions `thumb`, `web` et `zoom`, comme
les imports actuels.

`KdriveStorage` ne sait chercher et créer qu'un dossier directement sous sa
racine. Plutôt que de le modifier, l'import compose deux instances : la première
résout `Privé` sous la racine habituelle, la seconde prend ce dossier pour
racine et y résout la galerie. Les deux sont construites sans `categoryName`,
donc `tagFolder` ne leur applique pas la catégorie « Galerie Photos » réservée
aux séries publiques.

L'identifiant du dossier est retenu sur la galerie (`kdrive_directory`) : il
n'est cherché qu'une fois, pas à chaque photo importée.

## 2. Modèle de données

Dans la base SQLite de l'administration (`core/db/index.ts`, schéma créé par
`CREATE TABLE IF NOT EXISTS` au démarrage, pas de migrations formelles).

```sql
CREATE TABLE IF NOT EXISTS private_galleries (
  id                 TEXT PRIMARY KEY,
  slug               TEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  preset             TEXT NOT NULL DEFAULT 'share',   -- 'share' | 'delivery'
  status             TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'open' | 'closed'
  message            TEXT,
  expires_at         INTEGER,                         -- NULL = pas d'expiration
  download_versions  TEXT NOT NULL DEFAULT '["web"]', -- JSON parmi web/zoom/original
  download_locked    INTEGER NOT NULL DEFAULT 0,
  watermark          INTEGER NOT NULL DEFAULT 0,
  selection_enabled  INTEGER NOT NULL DEFAULT 0,
  selection_quota    INTEGER,
  selection_hard     INTEGER NOT NULL DEFAULT 0,      -- bloquer au-delà du quota
  comments_enabled   INTEGER NOT NULL DEFAULT 0,
  log_enabled        INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS private_gallery_photos (
  gallery_id  TEXT NOT NULL REFERENCES private_galleries(id) ON DELETE CASCADE,
  photo_slug  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (gallery_id, photo_slug)
);

CREATE TABLE IF NOT EXISTS private_gallery_codes (
  id          TEXT PRIMARY KEY,
  gallery_id  TEXT NOT NULL REFERENCES private_galleries(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,          -- 'Les mariés', 'Maman', 'Accès unique'
  code_cipher TEXT NOT NULL,          -- AES-256-GCM
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS private_gallery_selections (
  gallery_id   TEXT NOT NULL REFERENCES private_galleries(id) ON DELETE CASCADE,
  code_id      TEXT NOT NULL REFERENCES private_gallery_codes(id) ON DELETE CASCADE,
  photo_slug   TEXT NOT NULL,
  comment      TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (gallery_id, code_id, photo_slug)
);

CREATE TABLE IF NOT EXISTS private_gallery_validations (
  gallery_id   TEXT NOT NULL REFERENCES private_galleries(id) ON DELETE CASCADE,
  code_id      TEXT NOT NULL REFERENCES private_gallery_codes(id) ON DELETE CASCADE,
  validated_at INTEGER NOT NULL,
  PRIMARY KEY (gallery_id, code_id)
);

CREATE TABLE IF NOT EXISTS private_gallery_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  gallery_id TEXT NOT NULL REFERENCES private_galleries(id) ON DELETE CASCADE,
  code_id    TEXT,
  kind       TEXT NOT NULL,   -- 'open' | 'view' | 'download' | 'zip' | 'validate'
  photo_slug TEXT,
  ip_hash    TEXT,            -- hashIp, jamais l'IP en clair
  created_at INTEGER NOT NULL
);
```

La sélection est rattachée au code, pas à la galerie : chaque invité a la sienne,
et l'écran d'administration peut compter les votes par photo.

## 3. API

Servie par Next sur `prive.stan-bouchet.fr/api/galerie/...`, hors du périmètre
d'authentification de l'administration (comme `/api/public/*` aujourd'hui).

| Route | Effet |
| --- | --- |
| `POST /auth` | `{slug, code}` → vérifie, pose le cookie de session, renvoie les réglages de la galerie |
| `POST /logout` | efface la session |
| `GET /:slug` | métadonnées, liste ordonnée des photos, sélection en cours, quota |
| `GET /:slug/image` | `photo`, `version` (`thumb`/`web`/`zoom`), filigrane appliqué si activé |
| `GET /:slug/download` | une photo, `Content-Disposition: attachment`, version autorisée seulement |
| `GET /:slug/zip` | `scope=all|selection`, archive |
| `GET /:slug/zip/status` | avancement de la préparation d'archive |
| `PUT /:slug/selection` | `{photo, selected}` et `{photo, comment}` — commenter une photo la retient |
| `POST /:slug/validate` | fige la sélection et l'horodate |

Session : JWT signé avec `jose` (déjà installé), portant `gallery_id`, `code_id`
et une expiration de sept jours, dans un cookie `__Host-galerie`, `HttpOnly`,
`Secure`, `SameSite=Lax`. Chaque requête revérifie en base que la galerie est
toujours `open`, non expirée, et que le code n'est pas révoqué — sans quoi une
révocation resterait sans effet pendant sept jours.

Toute réponse d'image ou de données privée part en `Cache-Control: private, no-store`,
à l'inverse des images publiques qui sont en cache public cinq minutes.

## 4. Site public

Une page Astro `src/pages/prive/index.astro`, en `noindex`, hors sitemap et hors
RSS, qui réutilise `Gallery.astro`, `PhotoCard.astro` et `Lightbox.astro`.
Différence avec le reste du site : la liste des photos n'est pas connue au build,
elle est chargée par `fetch` après la saisie du code, donc la grille est remplie
côté navigateur à partir des mêmes composants rendus en gabarit.

Parcours : `prive.stan-bouchet.fr/prive/?g=mariage-dupont` → écran de code →
grille → lightbox. Un bouton « Tout télécharger » en tête de page, un bouton de
téléchargement dans la lightbox, et, si la sélection est active, une étoile sur
chaque vignette, un compteur `14 / 20` et un filtre « ma sélection ».

Accessibilité : même exigence que le reste du site, l'étoile est un vrai
`button` avec `aria-pressed`, le compteur est une zone `aria-live`, et la
navigation au clavier de la lightbox existante est conservée.

## 5. Format livré : JPEG

Le client repart avec du JPEG, pour le téléchargement unitaire comme pour
l'archive, parce que le WebP est encore refusé par une partie des labos de
tirage et des logiciels anciens.

L'import n'accepte que JPEG, PNG, TIFF et WebP (`ALLOWED_MIME`,
`app/api/sites/portfolio-photo/upload/route.ts:41`), jamais de RAW. Dans le cas
courant l'original est donc déjà le JPEG sorti du boîtier : il est livré tel
quel, sans conversion ni perte. Les autres cas (PNG, TIFF, WebP) sont convertis
par `sharp` en JPEG qualité 95, au moment de préparer l'archive, avec le profil
colorimétrique et les données EXIF conservés.

Les aperçus à l'écran restent en WebP : c'est plus léger, et le navigateur s'en
accommode très bien.

## 6. Archive ZIP

Génération à la demande, écrite dans un cache disque du VPS
(`storage/galeries/<gallery_id>-<empreinte>.zip`), puis servie comme un fichier
statique. C'est ce qui permet la reprise de téléchargement : un flux assemblé à
la volée n'a ni taille connue ni support des requêtes `Range`, et la moindre
coupure chez le client fait tout recommencer — sur plusieurs gigaoctets, c'est
rédhibitoire.

- `yazl` en mode `store`, sans compression : des WebP et des JPEG ne gagnent
  rien à être recompressés, et cela divise le temps de préparation.
- L'empreinte couvre la liste des photos, la version demandée et le périmètre
  (`all` ou `selection`) : si la galerie change, l'archive est régénérée.
- La première demande renvoie un identifiant de préparation ; la page interroge
  `/zip/status` et affiche une progression, puis déclenche le téléchargement.
- Purge automatique des archives inutilisées après sept jours, et au-delà d'un
  plafond de disque.

Dimensionnement, sur la base d'une centaine de photos par livraison : un JPEG de
Canon 90D pèse entre 8 et 12 Mo, soit environ 1 Go par archive. Un plafond de
10 Go laisse donc une dizaine de galeries actives en cache. Vérifier la place
libre du VPS avant de déployer, le disque étant partagé avec les autres projets.

Ce cache est la seule copie hors kDrive, et c'est une copie temporaire d'un
fichier reconstructible : les photos, elles, ne sont stockées que sur kDrive.

## 7. Filigrane

Appliqué à la volée par `sharp` au moment de servir l'image, jamais sur le
fichier stocké dans kDrive : le retirer après paiement revient à décocher une
case, pas à réimporter. Un motif SVG répète le texte en diagonale, à 26 %
d'opacité, avec une taille proportionnelle à la largeur de l'image pour rester
lisible de la vignette au zoom. `GALLERY_WATERMARK_TEXT` change le texte.

Le cache mémoire de `kdrive-media.ts` est repris tel quel, avec une clé
distincte pour les versions filigranées. Le téléchargement autorisé sert
toujours le fichier propre : le filigrane protège l'aperçu, le verrou de
téléchargement protège le fichier.

## 8. Administration

Un écran `app/(admin)/sites/portfolio-photo/galeries/`, entrée dans
`PortfolioNav`, construit avec les composants déjà en place (base-ui, sonner,
`Badge`, `Button`).

- Liste des galeries : nom, état, nombre de photos, expiration, dernière visite.
- Création : nom, choix des photos depuis la bibliothèque existante (y compris
  les `private`), et deux préréglages.
- Les préréglages ne sont que des boutons qui positionnent huit interrupteurs
  indépendants ; tout reste ajustable ensuite.

| Réglage | Partage | Livraison client |
| --- | --- | --- |
| Filigrane | non | oui |
| Téléchargement verrouillé | non | oui, jusqu'à validation |
| Sélection | non | oui |
| Quota | — | selon la prestation |
| Commentaires par photo | non | oui |
| Codes multiples | un seul | un par invité |
| Journal d'accès | compteur simple | détaillé |
| Expiration | aucune | trois mois |

- Fiche galerie : photos retenues avec le nombre de votes quand il y a plusieurs
  invités, commentaires, journal, et deux actions — télécharger la sélection,
  créer une galerie de livraison à partir de la sélection.

## 9. Lots

1. **Le nécessaire** (fait) — statut `private`, tables, `POST /auth`, liste,
   images, téléchargement unitaire, ZIP, page `/prive/`, vhost Caddy et
   déploiement VPS, écran d'administration (créer, choisir les photos, un code),
   et import direct dans `Privé/<galerie>` depuis l'atelier d'import.
2. **La sélection** (fait) — bouton « Je la garde » sur chaque vignette et dans
   la visionneuse, compteur et quota, filtre « ma sélection », archive de la
   seule sélection, commentaire par photo, validation qui fige tout, et dans
   l'administration le nombre de voix par photo, les commentaires et la
   réouverture d'une sélection validée.
3. **Le reste** (fait) — filigrane sur les aperçus, codes par invité avec
   révocation, journal des passages, fin d'accès réglable et prolongation en un
   clic, courriel à la première ouverture et à la validation d'une sélection.

Les trois lots se déploient ensemble.

## 10. Tests

- Côté administration, `vitest` : vérification du code et limitation de débit,
  étanchéité (une photo absente de la galerie n'est jamais servie, une galerie
  expirée ou fermée renvoie 404), empreinte d'archive, chiffrement du code.
- Côté site, `node --test` comme pour `tests/kdrive-relay.test.js`.
- Une vérification de non-régression du build : aucune photo `private` ne doit
  apparaître dans `dist/`, ni dans `sitemap.xml`, ni dans `rss.xml`, ni dans
  l'index de recherche.

## 11. Décisions prises

- Adresse des galeries : `prive.stan-bouchet.fr`.
- Stockage : kDrive, dossier `Privé/<galerie>`, original et trois versions.
- Format livré : JPEG.
- Version livrée : l'original, présent dès l'import dans les galeries privées.
  Pour une photo déjà publiée reversée dans une galerie privée, le maximum
  disponible reste le `zoom` 2500 px, les originaux historiques n'étant pas
  récupérables.

- Dossiers privés : aucune catégorie kDrive. L'étanchéité vient du site, pas du
  classement dans le drive, qui est privé de toute façon.
- Volume de référence : une centaine de photos par livraison.

## 13. Mise en production

Fait sur le VPS le 20 novembre 2026 : dossiers `/home/ubuntu/portfolio-prive`
et `admin-sites-astro/storage/galeries`, bloc Caddy `prive.stan-bouchet.fr`
(sauvegarde `Caddyfile.avant-galeries-privees.*`), clé de déploiement dédiée
dans `authorized_keys` avec l'option `restrict`, les quatre secrets du dépôt du
site, et `GALLERY_CODE_KEY` plus `NEXT_PUBLIC_GALLERY_BASE_URL` dans
`.env.production` (sauvegarde `.env.production.avant-galeries.*`). Les
variables ne prendront effet qu'au redémarrage du service.

Reste l'enregistrement DNS `prive` → `179.237.66.21` dans la zone
`stan-bouchet.eu` chez O2Switch : tant qu'il manque, Let's Encrypt refuse le
certificat et le domaine ne répond qu'en HTTP, par une redirection.

### Serveur d'administration (`.env.production`)

```sh
# Chiffre les codes d'accès. Sans elle, ils le sont avec SESSION_SECRET.
GALLERY_CODE_KEY=<32 caractères aléatoires ou plus>
# Cache des archives (valeurs par défaut rappelées ici).
GALLERY_ARCHIVE_PATH=./storage/galeries
GALLERY_ARCHIVE_MAX_BYTES=10737418240
# Adresse affichée dans l'administration pour les liens à partager.
NEXT_PUBLIC_GALLERY_BASE_URL=https://prive.stan-bouchet.fr
# Texte du filigrane (défaut : « © Stan Bouchet »).
GALLERY_WATERMARK_TEXT=© Stan Bouchet
# Destinataire des avis d'ouverture et de validation. Sans elle, le
# destinataire habituel de l'administration. Sans SMTP configuré, rien ne part
# et les galeries fonctionnent normalement.
GALLERY_NOTIFY_EMAIL=bouchet.stanislas@gmail.com
```

Le `docker-compose.yml` monte désormais `./storage/galeries` : créer le dossier
sur le VPS avant le premier démarrage.

### Caddy

Le service d'administration écoute sur `127.0.0.1:3004`. Le bloc à ajouter au
Caddyfile de production, en reprenant le port réel si celui-ci a changé :

```caddy
prive.stan-bouchet.fr {
    encode zstd gzip {
        match {
            header Content-Type text/*
            header Content-Type application/json*
        }
    }

    handle /api/galerie/* {
        reverse_proxy 127.0.0.1:3004
    }

    handle /prive/* {
        root * /home/ubuntu/portfolio-prive
        file_server
    }

    handle /robots.txt {
        respond "User-agent: *\nDisallow: /" 200
    }

    # Tout le reste appartient au site public : pas de contenu dupliqué.
    handle {
        redir https://stan-bouchet.eu{uri} permanent
    }
}
```

Le matcher sur `encode` évite de recompresser les archives et les images, déjà
compressées. Les téléchargements d'archives sont longs : ne pas ajouter de
`timeout` court sur ce bloc.

### Secrets GitHub du dépôt du site

| Secret | Valeur |
| --- | --- |
| `VPS_HOST` | adresse du VPS |
| `VPS_USER` | utilisateur SSH (`ubuntu`) |
| `VPS_PRIVE_PATH` | `/home/ubuntu/portfolio-prive` |
| `VPS_SSH_KEY` | clé privée de déploiement, sans phrase de passe |

L'étape de déploiement vers le VPS est ignorée tant que `VPS_HOST` est absent :
le site continue donc de se déployer normalement chez O2Switch avant que ces
secrets soient créés.

### Vérification après la première mise en ligne

1. Créer une galerie en brouillon, y mettre deux photos, relever le code.
2. Vérifier que le lien répond en demandant le code, et que le code refuse
   d'entrer tant que la galerie est en brouillon.
3. Ouvrir la galerie, entrer le code, vérifier l'affichage, le zoom, le
   téléchargement d'une photo puis de l'archive.
4. Vérifier qu'aucune photo privée n'apparaît sur `stan-bouchet.eu`, ni dans
   `/sitemap.xml`, ni dans la recherche.
5. Fermer la galerie et vérifier que le lien ne donne plus rien.
