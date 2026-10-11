# Stockage des photographies sur kDrive

Destination fournie : [Photographies - Galerie Photo](https://ksuite.infomaniak.com/628601/kdrive/app/drive/620855/files/426358)

- kDrive : `620855` ; dossier principal : `426358`.
- L’administration `/storage` permet de saisir le jeton API Infomaniak avec le droit `drive`, tester l’accès au dossier et enregistrer la connexion. Le jeton reste dans `.env` local, exclu de Git, avec des permissions privées.
- Les imports permettent de choisir O2Switch ou kDrive. Sur kDrive, l’original non signé et les versions miniature/web/zoom sont envoyés avant d’enregistrer la photo. La signature optionnelle concerne uniquement web/zoom.
- « Créer ou réutiliser un dossier » range les fichiers dans `Photographies - Galerie Photo/Nom de la série — AAAA-MM-JJ`. Date choisie, sinon date de la série, sinon date de prise de vue. Pour Instants : `Instants — AAAA-MM-JJ`. Décocher utilise directement le dossier principal.
- Les fichiers kDrive restent privés. Aucun lien de partage n’est créé automatiquement.

## Affichage public sans dépendre du Mac

Le site statique reste hébergé chez O2Switch. `public/media-kdrive.php` est un relais PHP 8.1+ avec cURL : il télécharge une version depuis kDrive et la renvoie au navigateur, sans conserver une copie sur disque. Les images sont donc stockées sur kDrive ; le serveur web existant assure leur diffusion. Le Mac n’intervient pas.

Créer sur l’hébergement, **en dehors du dossier public du site**, un fichier `kdrive-config.php` (droits 0600) :

```php
<?php
return [
    'token' => 'RENSEIGNER_LE_JETON_API_ICI',
    'drive_id' => '620855',
];
```

Par défaut, le relais le cherche dans le dossier parent de la racine du site. Si nécessaire, définir `KDRIVE_CONFIG_PATH` côté hébergement. Les variables serveur `KDRIVE_TOKEN` et `KDRIVE_ID` sont également acceptées. Ne jamais mettre ce fichier dans `public/`, `dist/` ou Git. Un jeton distinct avec lecture seule peut être utilisé pour le relais, si disponible pour le compte.

Le fichier `kdrive-media.json`, généré par Astro, autorise uniquement les versions miniature/web/zoom des photos publiées. Les brouillons, la corbeille et les originaux n’y figurent pas. L’administration affiche ses propres aperçus authentifiés, y compris les brouillons. Le relais ne permet pas de demander un identifiant de fichier arbitraire. Son cache navigateur est de cinq minutes ; une image déjà chargée peut rester visible pendant ce délai après dépublication.

Vérifier la configuration avec une première photo en brouillon, puis publiée : image réelle reçue avec `Content-Type: image/webp`, miniature et zoom visibles sans connexion Infomaniak. Une clé absente ou invalide renvoie une erreur, pas une page de connexion. Cette validation réelle nécessite les clés du compte et de l’hébergement.

## Migration de l’existant

```sh
node scripts/migrate-kdrive.js
node scripts/migrate-kdrive.js --apply --limit 1
npm run build
# Publier le premier essai et contrôler son affichage, puis :
node scripts/migrate-kdrive.js --apply
```

Par défaut, la commande simule sans accès réseau ni modification. `--flat` désactive les sous-dossiers. L’option `--limit` limite l’essai. Les photos déjà migrées sont ignorées.

La migration récupère les trois versions existantes et vérifie leur contenu après transfert par SHA-256. Les liens YAML changent uniquement après cette vérification ; les pages conservent leur slug, les couvertures explicitement choisies sont mises à jour. Le journal local dans `.processed/kdrive-migration/` permet de reprendre un transfert interrompu. Ne pas l’effacer pendant la migration et ne pas lancer deux migrations simultanément.

Les originaux historiques ne sont pas récupérables à partir des adresses WebP actuelles. Il faut les fournir séparément s’ils doivent aussi être archivés. Les prochains imports conservent leur original dans kDrive.

Aucune suppression d’images O2Switch n’est effectuée. La suppression d’une photo de la galerie retire son accès public au prochain déploiement ; les fichiers kDrive restent conservés en archive. La suppression de cette archive se gère séparément dans kDrive.

## Références

- [API REST officielle et exemples Infomaniak](https://github.com/Infomaniak/mcp-server-kdrive/blob/main/src/kdrive-client.ts)
- [Créer un jeton API avec le droit drive](https://github.com/Infomaniak/mcp-server-kdrive#setup)
