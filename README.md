# Audio-to-Text Gemini

Application web qui transcrit et analyse des enregistrements audio (micro ou fichier) avec Google Gemini :
résumé, plan de cours + quiz, compte-rendu de réunion, liste de tâches, transcription brute.
Les résultats sont modifiables, traduisibles et peuvent être envoyés en PDF par e-mail.

## Démarrage

Prérequis : Node.js 22 (version LTS, fixée dans package.json), une base MongoDB (MongoDB Atlas convient).

```bash
npm install
cp .env.example .env   # puis remplissez les valeurs
npm start              # ou : npm run dev (redémarre à chaque modification)
```

L'application est servie sur http://localhost:3000.

## Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `MONGO_URI` | oui | Connexion MongoDB (comptes, transcriptions et fichiers audio). |
| `GEMINI_API_KEY` | oui | Clé de l'API Google Gemini. |
| `JWT_SECRET` | oui en production | Secret de signature des sessions : au moins 32 caractères aléatoires (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`). Sans lui, le serveur refuse de démarrer quand `NODE_ENV=production`. |
| `NODE_ENV` | recommandé | Mettre `production` sur l'hébergeur. |
| `BREVO_API_KEY` | oui en production | Clé de l'API Brevo (e-mails de confirmation et envoi des PDF). En développement, sans Brevo, les liens de confirmation s'affichent dans la console. |
| `EMAIL_USER` | oui en production | Adresse d'expédition, validée dans Brevo. |
| `APP_URL` | non sur Render | Adresse publique du site, utilisée dans les liens des e-mails. Sur Render, `RENDER_EXTERNAL_URL` est fourni automatiquement. |
| `GEMINI_MODEL` | non | Modèle Gemini utilisé (par défaut `gemini-3.6-flash`). |
| `CORS_ORIGIN` | non | Origines autorisées à appeler l'API depuis un autre site, séparées par des virgules. Par défaut, aucune. |
| `TRUST_PROXY` | non | Nombre de proxys devant l'application (par défaut `1`, adapté à Render). |
| `PORT` | non | Port d'écoute (par défaut `3000`). |
| `QUOTA_JOUR_ANALYSES` | non | Analyses par jour pour tout le site (défaut `200`). |
| `QUOTA_JOUR_TRADUCTIONS` | non | Traductions par jour pour tout le site (défaut `300`). |
| `QUOTA_JOUR_EMAILS_PDF` | non | Destinataires de PDF par jour pour tout le site (défaut `150`). |
| `QUOTA_JOUR_EMAILS_COMPTE` | non | E-mails de confirmation par jour (défaut `100`). Avec le précédent : 250, sous la limite de 300/jour de l'offre gratuite de Brevo. |
| `QUOTA_STOCKAGE_UTILISATEUR_MO` | non | Espace audio par utilisateur, en Mo (défaut `100`). |
| `QUOTA_STOCKAGE_TOTAL_MO` | non | Espace audio pour tout le site, en Mo (défaut `400`, pour rester sous les 512 Mo d'Atlas gratuit). |

## Fonctionnement

- **Audio** : le fichier est reçu dans `uploads/` (dossier temporaire), envoyé à Gemini — directement s'il fait
  moins de 15 Mo, sinon via l'API Files de Gemini — puis stocké dans MongoDB (GridFS, collection `audios`).
  Il survit donc aux redéploiements. Il n'est accessible qu'à son propriétaire (`GET /audio/:id`, avec jeton).
  Taille maximale : 100 Mo. Attention à la capacité de votre offre MongoDB (512 Mo sur l'offre gratuite d'Atlas).
- **Confirmation de l'adresse e-mail** : à l'inscription, un lien (valable 24 h) est envoyé. Tant qu'il n'est pas
  cliqué, la connexion est refusée et l'écran de connexion propose de renvoyer l'e-mail. Les comptes créés avant
  cette fonctionnalité doivent aussi confirmer leur adresse une fois.
- **Plafonds globaux par jour** (pour tout le site, remis à zéro à minuit UTC) : ils protègent la facture Gemini et
  le compte Brevo même si quelqu'un crée de nombreux comptes. Une analyse ou un envoi qui échoue n'est pas décompté.
- **Quota de stockage** : quand l'espace d'un utilisateur (ou du site) est plein, la transcription est enregistrée
  mais pas l'audio, et un message l'indique. L'espace utilisé s'affiche sous l'adresse e-mail.
- **Limites par utilisateur et par heure** : 20 analyses, 30 traductions, 10 envois de PDF (5 destinataires maximum
  par envoi). Connexion et inscription : 10 tentatives par 15 minutes et par adresse IP.
- **Annulation** : si l'utilisateur annule, l'appel à Gemini est interrompu et rien n'est enregistré.

## Tests

```bash
npm test
```

## API

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/register` | Création de compte (`email`, `password` de 8 caractères minimum). |
| POST | `/api/login` | Connexion, renvoie un jeton valable 24 h (403 `EMAIL_NON_VERIFIE` si l'adresse n'est pas confirmée). |
| GET | `/api/verifier-email?jeton=…` | Lien reçu par e-mail ; redirige vers `/?verification=ok`, `expiree` ou `invalide`. |
| POST | `/api/renvoyer-verification` | `email` ; renvoie le lien (au plus une fois toutes les 2 minutes). |
| GET | `/api/moi` | E-mail et espace de stockage utilisé. |
| POST | `/transcrire` | Formulaire multipart : `audio`, `mode`, `titreSource`. |
| GET | `/historique?avant=<date ISO>` | 30 transcriptions par page, plus récentes d'abord. |
| PATCH | `/historique/:id` | Enregistre le texte modifié. |
| DELETE | `/historique/:id` | Supprime la transcription et son audio. |
| GET | `/audio/:id` | Fichier audio d'une transcription. |
| POST | `/traduire` | `texteOriginal`, `langueCible`. |
| POST | `/envoyer-pdf` | `emailDestinataire`, `texteAAfficher`, `titreSource`, `modePdf` (`classique`, `executif`, `academique`). |
