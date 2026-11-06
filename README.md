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
| `BREVO_API_KEY` | pour l'e-mail | Clé de l'API Brevo (envoi des PDF). |
| `EMAIL_USER` | pour l'e-mail | Adresse d'expédition, validée dans Brevo. |
| `GEMINI_MODEL` | non | Modèle Gemini utilisé (par défaut `gemini-3.6-flash`). |
| `CORS_ORIGIN` | non | Origines autorisées à appeler l'API depuis un autre site, séparées par des virgules. Par défaut, aucune. |
| `TRUST_PROXY` | non | Nombre de proxys devant l'application (par défaut `1`, adapté à Render). |
| `PORT` | non | Port d'écoute (par défaut `3000`). |

## Fonctionnement

- **Audio** : le fichier est reçu dans `uploads/` (dossier temporaire), envoyé à Gemini — directement s'il fait
  moins de 15 Mo, sinon via l'API Files de Gemini — puis stocké dans MongoDB (GridFS, collection `audios`).
  Il survit donc aux redéploiements. Il n'est accessible qu'à son propriétaire (`GET /audio/:id`, avec jeton).
  Taille maximale : 100 Mo. Attention à la capacité de votre offre MongoDB (512 Mo sur l'offre gratuite d'Atlas).
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
| POST | `/api/login` | Connexion, renvoie un jeton valable 24 h. |
| POST | `/transcrire` | Formulaire multipart : `audio`, `mode`, `titreSource`. |
| GET | `/historique?avant=<date ISO>` | 30 transcriptions par page, plus récentes d'abord. |
| PATCH | `/historique/:id` | Enregistre le texte modifié. |
| DELETE | `/historique/:id` | Supprime la transcription et son audio. |
| GET | `/audio/:id` | Fichier audio d'une transcription. |
| POST | `/traduire` | `texteOriginal`, `langueCible`. |
| POST | `/envoyer-pdf` | `emailDestinataire`, `texteAAfficher`, `titreSource`, `modePdf` (`classique`, `executif`, `academique`). |
