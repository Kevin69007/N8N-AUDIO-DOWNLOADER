# Image légère avec Node.js 18
FROM node:18-slim

# Installer yt-dlp et ffmpeg
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Créer le dossier de travail
WORKDIR /app

# Copier les fichiers nécessaires
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Configurer les variables d'environnement
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Lancer ton app
CMD ["npm", "start"]
