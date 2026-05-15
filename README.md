# WhatsApp Campaign Server — 360dialog

Serveur Node.js unifié pour campagnes WhatsApp via 360dialog.

## Endpoints
- `POST /send` — Proxy vers 360dialog
- `POST /webhook` — Réception statuts WhatsApp
- `GET /statuts` — Statuts courants par numéro
- `GET /historique` — Historique complet horodaté
- `GET /health` — Health check

## Déploiement Railway
1. Fork ce repo sur GitHub
2. Connecte Railway à ce repo
3. Configure la variable `PORT` (Railway la set automatiquement)
