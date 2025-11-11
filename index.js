import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const downloadsFolder = join(__dirname, 'downloads');

// Créer le dossier downloads si n'existe pas
if (!fs.existsSync(downloadsFolder)) {
  fs.mkdirSync(downloadsFolder);
}

// Endpoint pour lancer le téléchargement
app.post('/download-audio', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL manquante' });
  }

  const downloadId = uuidv4();
  const outputPath = join(downloadsFolder, `${downloadId}.mp3`);

  // Lancer le téléchargement en arrière-plan
  exec(
    `yt-dlp -x --audio-format mp3 -o "${outputPath}" "${url}"`,
    (error, stdout, stderr) => {
      if (error) {
        console.error(`Erreur yt-dlp [${downloadId}]:`, error.message);
        return;
      }
      console.log(`Téléchargement terminé [${downloadId}] : ${outputPath}`);
    }
  );

  // Répondre immédiatement au client avec l'ID
  res.json({ downloadId, status: 'processing' });
});

// Endpoint pour récupérer le fichier si prêt
app.get('/download-audio/:id', (req, res) => {
  const { id } = req.params;
  const filePath = join(downloadsFolder, `${id}.mp3`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Fichier non disponible pour le moment' });
  }

  res.download(filePath, `${id}.mp3`, (err) => {
    if (err) console.error('Erreur en envoyant le fichier:', err);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
